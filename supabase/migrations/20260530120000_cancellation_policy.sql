-- 20260530120000_cancellation_policy.sql
--
-- Tournament cancellation policy — preset choice surfaced in the
-- wizard's Step 4. The preset is enough to (a) display a clear refund
-- summary to players before they pay and (b) drive the actual refund
-- math when someone withdraws.
--
-- Presets (windows are days BEFORE the tournament's starts_at):
--   generous → full refund > 7d before, none within 7d.
--   standard → full refund within 7d of registering, half > 30d before,
--              none within 7d. (The default for a new wizard run.)
--   strict   → no refunds after registration.
--   custom   → organizer-defined windows (UI lands in a follow-up
--              slice — included in the enum now so the column type
--              is stable).
--
-- NULL preset = "not yet chosen." Both the wizard (organizer skipped)
-- and the public page (falls back to "Contact the organizer for the
-- refund policy") have to handle that case.

set search_path = public;

create type cancellation_policy_preset as enum (
  'generous',
  'standard',
  'strict',
  'custom'
);

alter table public.tournaments
  add column cancellation_policy_preset cancellation_policy_preset;

comment on column public.tournaments.cancellation_policy_preset is
  'Which refund policy this tournament uses. Drives the public-page summary and the withdraw-refund math. NULL = organizer hasn''t chosen yet.';
