-- 20260521142514_accept_partner_invite.sql
--
-- Server-side helper for "accept a partner invite" — used both
-- explicitly from a future accept page (commit 4) and implicitly
-- when a player registers themselves and turns out to already have
-- a pending invite for that event from the partner they just picked.
--
-- Why SECURITY DEFINER: accepting an invite has to update *both*
-- the inviter's and invitee's event_registrations. The invitee's
-- RLS only reaches their own row; the inviter's row is off-limits
-- to them. Rather than relax RLS (and risk other side effects),
-- the function runs as the function owner and bypasses RLS for
-- the specific writes it needs.
--
-- Authorization happens inside the function:
--   * Caller must be authenticated.
--   * Caller must be the invitee, identified by EITHER
--       - invitee_player_id matching the caller's player id, OR
--       - invitee_email matching the caller's auth email.
--     The email fallback covers the case where the inviter created
--     an orphan stub player for the invitee, and the invitee later
--     created their own (different) players row.
--
-- Side effects:
--   * Links event_registrations both ways (partner_registration_id
--     + partner_status='confirmed' on each side).
--   * Marks the invite accepted with responded_at=now() and
--     re-points invitee_player_id at the caller's actual player.
--
-- Both event_registrations must already exist. The caller's reg is
-- typically inserted moments before calling this function (during
-- the registration submit flow); the inviter's reg has existed
-- since the inviter completed their own registration.

set search_path = public;

create or replace function public.accept_partner_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid           uuid := auth.uid();
  v_self_email    text;
  v_self_player   uuid;
  v_invite        partner_invites%rowtype;
  v_invitee_reg   uuid;
  v_inviter_reg   uuid;
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

  -- Both registrations must already exist for the link to make
  -- sense. The caller's reg is normally inserted in the same submit
  -- flow as the function call; the inviter's reg has existed since
  -- they registered.
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

  -- Link both directions + flip statuses.
  update public.event_registrations
     set partner_registration_id = v_invitee_reg,
         partner_status = 'confirmed'
   where id = v_inviter_reg;
  update public.event_registrations
     set partner_registration_id = v_inviter_reg,
         partner_status = 'confirmed'
   where id = v_invitee_reg;

  -- Mark invite accepted and re-point invitee_player_id to the
  -- caller's real player. Future queries by invitee_player_id then
  -- resolve to the live player row even if the inviter originally
  -- created a separate stub for the email.
  update public.partner_invites
     set status = 'accepted',
         responded_at = now(),
         invitee_player_id = v_self_player
   where id = p_invite_id;
end;
$$;

grant execute on function public.accept_partner_invite(uuid) to authenticated;
