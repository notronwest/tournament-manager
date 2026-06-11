-- 20260611130000_withdrawal_request_columns.sql
--
-- Withdrawal-request columns on event_registrations for the organizer
-- late-withdrawal approval queue (#200, surface (b) of epic #22). See
-- docs/REFUNDS.md.
--
-- When surface (a) (#199) can't auto-decide a refund (policy →
-- manual_required), the player files a withdrawal *request* instead of
-- getting an instant refund. The organizer later approves (with a chosen
-- refund amount) or denies. These columns record both halves:
--
--   withdrawal_requested_at  — when the player filed the request (no status
--                              change yet; the reg stays 'paid').
--   withdrawal_reason        — optional free-text reason from the player.
--   withdrawal_decided_at    — when the organizer resolved it.
--   withdrawal_decision      — 'approved' | 'denied'. On approve, the
--                              stripe-refund [FN] (manual mode) issues the
--                              chosen refund and flips status to 'refunded'
--                              (or 'withdrawn' if $0); on deny, status →
--                              'withdrawn' with no refund. (Status itself
--                              stays in registration_status, unchanged here.)
--
-- Purely additive: four nullable columns + one enum + a partial index for the
-- pending-queue lookup. Idempotent (re-run safe).

set search_path = public;

-- Organizer's resolution of a withdrawal request.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'withdrawal_decision') then
    create type withdrawal_decision as enum ('approved', 'denied');
  end if;
end $$;

alter table public.event_registrations
  add column if not exists withdrawal_requested_at timestamptz,
  add column if not exists withdrawal_reason        text,
  add column if not exists withdrawal_decided_at    timestamptz,
  add column if not exists withdrawal_decision      withdrawal_decision;

-- Pending-withdrawals queue lookup (AC #2): open requests = requested, not yet
-- decided. Partial index keeps it cheap as registrations grow.
create index if not exists event_registrations_pending_withdrawal_idx
  on public.event_registrations (event_id)
  where withdrawal_requested_at is not null
    and withdrawal_decided_at is null
    and deleted_at is null;
