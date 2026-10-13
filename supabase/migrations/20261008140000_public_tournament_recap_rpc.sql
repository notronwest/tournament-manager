-- 20261008140000_public_tournament_recap_rpc.sql
--
-- Public RECAP page (#1101, D-0077 §1): a curated, read-only payload for a
-- COMPLETED tournament, modelled line-for-line on public_tournament_results
-- (20261001130000) — same SECURITY DEFINER discipline, same no-money/no-contact
-- curation — but gated narrower (status = 'completed' only, not
-- published/closed/completed) and shaped for buildTournamentSummary() /
-- TournamentSummaryReport.tsx rather than the live standings view: it adds the
-- tournament/org/venue header fields the summary masthead needs, and includes
-- matches.updated_at (which the results RPC omits) because the summary's
-- day-by-day and "last result" figures bucket finishes by it.
--
-- No publish toggle (D-0077 §1) — any tournament that reaches 'completed'
-- is recap-public by that status change alone.

set search_path = public;

create or replace function public_tournament_recap(
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
    select tr.id, tr.name, tr.slug, tr.starts_at, tr.ends_at, tr.status,
           o.name as org_name,
           coalesce(loc.name, tr.location_name) as venue_name,
           coalesce(
             nullif(concat_ws(', ',
               loc.address,
               loc.address_line2,
               nullif(concat_ws(', ', loc.city,
                 nullif(concat_ws(' ', loc.state, loc.postal_code), '')
               ), '')
             ), ''),
             tr.location_address
           ) as venue_address
    from tournaments tr
    join organizations o on o.id = tr.organization_id
    left join locations loc on loc.id = tr.location_id
    where o.slug = p_org_slug
      and tr.slug = p_tournament_slug
      and tr.deleted_at is null
      and tr.status = 'completed'
    limit 1
  ),
  ev as (
    select e.*
    from events e
    join t on t.id = e.tournament_id
    where e.deleted_at is null
  ),
  regs as (
    -- Same spot-holding roster the admin console (and public results) build
    -- teams from.
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
           m.winner_reg_id, m.status, m.court, m.label, m.updated_at
    from matches m
    join ev on ev.id = m.event_id
  )
  select case
    when not exists (select 1 from t) then null
    else jsonb_build_object(
      'tournament', (
        select jsonb_build_object(
          'name', name, 'slug', slug,
          'starts_at', starts_at, 'ends_at', ends_at, 'status', status,
          'org_name', org_name, 'venue_name', venue_name, 'venue_address', venue_address
        ) from t
      ),
      'events', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'name', name, 'format', format, 'gender', gender,
          'bracket_type', bracket_type, 'status', status, 'pool_count', pool_count,
          'teams_advancing_to_playoff', teams_advancing_to_playoff,
          'playoff_rounds', playoff_rounds, 'min_rating', min_rating, 'max_rating', max_rating,
          'min_age', min_age, 'max_age', max_age,
          'scheduled_start_at', scheduled_start_at, 'schedule_order', schedule_order
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
          'court', court, 'label', label, 'updated_at', updated_at
        ))
        from mt
      ), '[]'::jsonb)
    )
  end;
$$;

comment on function public_tournament_recap(text, text) is
  'Read-only, curated end-of-tournament recap payload (standings/scores/medals/headline figures) for a COMPLETED tournament only. No fees/refunds/withdrawal/payout/contact fields. Powers the public Tournament Recap page.';

grant execute on function public_tournament_recap(text, text) to anon, authenticated;
