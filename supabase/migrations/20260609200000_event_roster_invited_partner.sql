-- 20260609200000_event_roster_invited_partner.sql
--
-- Extends event_roster RPC (issue #167) to surface the invited
-- partner's first + last name when a player's partner_status is
-- 'pending' (they sent an invite that hasn't been accepted yet).
--
-- The join is: event_registrations → partner_invites (status='pending',
-- inviter=the registered player) → players (invitee). Only first_name
-- and last_name are returned — no token, no email, same privacy
-- posture as the existing roster columns.
--
-- This is a pure SECURITY DEFINER function; the join to partner_invites
-- is safe because it runs as the function owner (bypasses RLS), and
-- only exposes name fields already in scope for a public roster.
--
-- NOTE: this adds two columns to the function's RETURNS TABLE, which
-- changes its return type. Postgres rejects that via CREATE OR REPLACE
-- alone (ERROR 42P13: cannot change return type of existing function),
-- so we DROP the old signature first. The function is an app-facing RPC
-- with no in-DB dependents, so a plain DROP (no CASCADE) is safe; the
-- grant at the end re-establishes execute access dropped with it.

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
  invited_partner_last_name   text
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
    inv_p.first_name              as invited_partner_first_name,
    inv_p.last_name               as invited_partner_last_name
  from public.event_registrations er
  join public.players p on p.id = er.player_id
  -- Join to the pending invite sent by this player (if any).
  -- Left join so rows without a pending invite still appear.
  left join public.partner_invites pi
    on  pi.event_id        = er.event_id
    and pi.inviter_player_id = er.player_id
    and pi.status          = 'pending'
  left join public.players inv_p
    on  inv_p.id           = pi.invitee_player_id
    and inv_p.deleted_at   is null
  where er.event_id = any(p_event_ids)
    and er.status in ('paid', 'pending_payment')
    and er.deleted_at is null
    and p.deleted_at  is null
  order by er.event_id, er.partner_status, p.last_name, p.first_name;
$$;

grant execute on function public.event_roster(uuid[])
  to anon, authenticated;
