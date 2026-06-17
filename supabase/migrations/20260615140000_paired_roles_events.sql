-- 20260615140000_paired_roles_events.sql
--
-- Paired-roles doubles: a doubles event where every team must consist
-- of exactly one player from each of two named sides (e.g. "First
-- Responder" + "Community Member"). This phase (P1) delivers the data
-- model, the organizer toggle, and role-tagged registration end-to-end.
-- The organizer pairing board for solo "I need a partner" registrants
-- is Phase 2 (#338).
--
-- Schema changes (all additive):
--   1. event_gender: add 'open' value so mixed-gender paired-roles
--      events allow MM / FF / mixed teams in one bracket.
--   2. events: is_paired_roles flag + two side label columns.
--   3. event_registrations: registration_side ('a' | 'b') text column.
--   4. Trigger: enforce one-of-each-side constraint when partner link
--      is set on a paired-roles event.
--   5. Replace accept_partner_invite: auto-assign invitee's side to
--      the opposite of the inviter's on paired-roles events.

set search_path = public;

-- ─── 1. Extend event_gender enum ─────────────────────────────────────
-- 'open' means no gender restriction: men/men, women/women, and mixed
-- teams all compete in one bracket. Only meaningful for paired-roles
-- events, but we add it at the enum level so the constraint is clear.
alter type public.event_gender add value if not exists 'open';

-- ─── 2. Add paired-roles columns to events ───────────────────────────
alter table public.events
  add column if not exists is_paired_roles boolean not null default false,
  add column if not exists side_a_label    text    not null default 'First Responder',
  add column if not exists side_b_label    text    not null default 'Community Member';

-- ─── 3. Add registration_side to event_registrations ─────────────────
-- Stores which of the two sides ('a' or 'b') this registrant belongs
-- to. Required for registrations on paired-roles events; null for all
-- normal events. The display label comes from the event's side_a_label
-- / side_b_label columns.
alter table public.event_registrations
  add column if not exists registration_side text
    check (registration_side in ('a', 'b'));

-- ─── 4. Constraint trigger: one-of-each-side enforcement ─────────────
-- Fires BEFORE UPDATE when partner_registration_id is set. Rejects
-- pairings where both registrations have the same side on a
-- paired-roles event. Skips the check when either side is null so the
-- trigger doesn't fire prematurely during accept_partner_invite (which
-- may set both sides atomically).
create or replace function public.check_paired_roles_sides()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_paired    boolean;
  v_partner_side text;
begin
  -- Only validate when partner_registration_id is being set to a value.
  if new.partner_registration_id is null then
    return new;
  end if;

  select e.is_paired_roles into v_is_paired
    from public.events e
   where e.id = new.event_id;

  if not coalesce(v_is_paired, false) then
    return new;
  end if;

  -- Skip if this row's side isn't set yet (accept_partner_invite sets
  -- it in the same statement — safe because we set side before linking).
  if new.registration_side is null then
    return new;
  end if;

  select registration_side into v_partner_side
    from public.event_registrations
   where id = new.partner_registration_id;

  -- Skip if partner's side isn't set yet (first of the two updates in
  -- accept_partner_invite; the second update will have both sides set).
  if v_partner_side is null then
    return new;
  end if;

  if new.registration_side = v_partner_side then
    raise exception
      'paired-roles constraint: both players cannot be on the same side (%) — '
      'each team must have one player from each side.',
      new.registration_side;
  end if;

  return new;
end;
$$;

drop trigger if exists check_paired_roles_sides_trigger on public.event_registrations;
create trigger check_paired_roles_sides_trigger
  before update on public.event_registrations
  for each row
  when (
    new.partner_registration_id is not null
    and new.partner_registration_id is distinct from old.partner_registration_id
  )
  execute function public.check_paired_roles_sides();

-- ─── 5. Replace accept_partner_invite ────────────────────────────────
-- Extends the existing function to handle paired-roles events:
--   * If the event is paired-roles and the invitee has no side set,
--     auto-assign the opposite of the inviter's side.
--   * If the invitee already has a side set, enforce it is the opposite
--     of the inviter's (error if same side).
-- All other behavior is unchanged.
create or replace function public.accept_partner_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid              uuid := auth.uid();
  v_self_email       text;
  v_self_player      uuid;
  v_invite           partner_invites%rowtype;
  v_invitee_reg      uuid;
  v_inviter_reg      uuid;
  v_is_paired_roles  boolean;
  v_inviter_side     text;
  v_invitee_side     text;
  v_auto_side        text;
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
  if v_self_player is null then
    raise exception 'no player record for caller';
  end if;

  select * into v_invite from public.partner_invites where id = p_invite_id;
  if not found then
    raise exception 'invite not found';
  end if;
  if v_invite.status <> 'pending' then
    raise exception 'invite is not pending';
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

  select id into v_invitee_reg
    from public.event_registrations
   where event_id = v_invite.event_id
     and player_id = v_self_player
     and deleted_at is null
   limit 1;
  if v_invitee_reg is null then
    raise exception 'caller has no registration for this event';
  end if;

  select id into v_inviter_reg
    from public.event_registrations
   where event_id = v_invite.event_id
     and player_id = v_invite.inviter_player_id
     and deleted_at is null
   limit 1;
  if v_inviter_reg is null then
    raise exception 'inviter has no registration for this event';
  end if;

  -- ── Paired-roles: resolve sides before linking ────────────────────
  select e.is_paired_roles into v_is_paired_roles
    from public.events e
   where e.id = v_invite.event_id;

  if coalesce(v_is_paired_roles, false) then
    select registration_side into v_inviter_side
      from public.event_registrations where id = v_inviter_reg;

    if v_inviter_side is null then
      raise exception
        'inviter has no side set — they must choose a side when registering for a paired-roles event';
    end if;

    select registration_side into v_invitee_side
      from public.event_registrations where id = v_invitee_reg;

    if v_invitee_side is null then
      -- Auto-assign: invitee gets the opposite of the inviter's side.
      v_auto_side := case when v_inviter_side = 'a' then 'b' else 'a' end;
    elsif v_invitee_side = v_inviter_side then
      raise exception
        'paired-roles mismatch: you and the inviter have both chosen the same side — '
        'one of you must switch sides before pairing';
    else
      v_auto_side := v_invitee_side;
    end if;
  end if;

  -- ── Link both directions + flip statuses ─────────────────────────
  -- Inviter first: setting partner_registration_id triggers the
  -- check_paired_roles_sides trigger; invitee's side may still be
  -- null in the DB at this point, which the trigger tolerates (skips
  -- the check when partner's side is null).
  update public.event_registrations
     set partner_registration_id = v_invitee_reg,
         partner_status = 'confirmed'
   where id = v_inviter_reg;

  -- Invitee second: set registration_side and partner_registration_id
  -- atomically. Trigger fires and validates sides are different.
  update public.event_registrations
     set partner_registration_id = v_inviter_reg,
         partner_status = 'confirmed',
         registration_side = coalesce(v_auto_side, registration_side)
   where id = v_invitee_reg;

  -- Mark invite accepted and re-point invitee_player_id to the
  -- caller's real player.
  update public.partner_invites
     set status = 'accepted',
         responded_at = now(),
         invitee_player_id = v_self_player
   where id = p_invite_id;
end;
$$;

grant execute on function public.accept_partner_invite(uuid) to authenticated;
