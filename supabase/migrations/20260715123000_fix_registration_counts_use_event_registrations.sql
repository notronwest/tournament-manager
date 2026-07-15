-- 20260715123000_fix_registration_counts_use_event_registrations.sql
--
-- FIX for tournament_registration_counts (20260715000000): it counted the
-- tournament-level `registrations` table, which the app never writes —
-- registration happens per event via `event_registrations`. So v1 counted an
-- empty table and every public count rendered as 0 (hidden).
--
-- Recount from `event_registrations` at the tournament grain: DISTINCT
-- player_id across a tournament's (non-deleted) events with an active
-- (paid / pending_payment) registration. This is the same source + grain the
-- admin tournament page uses for its "total players"
-- (TournamentDetailPage: distinct player_id over event_registrations).
-- Seekers are INCLUDED — a player seeking a partner is still registered
-- (matches the admin total; unlike players_registered_for_events, whose job
-- is partner-picking).

set search_path = public;

create or replace function public.tournament_registration_counts(
  p_tournament_ids uuid[]
)
returns table (tournament_id uuid, registered_count integer)
language sql
stable
security definer
set search_path = public
as $$
  select e.tournament_id, count(distinct er.player_id)::int as registered_count
  from public.event_registrations er
  join public.events e on e.id = er.event_id
  where e.tournament_id = any(p_tournament_ids)
    and er.status in ('paid', 'pending_payment')
    and er.deleted_at is null
    and e.deleted_at is null
  group by e.tournament_id;
$$;

-- create-or-replace preserves grants, but re-assert for a self-contained migration.
grant execute on function public.tournament_registration_counts(uuid[]) to anon, authenticated;
