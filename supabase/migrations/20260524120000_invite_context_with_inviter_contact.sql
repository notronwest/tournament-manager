-- 20260524120000_invite_context_with_inviter_contact.sql
--
-- Extend public.get_invite_context to also return the inviter's
-- email and phone. PartnerAcceptPage surfaces these so the invitee
-- can verify they actually know the person who picked them — names
-- alone can collide (two "Dave Kim"s in a 200-player tournament is
-- not far-fetched) and we don't want anyone clicking Accept on an
-- invite from someone they don't recognize.
--
-- Exposing the inviter's email/phone is fair game here: the token
-- in the URL is the secret, anyone holding it could already share
-- it via screenshot or forward, and the inviter chose to send an
-- invite knowing the invitee would receive their contact details.

set search_path = public;

-- Postgres treats the column list in `returns table (...)` as part
-- of the function signature, so adding columns can't be done with
-- create-or-replace. Drop and recreate. No callers depend on the
-- old shape — this RPC is only used from PartnerAcceptPage which
-- gets its types regenerated alongside this migration.
drop function if exists public.get_invite_context(text);

create or replace function public.get_invite_context(p_token text)
returns table (
  invite_id           uuid,
  invite_status       partner_invite_status,
  invitee_email       text,
  inviter_first_name  text,
  inviter_last_name   text,
  inviter_email       text,
  inviter_phone       text,
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
    inviter.email::text,
    inviter.phone,
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
