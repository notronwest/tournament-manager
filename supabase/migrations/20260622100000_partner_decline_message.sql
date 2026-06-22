-- 20260622000001_partner_decline_message.sql
--
-- Adds an optional decline message to partner invite declines.
-- Players can leave a short note when declining so the inviter
-- knows why (e.g. "already partnered up", "can't make it").
--
-- Changes:
--   1. partner_invites.decline_message text nullable (max 280 chars)
--   2. decline_partner_invite() gains p_decline_message parameter
--      (default null — no breaking change for existing callers)

set search_path = public;

alter table public.partner_invites
  add column decline_message text
  check (decline_message is null or char_length(decline_message) <= 280);

-- Replace decline_partner_invite with the updated signature.
-- Must drop first because adding a parameter changes the function signature.
drop function public.decline_partner_invite(uuid);

create or replace function public.decline_partner_invite(
  p_invite_id       uuid,
  p_decline_message text default null
)
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
     set status          = 'declined',
         responded_at    = now(),
         decline_message = p_decline_message
   where id = p_invite_id;
end;
$$;

grant execute on function public.decline_partner_invite(uuid, text) to authenticated;
