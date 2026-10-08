-- 20261008130000_campaign_events.sql
--
-- Campaign capture (D-0077): append-only funnel events for a marketing
-- campaign (e.g. the Leaf Peeper recap email) — "someone viewed the recap"
-- and "someone signed up after seeing it". No money code, no third-party
-- analytics, no public read. Writes flow ONLY through record_campaign_event()
-- (SECURITY DEFINER) or service_role; nothing else may insert/update/delete.
--
-- Raw rows: retain 13 months, then roll to monthly aggregates. The rollup
-- job itself is a separate piece of work, not part of this migration.

set search_path = public;

create table if not exists campaign_events (
  id uuid primary key default gen_random_uuid(),
  campaign text not null,
  kind text not null check (kind in ('recap_view', 'signup')),
  visitor_id text not null,
  tournament_id uuid references tournaments(id),
  player_id uuid references players(id),
  created_at timestamptz not null default now()
);

comment on table campaign_events is
  'Append-only campaign funnel capture (recap_view/signup). visitor_id is an anonymous first-party id, NOT a player id. Raw rows retained 13 months, then rolled to monthly aggregates (rollup job not yet built). Writes only via record_campaign_event() or service_role.';

create index if not exists campaign_events_campaign_kind_created_at_idx
  on campaign_events (campaign, kind, created_at);

create index if not exists campaign_events_campaign_visitor_id_idx
  on campaign_events (campaign, visitor_id);

alter table campaign_events enable row level security;

-- Read: org admins of the campaign event's tournament, plus service_role
-- (which bypasses RLS entirely). No policy grants anon or authenticated
-- a blanket read — a row with no tournament_id is visible to no one but
-- service_role.
drop policy if exists "campaign_events_select_org_admin" on campaign_events;
create policy "campaign_events_select_org_admin" on campaign_events
  for select
  using (
    tournament_id is not null
    and exists (
      select 1 from tournaments t
      where t.id = campaign_events.tournament_id
        and is_org_member(t.organization_id)
    )
  );

-- No insert/update/delete policy for anyone — all writes go through the
-- SECURITY DEFINER function below, or service_role (which bypasses RLS).
revoke all on campaign_events from anon, authenticated;
grant select on campaign_events to authenticated; -- RLS above still restricts to org members
-- anon gets nothing: no grant at all, so there is no public select.

-- Automated check, run on every apply (TEST on merge to main, PROD on
-- promotion): fails the migration if anon can ever select this table.
-- This is the "a test asserts the public role cannot select" acceptance
-- criterion — there is no staging DB to run a separate RLS test suite
-- against, so the assertion runs as part of the migration itself.
do $$
begin
  if has_table_privilege('anon', 'campaign_events', 'select') then
    raise exception 'campaign_events must not be selectable by anon';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- record_campaign_event — the one write path the public pages may call.
-- ─────────────────────────────────────────────────────────────────────

create or replace function record_campaign_event(
  p_campaign text,
  p_kind text,
  p_visitor_id text,
  p_tournament_slug text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_player_id uuid;
  v_recent_count int;
begin
  if p_kind not in ('recap_view', 'signup') then
    raise exception 'invalid campaign event kind: %', p_kind;
  end if;

  if p_tournament_slug is not null then
    select id into v_tournament_id
    from tournaments
    where slug = p_tournament_slug
      and deleted_at is null
    limit 1;
  end if;

  -- player_id is stamped server-side from the caller's own session, never
  -- from a client-supplied argument — the function signature has no
  -- player_id parameter at all.
  if p_kind = 'signup' then
    v_player_id := current_player_id();
  end if;

  if p_kind = 'recap_view' then
    -- Dedupe in the function, not the client: at most one recap_view row
    -- per (campaign, visitor_id) per hour, so a page refresh isn't a
    -- second view.
    select count(*) into v_recent_count
    from campaign_events
    where campaign = p_campaign
      and kind = 'recap_view'
      and visitor_id = p_visitor_id
      and created_at > now() - interval '1 hour';

    if v_recent_count > 0 then
      return;
    end if;
  end if;

  insert into campaign_events (campaign, kind, visitor_id, tournament_id, player_id)
  values (p_campaign, p_kind, p_visitor_id, v_tournament_id, v_player_id);
end;
$$;

comment on function record_campaign_event(text, text, text, text) is
  'Public write path for campaign funnel capture. Validates kind, dedupes recap_view by (campaign, visitor_id) per hour, and stamps player_id from auth.uid() on signup — never from an argument.';

revoke all on function record_campaign_event(text, text, text, text) from public;
grant execute on function record_campaign_event(text, text, text, text) to anon, authenticated;
