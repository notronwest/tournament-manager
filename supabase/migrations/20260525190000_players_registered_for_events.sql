-- 20260525190000_players_registered_for_events.sql
--
-- RPC for the F3 partner-search filter: returns the set of
-- (event_id, player_id) tuples representing every active registrant
-- for a batch of events. "Active" = status in ('paid',
-- 'pending_payment') AND not soft-deleted.
--
-- Wrapped in SECURITY DEFINER because event_registrations RLS
-- restricts non-org-member SELECTs to the calling user's OWN rows
-- — but the partner picker (logged-in player) legitimately needs
-- to know who's already in an event in order to filter them out of
-- search results. Exposing just the player_id is the minimum
-- needed; we deliberately don't return names / emails / partner
-- status so this RPC can stay narrow.
--
-- F1 follow-up: when 'seeking' lands on partner_status, this RPC
-- should exclude seekers from the result so they STILL show up in
-- partner search (the whole point of 'seeking' is to be findable).

set search_path = public;

create or replace function public.players_registered_for_events(
  p_event_ids uuid[]
)
returns table (event_id uuid, player_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select event_id, player_id
  from public.event_registrations
  where event_id = any(p_event_ids)
    and status in ('paid', 'pending_payment')
    and deleted_at is null;
$$;

grant execute on function public.players_registered_for_events(uuid[])
  to anon, authenticated;
