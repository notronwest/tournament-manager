-- 20260610130000_event_roster_pending_pairs.sql
--
-- Extends event_roster to expose pending-invite pairing data for the
-- unified roster list (issue #225). Builds on the invited_partner_*
-- columns added by migration 20260609200000.
--
-- New columns:
--   pending_partner_reg_id  — for a 'pending' inviter row: the
--     invitee's registration_id when the invitee is already registered.
--     For a 'seeking' invitee row: the inviter's registration_id when
--     there is an open incoming invite from a registered player.
--     NULL in all other cases. Lets the frontend group pending pairs.
--
--   pending_invite_id       — the partner_invites.id for the active
--     pending invite associated with this row (inviter OR invitee side).
--     Used by the frontend for Decline (invitee), Cancel (inviter), and
--     Accept (invitee — needs the invite to look up the token).
--
-- Also updates decline_partner_invite to reset the inviter's
-- event_registrations.partner_status to 'seeking' after a decline,
-- so the inviter re-enters the open-seeker pool automatically.
--
-- NOTE: Adding columns changes the function's RETURNS TABLE so we drop
-- and recreate. No in-DB dependents; grant re-established below.

set search_path = public;

drop function if exists public.event_roster(uuid[]);

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

    -- invited_partner_first_name / last_name: retained from
    -- migration 20260609200000. Name of the player the inviter
    -- nominated (registered or not). NULL on non-inviter rows.
    outbound.inv_first_name       as invited_partner_first_name,
    outbound.inv_last_name        as invited_partner_last_name,

    -- pending_partner_reg_id:
    --   * Inviter (partner_status='pending', no confirmed link):
    --     the registration_id of the invited player if they are
    --     already registered for this event.
    --   * Invitee (partner_status='seeking' with open incoming invite):
    --     the registration_id of the inviter.
    --   * NULL for all other rows.
    coalesce(
      outbound.invitee_reg_id,
      inbound.inviter_reg_id
    ) as pending_partner_reg_id,

    -- pending_invite_id: the partner_invites.id for the active pending
    -- invite on this row (inviter OR invitee side). Used by the frontend
    -- for Decline / Cancel / Accept actions.
    coalesce(
      outbound.invite_id,
      inbound.invite_id
    ) as pending_invite_id

  from public.event_registrations er
  join public.players p on p.id = er.player_id

  -- Outbound invite lookup: pending invite SENT by this player.
  -- Returns at most one row (latest by created_at) including the
  -- invited player's name and their registration_id if they exist.
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

  -- Inbound invite lookup: pending invite RECEIVED by this player
  -- while they are still seeking. Returns the inviter's reg_id.
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
    and er.status    in ('paid', 'pending_payment')
    and er.deleted_at is null
    and p.deleted_at  is null
  order by er.event_id, er.partner_status, p.last_name, p.first_name;
$$;

grant execute on function public.event_roster(uuid[])
  to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- decline_partner_invite — reset inviter's partner_status on decline
-- ─────────────────────────────────────────────────────────────────────
-- After a decline the inviter's event_registrations.partner_status
-- remains 'pending' indefinitely. Reset it to 'seeking' so the inviter
-- re-enters the open-seeker pool rather than showing as a stale row.

create or replace function public.decline_partner_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid         uuid := auth.uid();
  v_self_email  text;
  v_self_player uuid;
  v_invite      partner_invites%rowtype;
begin
  if v_uid is null then
    raise exception 'must be authenticated';
  end if;

  select email into v_self_email from auth.users where id = v_uid;
  select id into v_self_player
    from public.players
   where auth_user_id = v_uid
     and deleted_at is null
   limit 1;

  select * into v_invite from public.partner_invites where id = p_invite_id;
  if not found then
    raise exception 'invite not found';
  end if;
  -- Already responded → no-op (idempotent so a double-click doesn't error).
  if v_invite.status <> 'pending' then
    return;
  end if;

  -- Authorize: caller is the invitee by id OR by email.
  if v_invite.invitee_player_id <> v_self_player
     and (
       v_invite.invitee_email is null
       or v_self_email is null
       or lower(v_invite.invitee_email::text) <> lower(v_self_email)
     )
  then
    raise exception 'caller is not the invitee';
  end if;

  update public.partner_invites
     set status       = 'declined',
         responded_at = now()
   where id = p_invite_id;

  -- Reset the inviter's partner_status to 'seeking' so they re-enter
  -- the open-seeker pool rather than showing as a stale pending row.
  update public.event_registrations
     set partner_status = 'seeking'
   where player_id             = v_invite.inviter_player_id
     and event_id              = v_invite.event_id
     and deleted_at            is null
     and partner_status        = 'pending'
     and partner_registration_id is null;
end;
$$;

grant execute on function public.decline_partner_invite(uuid) to authenticated;
