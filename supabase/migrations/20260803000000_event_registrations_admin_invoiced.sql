-- 20260803000000_event_registrations_admin_invoiced.sql
--
-- Admin "register but leave a balance" (invoice) support.
--
-- An admin can register a player for an event and leave it UNPAID
-- (status='pending_payment') so the player logs in and pays online themselves.
-- That balance is an ordinary pending_payment event_registrations row — which
-- the scheduled `sweep-stale-pending-regs` job would delete after ~30 minutes.
--
-- This column marks a registration as an admin-created invoice so the sweep
-- skips it: an admin invoice is intentional and persists until the player pays
-- (or it is withdrawn), unlike an abandoned self-checkout hold.
--
-- Nullable; NULL = a normal registration (unchanged behavior). Additive only.

alter table event_registrations
  add column if not exists admin_invoiced_at timestamptz;

comment on column event_registrations.admin_invoiced_at is
  'When set, this pending_payment row is an admin-created invoice (player pays '
  'online themselves) and is EXCLUDED from sweep-stale-pending-regs.';
