-- 20261001120000_events_scheduled_pinned.sql
--
-- Multi-day scheduling: distinguish a start time the organizer set BY HAND (a
-- day anchor) from one the auto-scheduler computed. Without this, auto-schedule
-- treated every event that merely had a start as "fixed" and could neither
-- re-flow a bad layout nor know which starts define the days — so a two-day
-- tournament collapsed onto one day (see tm#1037/#1038 follow-up).
--
-- A PINNED event is held at its start; auto-schedule re-flows every un-pinned
-- event around the pins, flooring each day to the pin that opens it. Additive:
-- one boolean, default false, so every existing event is re-flowable until the
-- organizer pins their anchors. Typing a start on the Schedule page pins it.

set search_path = public;

alter table events
  add column if not exists scheduled_pinned boolean not null default false;

comment on column events.scheduled_pinned is
  'True when the organizer hand-set this event''s start as a day anchor. Auto-schedule holds a pinned event in place and re-flows un-pinned events around it.';
