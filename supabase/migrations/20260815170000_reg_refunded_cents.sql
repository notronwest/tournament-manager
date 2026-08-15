-- ─────────────────────────────────────────────────────────────────────
-- Track how much has already been refunded on a registration.
--
-- Until now a refund was all-or-nothing signalled purely by status
-- (paid → refunded/withdrawn). The organizer-initiated refund (issue a
-- refund without a withdrawal request) adds a "refund but KEEP the player
-- registered" case + partial amounts, so we need to remember the running
-- total refunded to (a) cap the next refund correctly and (b) avoid a later
-- withdrawal re-refunding money Stripe would then reject.
--
-- refunded_cents is the cumulative cents refunded for this event
-- registration (event-fee scope, matching refund_compute). 0 = nothing
-- refunded yet (every existing row). Writes happen only in the stripe-refund
-- edge function (service_role), right after each successful Stripe refund.
-- ─────────────────────────────────────────────────────────────────────

set search_path = public;

alter table public.event_registrations
  add column if not exists refunded_cents integer not null default 0
    check (refunded_cents >= 0);

comment on column public.event_registrations.refunded_cents is
  'Cumulative cents refunded for this registration (event-fee scope). Written '
  'only by the stripe-refund edge function after each successful Stripe refund; '
  'caps the next refund and keeps a KEEP-registered partial refund consistent '
  'with a later withdrawal. 0 = nothing refunded yet.';
