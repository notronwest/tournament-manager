-- 20260514225351_inter_event_buffer.sql
--
-- Buffer time between consecutive events on the same court — for
-- announcements, court turnover, players swapping in/out, ball
-- changes, etc. The schedule auto-builder adds this between events
-- in a court cluster (not before the first event, not within a
-- single event's pool play).
--
-- Stored on the tournament because it's a venue-/style-level
-- decision; each tournament tends to have one rhythm. Default 0 so
-- existing tournaments keep their current behavior.

set search_path = public;

alter table tournaments
  add column inter_event_buffer_minutes smallint not null default 0;

alter table tournaments
  add constraint tournaments_inter_event_buffer_range
    check (inter_event_buffer_minutes >= 0 and inter_event_buffer_minutes <= 240);
