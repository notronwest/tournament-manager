-- 20260715000000_tournament_registration_counts_rpc.sql
--
-- Public "total registered players" per tournament.
--
-- The browse/home page and the public tournament page are BOTH anonymous
-- surfaces, but RLS on `registrations` only exposes rows to the owning
-- player or an org member — so an anon client-side count returns 0 (not an
-- error). This SECURITY DEFINER RPC returns an aggregate count only (no
-- PII), batched by tournament id so the home page can fetch every visible
-- card in one round trip (same array-arg convention as
-- players_registered_for_events / event_roster).
--
-- "Registered" mirrors every existing count in the app (the
-- TournamentsListPage delete-guard and PricingTiersEditor): a
-- tournament-level `registrations` row with status in
-- ('paid','pending_payment') and not soft-deleted. `registrations` is
-- unique on (tournament_id, player_id), so a plain row count = distinct
-- players with no dedup needed.

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
  select r.tournament_id, count(*)::int as registered_count
  from public.registrations r
  where r.tournament_id = any(p_tournament_ids)
    and r.status in ('paid', 'pending_payment')
    and r.deleted_at is null
  group by r.tournament_id;
$$;

grant execute on function public.tournament_registration_counts(uuid[]) to anon, authenticated;
