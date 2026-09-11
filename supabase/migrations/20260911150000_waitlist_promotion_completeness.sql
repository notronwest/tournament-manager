-- 20260911150000_waitlist_promotion_completeness.sql
--
-- Fixes issue #771: promotion from the waitlist only happened when a PAID
-- registration withdrew. Two other ways a spot frees today promoted nobody:
--   - a promoted (waitlisted_pending_payment) player leaves
--   - a pending_payment registration is self-cancelled in a full event
-- Neither went through withdraw_self (which only handles paid/pending_payment
-- and preserves cancel/refund history), so both silently dropped the row
-- with no promote_from_waitlist call.
--
-- Also fixes: is_event_full and event_roster only counted ('pending_payment',
-- 'paid') as active, so the instant a spot is reserved via promotion
-- (status -> 'waitlisted_pending_payment') the public team count dropped
-- below max until the promoted player paid — the freed spot looked open
-- when it was actually held. Add 'waitlisted_pending_payment' to both.
--
-- New: cancel_registration(p_reg_id) — self-service soft-delete for
-- pending_payment / waitlisted / waitlisted_pending_payment regs (mirrors
-- the existing client-side soft-delete in PublicTournamentPage's
-- onCancelPending, which this migration's UX companion PR now routes
-- through this RPC instead of a raw client update). Promotes the next
-- waitlisted player when the reg being removed was actually holding a
-- reserved spot (pending_payment or waitlisted_pending_payment) — not when
-- it was a free 'waitlisted' queue entry, which never held a spot.
--
-- All three are plain create-or-replace (no return-type changes -> no 42P13).

set search_path = public;

-- ── is_event_full: count a reserved-but-unpaid promoted spot as active ────────
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
    -- Active teams = confirmed pairs (2 regs -> 1 team) + one team for each
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
       and er.status    in ('pending_payment', 'paid', 'waitlisted_pending_payment')
       and er.deleted_at is null;
  else
    select count(*)::integer
      into v_used
      from event_registrations
     where event_id = p_event_id
       and status in ('pending_payment', 'paid', 'waitlisted_pending_payment')
       and deleted_at is null;
  end if;

  return v_used >= v_max;
end;
$$;

comment on function public.is_event_full(uuid) is
  'True when ACTIVE teams (pending_payment + paid + waitlisted_pending_payment; '
  'a promoted-but-unpaid reg still holds its reserved spot) reach max_teams. '
  'Doubles counts teams the way the roster label does, discounting a '
  'spoken-for seeker. NULL max_teams -> false.';

grant execute on function public.is_event_full(uuid) to authenticated, anon;

