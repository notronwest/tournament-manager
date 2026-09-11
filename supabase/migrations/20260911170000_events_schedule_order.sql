-- 20260911170000_events_schedule_order.sql
--
-- Organizers need to set the ORDER events run in (Schedule page → Move up /
-- Move down). Until now the schedule walked events by creation time with no
-- way to change it. Additive: one nullable integer, backfilled per tournament
-- from created_at so existing tournaments keep the order they see today.
-- Callers sort by (schedule_order nulls last, created_at).

set search_path = public;

alter table events
  add column if not exists schedule_order integer;

comment on column events.schedule_order is
  'Organizer-chosen run order within the tournament (1 = first). Drives the Schedule '
  'page row order and Auto-schedule. Null → falls back to created_at.';

with ranked as (
  select id,
         row_number() over (partition by tournament_id order by created_at, id) as rn
    from events
   where schedule_order is null
)
update events e
   set schedule_order = ranked.rn
  from ranked
 where ranked.id = e.id;

create index if not exists idx_events_schedule_order
  on events (tournament_id, schedule_order);
