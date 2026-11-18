-- Restore guardian (family) checkout to compute_checkout_total.
--
-- ─── The regression ─────────────────────────────────────────────────
--
-- 20261027120000_guardian_registrations widened compute_checkout_total so a
-- guardian's basket includes their active dependents' unpaid registrations
-- (#1169) and counted waitlisted_pending_payment (pay-to-claim).
--
-- 20261107100000_override_does_not_consume_first_event then re-created the
-- function from the PRE-guardian body to fix override ranking. Because it
-- applied later, it silently dropped:
--   * the dependents loop — a parent paying for a child gets an empty basket,
--     so create-payment-intent returns nothing_to_charge and checkout shows
--     "There's nothing to pay for — your cart looks empty." while the page
--     (which still builds the family basket client-side) shows the real price;
--   * waitlisted_pending_payment — a promoted waitlister's pay-to-claim
--     total came back without their reserved spot;
--   * the player_id key on each line item.
--
-- Reported 2026-11-17: a parent registering their child for Kids 18 & Under
-- Doubles ($35 override) saw the empty-cart error on Pay.
--
-- ─── The fix ────────────────────────────────────────────────────────
--
-- The guardian body, verbatim, with the 20261107 ranking fix applied inside
-- the per-entrant loop. Both behaviours now live in one definition. Anyone
-- editing this function again: start from THIS body.

set search_path = public;

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
  v_person       record;
  r              record;
begin
  select * into v_tier from public.current_pricing_tier(p_tournament_id, now());
  if found then
    v_first    := coalesce(v_tier.first_event_fee_cents, 0);
    v_add      := coalesce(v_tier.additional_event_fee_cents, 0);
    v_included := greatest(coalesce(v_tier.first_events_included, 1), 1);
  end if;

  -- The payer first, then each active dependent, so the payer's own events
  -- head the basket and the line-item order is stable.
  for v_person in
    select p_player_id as player_id, true as is_payer, null::text as display_name
    union all
    select g.dependent_player_id,
           false,
           nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
      from player_guardians g
      join players p on p.id = g.dependent_player_id
     where g.guardian_player_id = p_player_id
       and g.deleted_at is null
       and p.deleted_at is null
       and p.auth_user_id is null
    order by is_payer desc, display_name
  loop
    -- Each entrant's tiering is their own, so the "has this person already
    -- paid for something in this tournament?" question is asked per person.
    select exists (
      select 1
        from public.event_registrations er
        join public.events e on e.id = er.event_id
       where e.tournament_id = p_tournament_id
         and er.player_id = v_person.player_id
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
           and er.player_id = v_person.player_id
           and er.status in ('pending_payment', 'waitlisted_pending_payment')
           and er.deleted_at is null
           and e.deleted_at is null
      )
      select reg_id, event_id, event_name, override_cents, full_price,
             -- Rank ONLY the non-override picks (20261107100000): an override
             -- sits outside the entry-fee ordering, so it can't take the
             -- rn = 1 slot and leave the first-event fee uncharged.
             case
               when override_cents > 0 then null
               else row_number() over (
                      partition by (override_cents > 0)
                      order by full_price desc, reg_id)
             end as rn
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
          'player_id', v_person.player_id,
          -- A dependent's row is named on the receipt; the payer's is not, so
          -- a solo checkout reads exactly as it did before.
          'description', case
                           when v_person.is_payer or v_person.display_name is null
                             then r.event_name
                           else r.event_name || ' — ' || v_person.display_name
                         end,
          'amount_cents', v_amount,
          'tier', v_label
        );
      end;
    end loop;
  end loop;

  return jsonb_build_object('total_cents', v_total, 'line_items', v_items);
end;
$$;

comment on function public.compute_checkout_total(uuid, uuid) is
  'Authoritative checkout total + line items for a player''s unpaid regs '
  '(pending_payment + waitlisted_pending_payment) in a tournament, AND those of '
  'their active dependents (#1169) — a guardian pays the family basket in one '
  'charge. Pricing tiers are computed per entrant, so a dependent gets their own '
  'first-event rate. Entry fee covers the first N (first_events_included) events; '
  'picks beyond N get the additional rate. Per-event-fee (override) picks are '
  'charged their flat fee and EXCLUDED from the first-event ranking. Mirrors '
  'computeLineItems() in web/src/lib/pricing.ts — change both together. '
  'SECURITY DEFINER, service_role only (Stripe edge function).';

-- Re-assert the server-only grants. create-or-replace keeps existing grants,
-- but 20261011110000_server_only_functions_revoke_client_roles.sql runs an
-- assertion on every apply that raises if this function is executable by anon
-- or authenticated, so the revoke is restated here rather than assumed.
revoke all on function public.compute_checkout_total(uuid, uuid) from public, anon, authenticated;
grant execute on function public.compute_checkout_total(uuid, uuid) to service_role;