-- ── event_roster: same fix, so the public team-count card matches ─────────────
create or replace function public.event_roster(
  p_event_ids uuid[]
)
returns table (
  event_id                    uuid,
  registration_id             uuid,
  partner_registration_id     uuid,
  partner_status              partner_status,
  first_name                  text,
  last_name                   text,
  gender                      player_gender,
  age                         smallint,
  city                        text,
  state                       text,
  self_rating_doubles         numeric(4,2),
  self_rating_mixed           numeric(4,2),
  self_rating_singles         numeric(4,2),
  invited_partner_first_name  text,
  invited_partner_last_name   text,
  pending_partner_reg_id      uuid,
  pending_invite_id           uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select
    er.event_id,
    er.id                         as registration_id,
    er.partner_registration_id,
    er.partner_status,
    p.first_name,
    p.last_name,
    p.gender,
    case
      when p.dob is null then null
      else extract(year from age(p.dob))::smallint
    end                           as age,
    p.city,
    p.state,
    p.self_rating_doubles,
    p.self_rating_mixed,
    p.self_rating_singles,

    outbound.inv_first_name       as invited_partner_first_name,
    outbound.inv_last_name        as invited_partner_last_name,

    coalesce(
      outbound.invitee_reg_id,
      inbound.inviter_reg_id
    ) as pending_partner_reg_id,

    coalesce(
      outbound.invite_id,
      inbound.invite_id
    ) as pending_invite_id

  from public.event_registrations er
  join public.players p on p.id = er.player_id

  left join lateral (
    select
      pi.id                         as invite_id,
      p_inv.first_name              as inv_first_name,
      p_inv.last_name               as inv_last_name,
      er_inv.id                     as invitee_reg_id
    from public.partner_invites pi
    left join public.players p_inv
      on  p_inv.id         = pi.invitee_player_id
      and p_inv.deleted_at is null
    left join public.event_registrations er_inv
      on  er_inv.player_id  = pi.invitee_player_id
      and er_inv.event_id   = pi.event_id
      and er_inv.deleted_at is null
      and er_inv.status     in ('paid', 'pending_payment')
    where pi.inviter_player_id = er.player_id
      and pi.event_id          = er.event_id
      and pi.status            = 'pending'
    order by pi.created_at desc
    limit 1
  ) outbound on er.partner_status = 'pending'
             and er.partner_registration_id is null

  left join lateral (
    select
      pi2.id       as invite_id,
      er_inv.id    as inviter_reg_id
    from public.partner_invites pi2
    join public.event_registrations er_inv
      on  er_inv.player_id  = pi2.inviter_player_id
      and er_inv.event_id   = pi2.event_id
      and er_inv.deleted_at is null
      and er_inv.status     in ('paid', 'pending_payment')
    where pi2.invitee_player_id = er.player_id
      and pi2.event_id          = er.event_id
      and pi2.status            = 'pending'
    order by pi2.created_at desc
    limit 1
  ) inbound on er.partner_status = 'seeking'

  where er.event_id  = any(p_event_ids)
    -- 'waitlisted_pending_payment' added (issue #771): a promoted-but-unpaid
    -- reg still holds its reserved spot and must count on the roster/card.
    and er.status    in ('paid', 'pending_payment', 'waitlisted_pending_payment')
    and er.deleted_at is null
    and p.deleted_at  is null
  order by er.event_id, er.partner_status, p.last_name, p.first_name;
$$;

grant execute on function public.event_roster(uuid[])
  to anon, authenticated;

-- ── cancel_registration: self-service cancel/leave for a spot that never ──────
-- required the paid-withdrawal history/refund path — a plain unpaid
-- pending_payment reg, a free waitlist queue entry, or a reserved-but-unpaid
-- promoted spot. Soft-deletes (mirrors the client-side behavior this
-- replaces) and, when the reg being removed actually held a reserved spot,
-- promotes the next waitlisted player.
create or replace function public.cancel_registration(p_reg_id uuid)
returns table (
  promoted_reg_id    uuid,
  promoted_player_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_player  uuid;
  v_player_id    uuid;
  v_event_id     uuid;
  v_status       registration_status;
  v_promo_reg    uuid;
  v_promo_player uuid;
begin
  select id into v_auth_player
    from players
   where auth_user_id = auth.uid() and deleted_at is null;
  if not found then raise exception 'player_not_found'; end if;

  select er.player_id, er.event_id, er.status
    into v_player_id, v_event_id, v_status
    from event_registrations er
   where er.id = p_reg_id and er.deleted_at is null;
  if not found then raise exception 'registration_not_found'; end if;

  if v_player_id <> v_auth_player then raise exception 'forbidden'; end if;

  if v_status not in ('pending_payment', 'waitlisted', 'waitlisted_pending_payment') then
    raise exception 'not_cancellable';
  end if;

  update event_registrations
     set deleted_at = now(),
         updated_at = now()
   where id = p_reg_id and status = v_status;

  -- 'pending_payment' and 'waitlisted_pending_payment' hold a reserved spot
  -- (is_event_full counts both); 'waitlisted' is a free queue entry that
  -- never held one, so there is nothing to free.
  v_promo_reg    := null;
  v_promo_player := null;
  if v_status in ('pending_payment', 'waitlisted_pending_payment') then
    select p.promoted_reg_id, p.promoted_player_id
      into v_promo_reg, v_promo_player
      from promote_from_waitlist(v_event_id) p;
  end if;

  promoted_reg_id    := v_promo_reg;
  promoted_player_id := v_promo_player;
  return next;
end;
$$;

comment on function public.cancel_registration(uuid) is
  'Player self-service cancel/leave for pending_payment, waitlisted, and '
  'waitlisted_pending_payment registrations (soft-delete; no refund path — '
  'none of these have been charged). Promotes the next waitlisted player '
  'when the removed reg was holding a reserved spot (pending_payment or '
  'waitlisted_pending_payment). Returns promoted_reg_id + promoted_player_id '
  '(null if no one was waiting). SECURITY DEFINER.';

revoke all on function public.cancel_registration(uuid) from public, anon;
grant execute on function public.cancel_registration(uuid) to authenticated;
