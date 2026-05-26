-- 20260526160000_event_regs_partial_unique.sql
--
-- Bug fix: a player who cancels a pending_payment registration and
-- then tries to re-register for the same event hits a duplicate-
-- key error. The existing `unique (event_id, player_id)` constraint
-- counts SOFT-DELETED rows toward uniqueness, so the cancel
-- (deleted_at = now()) leaves the row in place but the slot
-- remains "taken" from the constraint's perspective.
--
-- The intent has always been "one ACTIVE registration per player
-- per event." Convert the constraint to a partial unique index that
-- excludes soft-deleted rows — consistent with how the SELECT
-- policy + every other query in the codebase treats deleted_at.
-- Same protection against double-registration; just stops counting
-- ghosts.

set search_path = public;

alter table public.event_registrations
  drop constraint if exists event_registrations_event_id_player_id_key;

create unique index if not exists
  event_registrations_event_id_player_id_active_uidx
  on public.event_registrations (event_id, player_id)
  where deleted_at is null;
