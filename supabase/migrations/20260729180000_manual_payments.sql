-- ─────────────────────────────────────────────────────────────────────
-- manual_payments — record of non-Stripe payments for admin-registered
-- contacts: a comped ($0 waived) or offline-collected (cash/check/venmo/
-- other) registration into an event.
--
-- Created when an org admin registers a contact for an event without going
-- through Stripe checkout. Each row is tied to one event_registration.
--
-- Mirrors the repo's "payments are server-write-only" rule (locked decision
-- + Stripe payments pattern): org members can READ, but there is NO
-- insert/update/delete policy — all writes go through the
-- admin-register-contact edge function using the service_role key (which
-- bypasses RLS). This prevents a malicious client from forging a "paid" row.
-- ─────────────────────────────────────────────────────────────────────

create type manual_payment_kind   as enum ('comp', 'offline');
create type manual_payment_method as enum ('cash', 'check', 'venmo', 'other');

create table manual_payments (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references organizations(id) on delete cascade,
  event_registration_id uuid not null references event_registrations(id) on delete cascade,
  player_id             uuid not null references players(id) on delete cascade,
  kind                  manual_payment_kind not null,
  amount_cents          integer not null default 0 check (amount_cents >= 0),
  method                manual_payment_method,        -- null for comp
  note                  text,
  recorded_by           uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now()
);

create index manual_payments_org_idx       on manual_payments (organization_id);
create index manual_payments_event_reg_idx on manual_payments (event_registration_id);

-- ─────────────────────────────────────────────────────────────────────
-- RLS — org members can read; writes are server-only via service_role.
-- ─────────────────────────────────────────────────────────────────────
alter table manual_payments enable row level security;

create policy "manual_payments read by org members" on manual_payments
  for select using (is_org_member(organization_id));
-- No insert/update/delete policy: server-only writes via service_role.
