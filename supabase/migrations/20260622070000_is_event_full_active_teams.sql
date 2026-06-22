-- 20260622070000_is_event_full_active_teams.sql
--
-- Fix: is_event_full only counted status='paid' regs, so an event whose
-- teams are all "still forming" (registered but unpaid: pending_payment +
-- forming partner states) read as NOT full server-side — while the roster
-- label and the public-page CTA count those forming teams and show "full".
-- Result: the "Join waitlist" CTA appeared, but join_waitlist (which calls
-- is_event_full) rejected with 'event_not_full'.
--
-- Make "full" mean what the roster shows: count ACTIVE teams — registrations
-- in ('pending_payment','paid'), NOT waitlisted/withdrawn/cancelled/refunded.
-- For doubles, count distinct teams the same way the roster label does:
--   confirmed pairs (count('confirmed')/2, rounded up) + one team per
--   non-confirmed active reg (seeking / pending-invite / solo).
--
-- Plain create-or-replace (return type unchanged → no 42P13).

set search_path = public;

create or replace function public.is_event_full(p_event_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_max  smallint;
  v_fmt  event_format;
  v_used integer;
begin
  select max_teams, format
    into v_max, v_fmt
    from events
   where id = p_event_id and deleted_at is null;

  if not found or v_max is null then
    return false;
  end if;

  if v_fmt = 'doubles' then
    -- Active teams = confirmed pairs (2 regs → 1 team) + one team for each
    -- non-confirmed active reg (a forming/seeking/solo team holds a slot).
    select ceil(
             count(*) filter (where partner_status = 'confirmed')::numeric / 2
           )::integer
           + count(*) filter (where partner_status <> 'confirmed')
      into v_used
      from event_registrations
     where event_id = p_event_id
       and status in ('pending_payment', 'paid')
       and deleted_at is null;
  else
    select count(*)::integer
      into v_used
      from event_registrations
     where event_id = p_event_id
       and status in ('pending_payment', 'paid')
       and deleted_at is null;
  end if;

  return coalesce(v_used, 0) >= v_max;
end;
$$;

comment on function public.is_event_full(uuid) is
  'True when ACTIVE teams (pending_payment + paid; forming teams hold a slot) '
  'reach max_teams. Doubles counts teams the way the roster label does. '
  'NULL max_teams → false.';

grant execute on function public.is_event_full(uuid) to authenticated, anon;
