-- 20260910120000_waitlist_pending_payment_parity.sql
--
-- A promoted waitlister ('waitlisted_pending_payment' — "a spot opened, pay to
-- claim") holds a RESERVED spot exactly like a 'pending_payment' registrant.
-- Several server paths only knew about 'pending_payment', which broke the
-- pay-to-claim flow end to end and hid promoted players from the roster
-- (PROD case 2026-09-10: Tawnya Lopez, Pickleball Angels Mixed 2.75–3.25 —
-- promoted Sep 7, partner accepted + paid Sep 8, she could not pay and the
-- pair vanished from the public roster while the event stayed "full").
--
-- What ships here (all `create or replace`, idempotent, additive):
--   • compute_checkout_total — charges waitlisted_pending_payment regs again
--     (this was dropped by accident in 20260815130000_pricing_events_included).
--   • is_event_full          — a reserved spot counts toward capacity, so a
--     promoted waitlister can't be double-booked by a new registrant.
--   • event_roster           — promoted waitlisters appear on the public roster
--     (and their confirmed partner is no longer orphaned off it).
--   • promote_from_waitlist  — promotes the confirmed partner alongside, so a
--     waitlisted doubles team is never half-promoted.
--   • get_invite_context     — exposes the inviter's registration status so the
--     partner-accept page can put the invitee on the waitlist next to a
--     waitlisted inviter instead of handing them a paid spot.
--
-- The edge functions create-payment-intent + stripe-webhook ship alongside
-- (same PR) so the guard and the paid-flip accept waitlisted_pending_payment.

set search_path = public;

-- ── 1. compute_checkout_total ─────────────────────────────────────────────────
-- Identical to 20260815130000 except the `pend` CTE also picks up
-- waitlisted_pending_payment (restores the 20260622 behaviour).

create or replace function public.compute_checkout_total(
  p_player_id     uuid,
  p_tournament_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tier         public.tournament_pricing_tiers;
  v_first        integer := 0;
  v_add          integer := 0;
  v_included     integer := 1;
  v_already_paid boolean := false;
  v_items        jsonb := '[]'::jsonb;
  v_total        integer := 0;
  r              record;
begin
  select * into v_tier from public.current_pricing_tier(p_tournament_id, now());
  if found then
    v_first    := coalesce(v_tier.first_event_fee_cents, 0);
    v_add      := coalesce(v_tier.additional_event_fee_cents, 0);
    v_included := greatest(coalesce(v_tier.first_events_included, 1), 1);
  end if;

  select exists (
    select 1
      from public.event_registrations er
      join public.events e on e.id = er.event_id
     where e.tournament_id = p_tournament_id
       and er.player_id = p_player_id
       and er.status = 'paid'
       and er.deleted_at is null
  ) into v_already_paid;

  for r in
    with pend as (
      select er.id   as reg_id,
             e.id    as event_id,
             e.name  as event_name,
             e.event_fee_cents as override_cents,
             case when e.event_fee_cents > 0 then e.event_fee_cents else v_first end as full_price
        from public.event_registrations er
        join public.events e on e.id = er.event_id
       where e.tournament_id = p_tournament_id
         and er.player_id = p_player_id
         and er.status in ('pending_payment', 'waitlisted_pending_payment')
         and er.deleted_at is null
         and e.deleted_at is null
    )
    select reg_id, event_id, event_name, override_cents, full_price,
           row_number() over (order by full_price desc, reg_id) as rn
      from pend
  loop
    declare
      v_label  text;
      v_amount integer;
    begin
      if r.override_cents > 0 then
        v_label := 'override';
        v_amount := r.override_cents;
      elsif r.rn = 1 and not v_already_paid then
        v_label := 'first';
        v_amount := v_first;
      elsif r.rn <= v_included and not v_already_paid then
        v_label := 'included';
        v_amount := 0;
      else
        v_label := 'additional';
        v_amount := v_add;
      end if;

      v_total := v_total + v_amount;
      v_items := v_items || jsonb_build_object(
        'event_registration_id', r.reg_id,
        'event_id', r.event_id,
        'description', r.event_name,
        'amount_cents', v_amount,
        'tier', v_label
      );
    end;
  end loop;

  return jsonb_build_object('total_cents', v_total, 'line_items', v_items);
end;
$$;
comment on function public.compute_checkout_total(uuid, uuid) is
  'Authoritative checkout total + line items for a player''s unpaid regs (pending_payment + waitlisted_pending_payment) in a tournament. Entry fee covers the first N (first_events_included) events; picks beyond N get the additional rate. Mirrors web/src/lib/pricing.ts. SECURITY DEFINER, service_role only (Stripe edge function).';

revoke all on function public.compute_checkout_total(uuid, uuid) from public, anon, authenticated;
grant execute on function public.compute_checkout_total(uuid, uuid) to service_role;

-- ── 2. is_event_full ──────────────────────────────────────────────────────────
-- Same as 20260624130000 with waitlisted_pending_payment added to the
-- "holds a spot" set (both the counted rows and the joiner sub-select).

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
                        and joiner.status     in ('pending_payment', 'paid', 'waitlisted_pending_payment')
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

  return coalesce(v_used, 0) >= v_max;
end;
$$;

comment on function public.is_event_full(uuid) is
  'True when spot-holding teams (pending_payment + paid + waitlisted_pending_payment; '
  'forming teams hold a slot) reach max_teams. Doubles counts teams the way the roster '
  'label does, discounting a spoken-for seeker (seeking reg with a pending inbound invite '
  'from an active registrant) so a partnered-into seeker is not double-counted. '
  'NULL max_teams → false.';

grant execute on function public.is_event_full(uuid) to authenticated, anon;

-- ── 3. event_roster ───────────────────────────────────────────────────────────
-- Same as 20260610130000 with waitlisted_pending_payment added to the three
-- status allow-lists (main filter + both invite laterals).

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
      and er_inv.status     in ('paid', 'pending_payment', 'waitlisted_pending_payment')
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
      and er_inv.status     in ('paid', 'pending_payment', 'waitlisted_pending_payment')
    where pi2.invitee_player_id = er.player_id
      and pi2.event_id          = er.event_id
      and pi2.status            = 'pending'
    order by pi2.created_at desc
    limit 1
  ) inbound on er.partner_status = 'seeking'

  where er.event_id  = any(p_event_ids)
    and er.status    in ('paid', 'pending_payment', 'waitlisted_pending_payment')
    and er.deleted_at is null
    and p.deleted_at  is null
  order by er.event_id, er.partner_status, p.last_name, p.first_name;
$$;

grant execute on function public.event_roster(uuid[])
  to anon, authenticated;

-- ── 4. promote_from_waitlist ──────────────────────────────────────────────────
-- Same as 20260622060000, plus: if the promoted reg has a CONFIRMED partner who
-- is also 'waitlisted', promote the partner in the same statement so the team
-- moves off the waitlist together. Return value is unchanged (the inviter /
-- lowest-position reg) so withdraw_self + stripe-refund callers keep working.

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
  v_reg     uuid;
  v_player  uuid;
  v_partner uuid;
begin
  select id, player_id, partner_registration_id
    into v_reg, v_player, v_partner
    from event_registrations
   where event_id = p_event_id
     and status = 'waitlisted'
     and deleted_at is null
   order by waitlist_position asc nulls last, registered_at asc
   limit 1;

  if not found then return; end if;

  update event_registrations
     set status            = 'waitlisted_pending_payment',
         waitlist_position = null,
         updated_at        = now()
   where id = v_reg
     and status = 'waitlisted';

  if not found then return; end if;  -- concurrent promote already ran

  -- Carry the confirmed partner along (no-op when the partner is not waitlisted).
  if v_partner is not null then
    update event_registrations
       set status            = 'waitlisted_pending_payment',
           waitlist_position = null,
           updated_at        = now()
     where id = v_partner
       and event_id = p_event_id
       and status = 'waitlisted'
       and deleted_at is null;
  end if;

  promoted_reg_id    := v_reg;
  promoted_player_id := v_player;
  return next;
end;
$$;

comment on function public.promote_from_waitlist(uuid) is
  'Promotes the lowest-position waitlisted player (and their confirmed partner, if '
  'also waitlisted) to ''waitlisted_pending_payment'' (spot ready — pay to claim) when '
  'a spot opens. Returns the lead reg_id + player_id for email notification. No-op '
  'when the waitlist is empty. Called by withdraw_self and stripe-refund resolve mode.';

revoke all on function public.promote_from_waitlist(uuid) from public, anon, authenticated;
grant execute on function public.promote_from_waitlist(uuid) to service_role;

-- ── 5. get_invite_context: + inviter_reg_status ───────────────────────────────
-- Return-type change → must drop first (create or replace can't alter the
-- OUT columns). Body is 20260524120000 plus one column: the inviter's live
-- registration status for this event (null if they no longer hold one).

drop function if exists public.get_invite_context(text);

create function public.get_invite_context(p_token text)
returns table (
  invite_id           uuid,
  invite_status       partner_invite_status,
  invitee_email       text,
  inviter_first_name  text,
  inviter_last_name   text,
  inviter_email       text,
  inviter_phone       text,
  inviter_reg_status  registration_status,
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
    (
      select er.status
        from public.event_registrations er
       where er.player_id  = pi.inviter_player_id
         and er.event_id   = pi.event_id
         and er.deleted_at is null
         and er.status not in ('cancelled', 'withdrawn', 'refunded')
       order by er.registered_at desc
       limit 1
    ),
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

comment on function public.get_invite_context(text) is
  'Anon-readable context for a partner-invite token: invite + inviter + event + '
  'tournament basics, plus the inviter''s current registration status so the '
  'accept page can waitlist the invitee next to a waitlisted inviter.';

grant execute on function public.get_invite_context(text) to anon, authenticated;
