-- 20260914220000_event_registrations_checked_in_at.sql
--
-- Day-of player CHECK-IN. Requested live during the 2026-09-12 Pickleball
-- Angels tournament — until now there was nothing check-in-related in the
-- schema (the front desk ran off a printed paper roster).
--
-- Check-in is a PLAYER action, not a per-event one: a player walks up to the
-- desk once and is marked present for EVERY event they're registered in that
-- tournament (23 of 73 players here were in more than one event). We model it
-- as the simplest thing that supports that and the "block Start until everyone
-- is checked in" gate: a nullable timestamp on each spot-holding registration.
--
--   NULL           not yet checked in
--   <timestamptz>  when the desk checked this player in
--
-- The check-in action stamps the SAME now() on all of that player's
-- spot-holding event_registrations in the tournament; undo nulls them all.
-- One timestamp per registration = one check-in per player per tournament(-day)
-- — these events are single-day, so that's the whole model; per-day check-in
-- for a future multi-day tournament would build on this, not replace it.
--
-- RLS: none added. event_registrations already carries
--   "event_regs update by player or org staff"  (init_schema)
-- so org staff (the front desk) can already write this column, and the
-- org-member select policy already lets the check-in screen and the Start gate
-- read it. Additive, nullable — existing behaviour is unchanged.

set search_path = public;

alter table event_registrations
  add column if not exists checked_in_at timestamptz;

comment on column event_registrations.checked_in_at is
  'Day-of check-in. Set to now() on every spot-holding registration a player '
  'has in the tournament when the front desk checks them in (one player action '
  'covers all their events); null = not checked in. Read by the check-in screen '
  'and by the "everyone checked in" gate on Generate matches / Start event.';

-- The gate and the check-in roster both scan a tournament's registrations by
-- event; this keeps the "who is / isn''t checked in for this event" lookup off
-- a sequential scan as rosters grow.
create index if not exists idx_event_registrations_event_checked_in
  on event_registrations (event_id, checked_in_at);
