-- 20261001130000_public_tournament_results_rpc.sql
--
-- Public LIVE RESULTS page: anyone can watch any bracket's current progress
-- (standings, scores, medals) without logging in. The page can't read
-- event_registrations directly — that table carries fees/refunds/withdrawal
-- fields and its RLS is player-or-org only — so this SECURITY DEFINER function
-- returns a CURATED, read-only payload with ONLY the fields the public view
-- needs: no money, no contact info, just names, pools, seeds and scores.
--
-- Gated to PUBLIC tournaments (status published/closed/completed), exactly like
-- the register / start-times pages — a draft tournament returns null. The
-- client reuses buildTeams + computeStandings + computeMedals on this payload,
-- so public results match the admin console's standings exactly (D-0049).

set search_path = public;

create or replace function public_tournament_results(
  p_org_slug text,
  p_tournament_slug text
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with t as (
    select tr.id, tr.name, tr.slug, tr.starts_at, tr.ends_at, tr.status
    from tournaments tr
    join organizations o on o.id = tr.organization_id
    where o.slug = p_org_slug
      and tr.slug = p_tournament_slug
      and tr.deleted_at is null
      and tr.status in ('published', 'closed', 'completed')
    limit 1
  ),
  ev as (
    select e.*
    from events e
    join t on t.id = e.tournament_id
    where e.deleted_at is null
  ),
  regs as (
    -- Spot-holding registrations only — the same roster the console builds
    -- teams from (pending_payment / paid / waitlisted_pending_payment).
    select r.id, r.event_id, r.player_id, r.partner_registration_id,
           r.pool_index, r.seed, r.registered_at, r.status
    from event_registrations r
    join ev on ev.id = r.event_id
    where r.deleted_at is null
      and r.status in ('pending_payment', 'paid', 'waitlisted_pending_payment')
  ),
  pl as (
    select distinct p.id, p.first_name, p.last_name
    from players p
    where p.deleted_at is null
      and p.id in (select player_id from regs)
  ),
  mt as (
    select m.id, m.event_id, m.stage, m.round, m.position, m.bracket, m.if_necessary,
           m.team_a_reg_id, m.team_b_reg_id, m.team_a_score, m.team_b_score,
           m.winner_reg_id, m.status, m.court, m.label
    from matches m
    join ev on ev.id = m.event_id
  )
  select case
    when not exists (select 1 from t) then null
    else jsonb_build_object(
      'tournament', (
        select jsonb_build_object(
          'name', name, 'slug', slug,
          'starts_at', starts_at, 'ends_at', ends_at, 'status', status
        ) from t
      ),
      'events', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'name', name, 'format', format, 'gender', gender,
          'bracket_type', bracket_type, 'pool_count', pool_count,
          'teams_advancing_to_playoff', teams_advancing_to_playoff,
          'playoff_rounds', playoff_rounds, 'double_elim_final', double_elim_final,
          'status', status, 'scheduled_start_at', scheduled_start_at,
          'schedule_order', schedule_order
        ) order by schedule_order nulls last, created_at)
        from ev
      ), '[]'::jsonb),
      'registrations', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'event_id', event_id, 'player_id', player_id,
          'partner_registration_id', partner_registration_id,
          'pool_index', pool_index, 'seed', seed,
          'registered_at', registered_at, 'status', status
        ))
        from regs
      ), '[]'::jsonb),
      'players', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'first_name', first_name, 'last_name', last_name
        ))
        from pl
      ), '[]'::jsonb),
      'matches', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'event_id', event_id, 'stage', stage, 'round', round,
          'position', position, 'bracket', bracket, 'if_necessary', if_necessary,
          'team_a_reg_id', team_a_reg_id, 'team_b_reg_id', team_b_reg_id,
          'team_a_score', team_a_score, 'team_b_score', team_b_score,
          'winner_reg_id', winner_reg_id, 'status', status,
          'court', court, 'label', label
        ))
        from mt
      ), '[]'::jsonb)
    )
  end;
$$;

comment on function public_tournament_results(text, text) is
  'Read-only, curated results payload (standings/scores/medals) for a PUBLIC tournament. No fees/contact fields. Powers the public Live Results page.';

grant execute on function public_tournament_results(text, text) to anon, authenticated;
