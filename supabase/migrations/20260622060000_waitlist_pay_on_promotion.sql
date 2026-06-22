-- 20260622060000_waitlist_pay_on_promotion.sql
--
-- Switch the waitlist payment model from PAY-ON-JOIN to PAY-ON-PROMOTION
-- (locked with Ron 2026-06-22; consistent with dropping the "un-promoted
-- auto-refund" AC — you never pay until promoted, so there's nothing to
-- refund).
--
--   join_waitlist:        creates a FREE 'waitlisted' reg (was
--                         'waitlisted_pending_payment'). No charge to join.
--   promote_from_waitlist: when a spot frees up, promotes the lowest waitlisted
--                         entry to 'waitlisted_pending_payment' — i.e. "your
--                         spot is ready, now pay to claim it" — NOT straight to
--                         'paid'. The standard checkout (compute_checkout_total
--                         already includes waitlisted_pending_payment) charges it
--                         → 'paid'.
--
-- Both are plain create-or-replace (return types unchanged → no 42P13).

set search_path = public;

-- ── join_waitlist: free 'waitlisted' on join ──────────────────────────────────
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
    select 1 from event_registrations
     where event_id = p_event_id
       and player_id = v_player
       and status not in ('cancelled', 'withdrawn', 'refunded')
       and deleted_at is null
  ) then
    raise exception 'already_registered';
  end if;

  select coalesce(max(waitlist_position), 0) + 1
    into v_pos
    from event_registrations
   where event_id = p_event_id
     and status in ('waitlisted_pending_payment', 'waitlisted')
     and deleted_at is null;

  v_pstat := case when v_fmt = 'doubles'
                  then 'seeking'::partner_status
                  else 'solo'::partner_status end;

  -- FREE join: 'waitlisted' (not 'waitlisted_pending_payment'). Payment only
  -- happens after promotion.
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

-- ── promote_from_waitlist: promote to 'waitlisted_pending_payment' ─────────────
create or replace function public.promote_from_waitlist(p_event_id uuid)
returns table (
  promoted_reg_id    uuid,
  promoted_player_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reg    uuid;
  v_player uuid;
begin
  select id, player_id
    into v_reg, v_player
    from event_registrations
   where event_id = p_event_id
     and status = 'waitlisted'
     and deleted_at is null
   order by waitlist_position asc nulls last, registered_at asc
   limit 1;

  if not found then return; end if;

  -- Promote to 'waitlisted_pending_payment' (spot reserved; pay to claim) —
  -- NOT straight to 'paid'. Clearing waitlist_position takes them out of the
  -- waiting queue; the standard checkout then charges + flips to 'paid'.
  update event_registrations
     set status            = 'waitlisted_pending_payment',
         waitlist_position = null,
         updated_at        = now()
   where id = v_reg
     and status = 'waitlisted';

  if not found then return; end if;  -- concurrent promote already ran

  promoted_reg_id    := v_reg;
  promoted_player_id := v_player;
  return next;
end;
$$;

comment on function public.promote_from_waitlist(uuid) is
  'Promotes the lowest-position waitlisted player to ''waitlisted_pending_payment'' '
  '(spot ready — pay to claim) when a spot opens. Returns promoted reg_id + '
  'player_id for email notification. No-op when the waitlist is empty. Called by '
  'withdraw_self and the stripe-refund edge function resolve mode.';

revoke all on function public.promote_from_waitlist(uuid) from public, anon, authenticated;
grant execute on function public.promote_from_waitlist(uuid) to service_role;
