-- 20260504150215_event_status_and_courts.sql
-- Phase 1 of multi-event support.
--
--  * Adds events.status (draft/active/completed). Existing events with
--    any matches generated get backfilled to 'active' so an in-flight
--    tournament doesn't silently lose its in-progress events.
--  * Adds tournaments.court_count — the number of courts available at
--    the venue.
--  * Adds event_courts — links a court (number) to the event running
--    on it. The "no two active events share a court" rule is enforced
--    in the UI; multiple drafts can pre-claim the same number, and a
--    completed event can keep its historical assignment.

set search_path = public;

-- ─────────────────────────────────────────────────────────────────────
-- events.status
-- ─────────────────────────────────────────────────────────────────────

create type event_status as enum ('draft', 'active', 'completed');

alter table events
  add column status event_status not null default 'draft';

-- Backfill: any event that already has matches is mid-tournament.
update events
   set status = 'active'
 where exists (select 1 from matches m where m.event_id = events.id);

-- ─────────────────────────────────────────────────────────────────────
-- tournaments.court_count
-- ─────────────────────────────────────────────────────────────────────

alter table tournaments
  add column court_count smallint not null default 4;

alter table tournaments
  add constraint tournaments_court_count_range
  check (court_count > 0 and court_count <= 32);

-- ─────────────────────────────────────────────────────────────────────
-- event_courts
-- ─────────────────────────────────────────────────────────────────────

create table event_courts (
  event_id      uuid     not null references events(id) on delete cascade,
  court_number  smallint not null check (court_number > 0),
  created_at    timestamptz not null default now(),
  primary key (event_id, court_number)
);
create index event_courts_event_idx  on event_courts (event_id);
create index event_courts_number_idx on event_courts (court_number);

alter table event_courts enable row level security;

-- Reads visible to anyone who can see the parent event (mirrors the
-- events read policy — published tournaments + org members for drafts).
create policy "event_courts read by parent visibility" on event_courts
  for select using (
    exists (
      select 1 from events e
      join tournaments t on t.id = e.tournament_id
      where e.id = event_courts.event_id
        and e.deleted_at is null
        and t.deleted_at is null
        and (t.status in ('published', 'closed', 'completed') or is_org_member(t.organization_id))
    )
  );

create policy "event_courts write by org admins" on event_courts
  for all using (
    exists (
      select 1 from events e
      join tournaments t on t.id = e.tournament_id
      where e.id = event_courts.event_id and has_org_role(t.organization_id, 'admin')
    )
  ) with check (
    exists (
      select 1 from events e
      join tournaments t on t.id = e.tournament_id
      where e.id = event_courts.event_id and has_org_role(t.organization_id, 'admin')
    )
  );
