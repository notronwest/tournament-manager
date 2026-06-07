-- 20260606130000_event_roster_rpc.sql
--
-- New SECURITY DEFINER RPC for the public event roster panel
-- (issue #69). The existing players_registered_for_events RPC
-- intentionally returns only player_id so the partner-picker
-- filter stays narrow. This separate RPC is the read surface for
-- the roster panel — it returns full player details needed to
-- render the team list and seeking-partner section.
--
-- Returns one row per active event_registration (status in
-- ('paid','pending_payment'), not deleted) for the given events,
-- joined to the player profile. The caller uses partner_status to
-- split seekers from teams, and the registration_id /
-- partner_registration_id pair to group doubles partners together.
--
-- Privacy posture: tournament rosters are public information for
-- anyone who can view the tournament page (same posture as
-- PickleballBrackets). Only name, age, gender, location, and
-- self-rating are exposed — no email, phone, or auth_user_id.
--
-- SECURITY DEFINER: event_registrations RLS restricts non-org-
-- member reads to the caller's own rows. The partner picker
-- already bypasses this via players_registered_for_events; this
-- RPC extends that exception to the roster panel.

set search_path = public;

create or replace function public.event_roster(
  p_event_ids uuid[]
)
returns table (
  event_id                uuid,
  registration_id         uuid,
  partner_registration_id uuid,
  partner_status          partner_status,
  first_name              text,
  last_name               text,
  gender                  player_gender,
  age                     smallint,
  city                    text,
  state                   text,
  self_rating_doubles     numeric(4,2),
  self_rating_mixed       numeric(4,2),
  self_rating_singles     numeric(4,2)
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
    p.self_rating_singles
  from public.event_registrations er
  join public.players p on p.id = er.player_id
  where er.event_id = any(p_event_ids)
    and er.status in ('paid', 'pending_payment')
    and er.deleted_at is null
    and p.deleted_at is null
  order by er.event_id, er.partner_status, p.last_name, p.first_name;
$$;

grant execute on function public.event_roster(uuid[])
  to anon, authenticated;
