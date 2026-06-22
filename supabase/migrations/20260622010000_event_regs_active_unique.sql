-- 20260622010000_event_regs_active_unique.sql
--
-- "One ACTIVE registration per player per event."
--
-- The previous partial unique index excluded only soft-deleted rows
-- (`where deleted_at is null`). But withdraw_self() intentionally leaves the
-- row in place — flipping status to 'withdrawn' (paid) or 'cancelled'
-- (pending) WITHOUT setting deleted_at — so its slot stayed "taken" and a
-- player who withdrew then tried to register for that event again hit a
-- duplicate-key error. (Latent for the My Tournaments withdraw path; newly
-- reachable now that the register page's Unregister also routes through
-- withdraw_self instead of soft-deleting.)
--
-- Narrow the index to ACTIVE statuses so withdrawn / cancelled / refunded
-- regs no longer block a fresh registration. Two simultaneously-active regs
-- for the same player+event are still prevented.

set search_path = public;

drop index if exists event_registrations_event_id_player_id_active_uidx;

create unique index if not exists
  event_registrations_event_id_player_id_active_uidx
  on public.event_registrations (event_id, player_id)
  where deleted_at is null and status in ('pending_payment', 'paid');
