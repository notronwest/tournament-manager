-- 20260521153353_invite_context_and_decline.sql
--
-- Helpers for the partner-accept page. Two SECURITY DEFINER
-- functions:
--
--   get_invite_context(p_token text) — anon-callable. Returns just
--   enough context (event/tournament/inviter name) to render the
--   pre-auth "you've been invited" banner. The token in the URL is
--   the secret; anyone holding it can already share it, so exposing
--   these read-only fields is by design. Doesn't surface anything
--   beyond what we'd put in the invite email itself.
--
--   decline_partner_invite(p_invite_id uuid) — auth-required.
--   Mirror of accept_partner_invite, but just flips status to
--   'declined' + sets responded_at. Same email-or-player-id
--   authorization so an invitee who created their own player row
--   after being invited can still decline.

set search_path = public;

-- ─────────────────────────────────────────────────────────────────────
-- get_invite_context
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.get_invite_context(p_token text)
returns table (
  invite_id           uuid,
  invite_status       partner_invite_status,
  invitee_email       text,
  inviter_first_name  text,
  inviter_last_name   text,
  event_id            uuid,
  event_name          text,
  event_format        event_format,
  event_fee_cents     integer,
  tournament_id       uuid,
  tournament_name     text,
  tournament_slug     text,
  org_slug            text
)
language sql
security definer
set search_path = public
as $$
  select
    pi.id,
    pi.status,
    pi.invitee_email::text,
    inviter.first_name,
    inviter.last_name,
    e.id,
    e.name,
    e.format,
    e.event_fee_cents,
    t.id,
    t.name,
    t.slug,
    o.slug
  from public.partner_invites pi
  join public.players inviter on inviter.id = pi.inviter_player_id
  join public.events e on e.id = pi.event_id
  join public.tournaments t on t.id = e.tournament_id
  join public.organizations o on o.id = t.organization_id
  where pi.token = p_token
    and t.deleted_at is null
    and e.deleted_at is null;
$$;

grant execute on function public.get_invite_context(text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- decline_partner_invite
-- ─────────────────────────────────────────────────────────────────────

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
  -- Already responded → no-op (we treat this as idempotent so a
  -- double-click doesn't error).
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
     set status = 'declined',
         responded_at = now()
   where id = p_invite_id;
end;
$$;

grant execute on function public.decline_partner_invite(uuid) to authenticated;
