-- 20260525200001_f3_rpc_exclude_seekers.sql
--
-- Update the F3 RPC players_registered_for_events to EXCLUDE
-- seekers (partner_status='seeking'). F3 is the partner-picker
-- filter — its purpose is "don't surface someone already paired
-- up." A seeker is the OPPOSITE: someone actively findable. So
-- the set shrinks.
--
-- Lives in a separate migration from the enum-extension because
-- ALTER TYPE ADD VALUE can't be referenced in the same
-- transaction as it's added in.

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
    and partner_status <> 'seeking'
    and deleted_at is null;
$$;
