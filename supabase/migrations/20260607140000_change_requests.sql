-- 20260607140000_change_requests.sql
--
-- Player change-request queue (issue #36, scenario E5). A player files
-- a request the organizer must handle (division switch, partner change
-- after the partner already accepted, special-circumstance withdrawal)
-- instead of self-serving — so an admin gets the refund / bracket
-- consequences right.
--
-- DESIGN CALLS (proposed — confirm before applying):
--
--   kind enum (change_request_kind):
--     division_change   — move to a different event/division
--     partner_change     — swap partner after the partner accepted
--     withdrawal         — special-circumstance withdraw (refund call)
--     other              — free-text catch-all (payload.note)
--
--   status enum (change_request_status):
--     open       — awaiting organizer (default on insert)
--     approved   — organizer actioned it
--     denied     — organizer declined
--     cancelled  — player rescinded before resolution
--
--   payload jsonb — kind-specific details (target event id, desired
--     partner, reason text). Kept loose on purpose; the UI validates
--     shape per-kind. organizer_resolution holds the free-text reply.

set search_path = public;

create type change_request_kind as enum (
  'division_change',
  'partner_change',
  'withdrawal',
  'other'
);

create type change_request_status as enum (
  'open',
  'approved',
  'denied',
  'cancelled'
);

create table public.tournament_change_requests (
  id                   uuid primary key default gen_random_uuid(),
  tournament_id        uuid not null references public.tournaments(id) on delete cascade,
  player_id            uuid not null references public.players(id) on delete cascade,
  kind                 change_request_kind not null,
  payload              jsonb not null default '{}'::jsonb,
  status               change_request_status not null default 'open',
  organizer_resolution text,
  resolved_by          uuid references auth.users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  resolved_at          timestamptz
);

comment on table public.tournament_change_requests is
  'Player-filed change requests an organizer must resolve (division switch, post-accept partner change, special-circumstance withdrawal). One queue per tournament/org.';

create index change_requests_tournament_open_idx
  on public.tournament_change_requests (tournament_id)
  where status = 'open';

create index change_requests_player_idx
  on public.tournament_change_requests (player_id);

-- RLS ----------------------------------------------------------------
alter table public.tournament_change_requests enable row level security;

-- Read: the filing player sees their own; org staff of the tournament's
-- org see the whole queue.
create policy "change_requests read by player or org" on public.tournament_change_requests
  for select using (
    player_id = current_player_id()
    or exists (
      select 1 from public.tournaments t
      where t.id = tournament_change_requests.tournament_id
        and is_org_member(t.organization_id)
    )
  );

-- Insert: a player files for themselves (status defaults to 'open').
-- Org staff can also file on a player's behalf.
create policy "change_requests insert by player or org staff" on public.tournament_change_requests
  for insert to authenticated with check (
    player_id = current_player_id()
    or exists (
      select 1 from public.tournaments t
      where t.id = tournament_change_requests.tournament_id
        and has_org_role(t.organization_id, 'staff')
    )
  );

-- Update: org staff resolve (approve/deny/reply); the filing player may
-- update their own row only to cancel it. App-layer enforces the
-- cancel-only restriction for players; RLS gates the row, not the
-- column-level transition.
create policy "change_requests update by player or org staff" on public.tournament_change_requests
  for update using (
    player_id = current_player_id()
    or exists (
      select 1 from public.tournaments t
      where t.id = tournament_change_requests.tournament_id
        and has_org_role(t.organization_id, 'staff')
    )
  ) with check (
    player_id = current_player_id()
    or exists (
      select 1 from public.tournaments t
      where t.id = tournament_change_requests.tournament_id
        and has_org_role(t.organization_id, 'staff')
    )
  );
