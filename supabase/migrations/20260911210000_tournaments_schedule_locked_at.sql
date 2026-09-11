-- 20260911210000_tournaments_schedule_locked_at.sql
--
-- Organizers lock a finished schedule so nobody nudges start times, order or
-- courts on game day. Null = unlocked. The Schedule page disables its edits
-- while set and offers Unlock. Additive; nothing existing changes.

set search_path = public;

alter table tournaments
  add column if not exists schedule_locked_at timestamptz;

comment on column tournaments.schedule_locked_at is
  'When the organizer locked the schedule (Schedule page). Null = unlocked. '
  'While set, the Schedule page blocks start-time / order / court / setup edits.';
