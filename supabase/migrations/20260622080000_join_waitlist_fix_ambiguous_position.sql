-- 20260622080000_join_waitlist_fix_ambiguous_position.sql
--
-- Fix: join_waitlist failed with `column reference "waitlist_position" is
-- ambiguous`. The function's OUT column is named `waitlist_position`, and the
-- next-position query (`select max(waitlist_position) from
-- event_registrations`) referenced the same name unqualified — Postgres can't
-- tell the OUT param from the table column. (The original migration named the
-- OUT column `position`, a reserved word; renaming it to `waitlist_position`
-- traded the 42601 for this ambiguity.)
--
-- Qualify the table column via an alias (er.waitlist_position). Body is
-- otherwise identical to the pay-on-promotion version (20260622060000).
-- Plain create-or-replace (return type unchanged → no 42P13).

set search_path = public;

create or replace function public.join_waitlist(p_event_id uuid)
returns table (
  reg_id            uuid,
  waitlist_position integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player uuid;
  v_fmt    event_format;
  v_pos    integer;
  v_reg    uuid;
  v_pstat  partner_status;
begin
  select id into v_player
    from players
   where auth_user_id = auth.uid() and deleted_at is null;
  if not found then raise exception 'player_not_found'; end if;

  select format into v_fmt
    from events
   where id = p_event_id and deleted_at is null;
  if not found then raise exception 'event_not_found'; end if;

  if not is_event_full(p_event_id) then
    raise exception 'event_not_full';
  end if;

  if exists (
    select 1 from event_registrations er
     where er.event_id = p_event_id
       and er.player_id = v_player
       and er.status not in ('cancelled', 'withdrawn', 'refunded')
       and er.deleted_at is null
  ) then
    raise exception 'already_registered';
  end if;

  -- Next position. Qualify the table column (er.waitlist_position) so it
  -- isn't confused with this function's OUT column of the same name.
  select coalesce(max(er.waitlist_position), 0) + 1
    into v_pos
    from event_registrations er
   where er.event_id = p_event_id
     and er.status in ('waitlisted_pending_payment', 'waitlisted')
     and er.deleted_at is null;

  v_pstat := case when v_fmt = 'doubles'
                  then 'seeking'::partner_status
                  else 'solo'::partner_status end;

  insert into event_registrations (
    event_id, player_id, event_fee_cents,
    status, partner_status, waitlist_position
  ) values (
    p_event_id, v_player, 0,
    'waitlisted', v_pstat, v_pos
  )
  returning id into v_reg;

  reg_id            := v_reg;
  waitlist_position := v_pos;
  return next;
end;
$$;

comment on function public.join_waitlist(uuid) is
  'Player self-joins the waitlist for a full event. Creates a FREE ''waitlisted'' '
  'registration (no payment on join; payment happens after promotion). '
  'SECURITY DEFINER; auth.uid() ownership and event-full checks.';
