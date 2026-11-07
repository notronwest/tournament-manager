-- A per-event fee must not consume the tournament's first-event slot.
--
-- ─── The defect ─────────────────────────────────────────────────────
--
-- An event with events.event_fee_cents > 0 carries a flat "override" charge
-- that replaces the active pricing tier for that one event. The intended use,
-- per the column comment added in 20260524180000, is a premium division.
--
-- compute_checkout_total ranked ALL of a player's pending picks together:
--
--     row_number() over (order by full_price desc, reg_id)  as rn
--     ...
--     if override_cents > 0    then 'override'
--     elsif rn = 1  and not paid then 'first'
--     elsif rn <= included ...   then 'included'
--     else                          'additional'
--
-- An override whose own fee is HIGHER than the tier's first-event fee sorts to
-- rn = 1 and is then labelled 'override'. The `rn = 1` branch is thereafter
-- unreachable for every other pick, so NO line item is charged the first-event
-- (entry) fee. The tournament's entry fee silently stops being collected.
--
-- Measured against a tier of first $50.00 / additional $20.00:
--
--   premium $90 + 1 adult bracket   charged $110.00, should be $140.00
--   premium $90 + 2 adult brackets  charged $130.00, should be $160.00
--   adult + adult (no override)     charged  $70.00, correct
--   kids $25 + adult (override
--     BELOW the tier's first fee)   charged  $75.00, correct
--
-- The leak is exactly the gap between the first-event and additional-event
-- fee, and it fires only when an override is priced ABOVE the first-event fee.
-- An override priced below it (the kids-bracket case) already prices correctly
-- and must not regress.
--
-- Nothing in production was ever mischarged: the only event with its own fee
-- is the Loon Race Team tournament's "Kids 18 & Under Doubles" at $35.00
-- against first-event tiers of $55.00 and $45.00, and no payment line item
-- references it. This is a correctness fix, not an incident.
--
-- ─── The fix ────────────────────────────────────────────────────────
--
-- Rank only the NON-override picks, and classify those by their rank among
-- themselves. Override picks keep their flat fee and sit outside the ranking
-- entirely, so exactly one tier-priced pick is still charged the entry fee.
--
-- `partition by (override_cents > 0)` splits the window into an override
-- partition and a non-override partition; row_number restarts at 1 inside
-- each, so a non-override pick's rn is its rank among non-overrides. The rn
-- computed for an override row is never read — the override branch is tested
-- first — but it is nulled out so a future reader cannot mistake it for a
-- position in the entry-fee ordering.
--
-- Everything else about the function is preserved deliberately: the signature,
-- security definer, the search_path pin, the jsonb shape (total_cents +
-- line_items with event_registration_id / event_id / description /
-- amount_cents / tier), the alreadyHasPaidEvent suppression, and the
-- rn <= v_included "included events" rule from 20260815130000.
--
-- web/src/lib/pricing.ts carries the same rule for the checkout screen and
-- MUST mirror this function. It is changed in the same piece of work.

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
         and er.status = 'pending_payment'
         and er.deleted_at is null
         and e.deleted_at is null
    )
    select reg_id, event_id, event_name, override_cents, full_price,
           -- Rank ONLY the non-override picks. An override sits outside the
           -- entry-fee ordering, so it can no longer take the rn = 1 slot and
           -- leave the first-event fee uncharged.
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
  'Server-side checkout total for a player''s pending event registrations. '
  'Returns {total_cents, line_items[]} with each line tiered as override / '
  'first / included / additional. Per-event-fee (override) picks are charged '
  'their flat fee and are EXCLUDED from the first-event ranking, so exactly '
  'one tier-priced pick still pays the entry fee. Mirrors '
  'computeLineItems() in web/src/lib/pricing.ts — change both together.';
