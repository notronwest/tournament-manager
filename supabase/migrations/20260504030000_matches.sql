-- 20260504000001_matches.sql
-- Adds the matches table — one row per scheduled or played match within an event.
--
-- Design:
--   * One match references TWO event_registrations (team_a_reg_id /
--     team_b_reg_id). For doubles each side's partner is reachable via
--     event_registrations.partner_registration_id.
--   * `stage` distinguishes round-robin from playoff bracket.
--   * `round` is an integer (RR round number, or playoff round 1=quarters,
--     2=semis, 3=final). With "no round balancing" the RR generator can
--     just set round = match index.
--   * `position` orders matches within a round (court / sequence).
--   * Sides may be NULL temporarily — playoff slots are populated as
--     winners advance from prior rounds.
--   * Scores are nullable until entered; status drives "completed" vs
--     "pending"; winner_reg_id is set explicitly when score is recorded
--     so we don't have to recompute every time we read.

set search_path = public;

-- ─────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────

create type match_stage  as enum ('round_robin', 'playoff');
create type match_status as enum ('pending', 'in_progress', 'completed');

-- ─────────────────────────────────────────────────────────────────────
-- matches
-- ─────────────────────────────────────────────────────────────────────

create table matches (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references events(id) on delete cascade,
  stage           match_stage not null,
  round           smallint not null,
  position        smallint not null default 0,
  team_a_reg_id   uuid references event_registrations(id) on delete set null,
  team_b_reg_id   uuid references event_registrations(id) on delete set null,
  team_a_score    smallint,
  team_b_score    smallint,
  winner_reg_id   uuid references event_registrations(id) on delete set null,
  status          match_status not null default 'pending',
  court           text,
  scheduled_at    timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (team_a_reg_id is null or team_b_reg_id is null or team_a_reg_id <> team_b_reg_id),
  check (
    winner_reg_id is null
    or winner_reg_id = team_a_reg_id
    or winner_reg_id = team_b_reg_id
  )
);

create index matches_event_idx       on matches (event_id, stage, round, position);
create index matches_team_a_idx      on matches (team_a_reg_id);
create index matches_team_b_idx      on matches (team_b_reg_id);

create trigger matches_updated_at before update on matches
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────

alter table matches enable row level security;

-- Public can see matches whose parent event is visible (mirrors the
-- events read policy: published/closed/completed tournaments + org
-- members for drafts).
create policy "matches read by parent visibility" on matches
  for select using (
    exists (
      select 1 from events e
      join tournaments t on t.id = e.tournament_id
      where e.id = matches.event_id
        and e.deleted_at is null
        and t.deleted_at is null
        and (t.status in ('published', 'closed', 'completed') or is_org_member(t.organization_id))
    )
  );

create policy "matches write by org admins" on matches
  for all using (
    exists (
      select 1 from events e
      join tournaments t on t.id = e.tournament_id
      where e.id = matches.event_id and has_org_role(t.organization_id, 'admin')
    )
  ) with check (
    exists (
      select 1 from events e
      join tournaments t on t.id = e.tournament_id
      where e.id = matches.event_id and has_org_role(t.organization_id, 'admin')
    )
  );
