-- 20260608140000_compute_checkout_total.sql
--
-- Server-side authoritative checkout total for #20 (Card A). Mirrors
-- web/src/lib/pricing.ts (computeLineItems) exactly so the amount the
-- Stripe edge function charges equals what the client showed.
--
-- Pricing model (tier-based; tournaments.entry_fee_cents was dropped in
-- 20260529160000):
--   * The active pricing tier (current_pricing_tier) supplies the
--     first-event fee and additional-event fee.
--   * An event with event_fee_cents > 0 is a flat OVERRIDE (ignores
--     tiering).
--   * Of the player's pending picks, the single highest stand-alone
--     price gets the "first" (entry-inclusive) rate; every other
--     non-override pick gets the "additional" rate. If that highest
--     pick is itself an override, NO pick gets the first rate (matches
--     the client's `i === 0` rule).
--   * If the player already has a PAID reg in this tournament, the
--     first-event rate is not applied — everything is additional
--     (the entry fee was already collected).
--
-- SECURITY DEFINER, service_role only: called by the create-payment-intent
-- edge function. Not exposed to clients (the UI computes its own preview
-- via pricing.ts and must display the server total before confirming).
--
-- Returns: { total_cents, line_items: [{ event_registration_id,
-- event_id, description, amount_cents, tier }] }.
--
-- KNOWN EDGE: when an override fee exactly equals the first-event fee
-- AND both are picked together, the order in which "first" is assigned
-- can shift the total vs the client (the client uses input order, this
-- uses full_price DESC then reg id). The server value is authoritative;
-- Card B must display the server total. Normal baskets (no override, or
-- override clearly above/below the tier fee) match the client exactly.

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
  v_tier        public.tournament_pricing_tiers;
  v_first       integer := 0;
  v_add         integer := 0;
  v_already_paid boolean := false;
  v_items       jsonb := '[]'::jsonb;
  v_total       integer := 0;
  r             record;
begin
  -- Active pricing tier (NULL → both rates 0).
  select * into v_tier from public.current_pricing_tier(p_tournament_id, now());
  if found then
    v_first := coalesce(v_tier.first_event_fee_cents, 0);
    v_add   := coalesce(v_tier.additional_event_fee_cents, 0);
  end if;

  -- Already has a paid reg in this tournament? → no first-event rate.
  select exists (
    select 1
      from public.event_registrations er
      join public.events e on e.id = er.event_id
     where e.tournament_id = p_tournament_id
       and er.player_id = p_player_id
       and er.status = 'paid'
       and er.deleted_at is null
  ) into v_already_paid;

  -- Walk the pending picks ranked by stand-alone price DESC.
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
         and er.status = 'pending_payment'
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
  'Authoritative checkout total + line items for a player''s pending_payment regs in a tournament. Mirrors web/src/lib/pricing.ts. SECURITY DEFINER, service_role only (Stripe edge function).';

revoke all on function public.compute_checkout_total(uuid, uuid) from public, anon, authenticated;
grant execute on function public.compute_checkout_total(uuid, uuid) to service_role;
