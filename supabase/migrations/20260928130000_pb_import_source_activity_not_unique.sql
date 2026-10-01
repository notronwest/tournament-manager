-- Fix: PB.com ActivityID is the DIVISION/event id — it is shared by every
-- registrant in a division (the real export has 13 distinct ActivityIDs across
-- 146 registrations), NOT a per-registration id. The prior unique index
-- (event_registrations_source_activity_uniq, added in
-- 20260928120000_pbcom_import_source_tracking.sql on the wrong premise
-- "ActivityID is globally unique in PB.com") rejected every 2nd+ registration in
-- a division, collapsing each division to a single entry. Drop it.
drop index if exists public.event_registrations_source_activity_uniq;

-- The correct uniqueness is one registration per (event, player) — this matches
-- the import's app-level dedup and makes re-import idempotent at the DB level.
create unique index if not exists event_registrations_event_player_uniq
  on public.event_registrations (event_id, player_id)
  where deleted_at is null;

comment on column public.event_registrations.source_activity_id is
  'PB.com ActivityID = the source DIVISION/event id (shared by all registrants in that division), kept for the results-push mapping. NOT unique per registration.';
