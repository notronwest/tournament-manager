-- 20260618170000_donations.sql
--
-- Charity donations P1 (issue #377). Standalone, anonymous donations from
-- the public tournament page — no registration, no account. P2 (#378)
-- reuses this table to add an at-checkout donation (hence the nullable
-- payment_id link reserved below).
--
-- Money model (locked with Ron 2026-06-18):
--   * 100% to the organizer's connected account — the edge function creates
--     a Stripe Connect *destination charge* with NO application_fee. Stripe's
--     processing fee still applies; the platform takes nothing.
--   * Per-tournament opt-in via tournaments.accepts_donations (default off).
--
-- Security model (mirrors `payments`):
--   * Server-only writes. NO INSERT/UPDATE policy — every write goes through
--     the create-donation-intent edge function + stripe-webhook using the
--     service_role key (which bypasses RLS). The client never INSERTs.
--   * SELECT is org-member only. Donor PII (name/email/message) is NEVER
--     publicly readable.

set search_path = public;

-- ── Tournament opt-in ────────────────────────────────────────────────
alter table public.tournaments
  add column if not exists accepts_donations boolean not null default false;

alter table public.tournaments
  add column if not exists donation_prompt text;

comment on column public.tournaments.accepts_donations is
  'Per-tournament opt-in for public charity donations (issue #377). Gated in the UI on the org having an active Stripe Connect account.';
comment on column public.tournaments.donation_prompt is
  'Optional organizer-supplied prompt shown by the public Donate CTA, e.g. "Proceeds benefit the First Responders Fund".';

-- ── donations ────────────────────────────────────────────────────────
create table if not exists public.donations (
  id                           uuid primary key default gen_random_uuid(),
  organization_id              uuid not null references public.organizations(id) on delete restrict,
  tournament_id                uuid not null references public.tournaments(id) on delete restrict,
  -- Reserved for P2 (#378): an at-checkout donation rides along with a
  -- registration payment. Null for standalone P1 donations.
  payment_id                   uuid references public.payments(id) on delete set null,
  stripe_payment_intent_id     text unique,
  stripe_charge_id             text,
  stripe_connected_account_id  text,
  donor_name                   text not null,
  donor_email                  text not null,
  amount_cents                 integer not null,
  message                      text,
  status                       payment_status not null default 'pending',
  failure_message              text,
  raw                          jsonb,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  constraint donations_amount_positive check (amount_cents > 0)
);

comment on table public.donations is
  'Charity donations (issue #377). Written ONLY by edge functions via service_role (no client INSERT/UPDATE policy), mirroring payments. SELECT is org-member only — donor PII is never publicly readable.';

create index if not exists donations_org_status_idx
  on public.donations (organization_id, status);
create index if not exists donations_tournament_idx
  on public.donations (tournament_id);

create trigger donations_updated_at before update on public.donations
  for each row execute function public.set_updated_at();

-- RLS ----------------------------------------------------------------
alter table public.donations enable row level security;

-- Org members of the tournament's org read their donations (for the
-- organizer report). No public SELECT — donor name/email/message must not
-- be readable by anyone outside the org.
create policy "donations read by org" on public.donations
  for select using (
    is_org_member(organization_id)
  );

-- INSERT/UPDATE intentionally have NO policy — all writes go through the
-- create-donation-intent edge function + stripe-webhook using the
-- service_role key (which bypasses RLS), exactly like `payments`.
