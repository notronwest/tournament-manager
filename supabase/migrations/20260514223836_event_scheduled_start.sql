-- 20260514223836_event_scheduled_start.sql
--
-- Per-event scheduled start time. Powers the daily-schedule view —
-- once set, every event has a concrete "this event starts at X" that
-- the schedule page can read back, the homepage event cards can
-- display, and (eventually) a public-facing tournament schedule can
-- render.
--
-- Nullable: events without a scheduled time render as "—" on the
-- schedule. The Schedule page's "Auto-schedule" button populates this
-- column for every event using the existing duration estimator.

set search_path = public;

alter table events
  add column scheduled_start_at timestamptz;

create index events_scheduled_start_idx
  on events (scheduled_start_at)
  where scheduled_start_at is not null and deleted_at is null;
