-- 20260624130000_is_event_full_discount_spoken_seekers.sql
--
-- Fix: is_event_full double-counted a forming pair when one side joined an
-- already-registered seeker. A seeker who registered as "I need a partner"
-- holds ONE slot; when another player "Partners up" with them, two regs now
-- exist for that one team — the seeker (partner_status='seeking') and the
-- joiner (partner_status='pending'). The previous count took every
-- non-confirmed active reg as a team, so it counted the pair as 2 → the
-- event read as OVER capacity (and a genuinely-not-full event could read
-- full), diverging from the roster label + public-page count, which exclude
-- a "spoken-for" seeker (one with an open incoming invite from a registrant).
--
-- Make the server mirror the client: a seeking reg that has a PENDING inbound
-- partner_invite from an active (paid/pending_payment) registrant is
-- "spoken-for" and no longer counts — its joiner's 'pending' reg holds the
-- slot. Same definition event_roster uses for pending_partner_reg_id (see
-- 20260610130000_event_roster_pending_pairs.sql, the inbound-invite lateral).
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
    -- non-confirmed active reg, EXCEPT a "spoken-for" seeker: a seeking reg
    -- with a pending inbound invite from another active registrant. That
    -- seeker's slot is held by the joiner's 'pending' reg, so counting both
    -- would double the team. Mirrors the roster/public-page count.
    select ceil(
             count(*) filter (where partner_status = 'confirmed')::numeric / 2
           )::integer
           + count(*) filter (
               where partner_status <> 'confirmed'
                 and not (
                   partner_status = 'seeking'
                   and exists (
                     select 1
                       from event_registrations joiner
                       join partner_invites pi
                         on  pi.inviter_player_id = joiner.player_id
                         and pi.event_id          = joiner.event_id
                         and pi.invitee_player_id = er.player_id
                         and pi.status            = 'pending'
                      where joiner.event_id   = p_event_id
                        and joiner.status     in ('pending_payment', 'paid')
                        and joiner.deleted_at is null
                   )
                 )
             )
      into v_used
      from event_registrations er
     where er.event_id  = p_event_id
       and er.status    in ('pending_payment', 'paid')
       and er.deleted_at is null;
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
  'reach max_teams. Doubles counts teams the way the roster label does, '
  'discounting a spoken-for seeker (seeking reg with a pending inbound invite '
  'from an active registrant) so a partnered-into seeker is not double-counted. '
  'NULL max_teams → false.';

grant execute on function public.is_event_full(uuid) to authenticated, anon;
