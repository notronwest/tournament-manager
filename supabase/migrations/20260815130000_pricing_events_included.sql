-- ─────────────────────────────────────────────────────────────────────
-- Pricing: let the entry fee include the first N events (not just 1).
--
-- Adds first_events_included to tournament_pricing_tiers (DEFAULT 1 = today's
-- behavior: the entry fee includes the 1st event). When N > 1 the entry fee
-- covers the first N events (events 2..N are $0 / included); every event
-- BEYOND the Nth is charged the additional-event fee.
--
-- The charge math lives in two mirrored places — this file's
-- compute_checkout_total (authoritative; what Stripe charges) and
-- web/src/lib/pricing.ts (the client preview). They MUST stay identical.
-- ─────────────────────────────────────────────────────────────────────

set search_path = public;

alter table public.tournament_pricing_tiers
  add column if not exists first_events_included integer not null default 1
    check (first_events_included >= 1);

-- ── replace_pricing_tiers: carry first_events_included through the upsert ──
create or replace function public.replace_pricing_tiers(
  p_tournament_id uuid,
  p_tiers jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  tier jsonb;
  idx  smallint := 0;
begin
  if jsonb_typeof(p_tiers) <> 'array' then
    raise exception 'p_tiers must be a JSON array, got %', jsonb_typeof(p_tiers);
  end if;

  delete from public.tournament_pricing_tiers
   where tournament_id = p_tournament_id;

  for tier in select * from jsonb_array_elements(p_tiers)
  loop
    idx := idx + 1;
    insert into public.tournament_pricing_tiers (
      tournament_id, sort_order, label, starts_at, ends_at,
      first_event_fee_cents, additional_event_fee_cents, first_events_included
    ) values (
      p_tournament_id,
      idx,
      coalesce(nullif(trim(tier->>'label'), ''), 'Tier ' || idx),
      nullif(tier->>'starts_at', '')::timestamptz,
      nullif(tier->>'ends_at', '')::timestamptz,
      coalesce((tier->>'first_event_fee_cents')::int, 0),
      coalesce((tier->>'additional_event_fee_cents')::int, 0),
      greatest(coalesce((tier->>'first_events_included')::int, 1), 1)
    );
  end loop;
end;
$$;

comment on function public.replace_pricing_tiers(uuid, jsonb) is
  'Atomically replace a tournament''s pricing tier set. p_tiers is a JSON array of {label, starts_at, ends_at, first_event_fee_cents, additional_event_fee_cents, first_events_included} in display order; sort_order is assigned 1-based from position. SECURITY INVOKER — RLS gates the write to org admins.';

-- ── compute_checkout_total: entry fee covers the first N events ──
-- Same as before, plus: after the single "first" pick, picks ranked 2..N (up
-- to first_events_included) are $0 'included'; picks beyond N get 'additional'.
-- Overrides and the already-paid short-circuit are unchanged.
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
  'Authoritative checkout total + line items for a player''s pending_payment regs in a tournament. Entry fee covers the first N (first_events_included) events; picks beyond N get the additional rate. Mirrors web/src/lib/pricing.ts. SECURITY DEFINER, service_role only (Stripe edge function).';

revoke all on function public.compute_checkout_total(uuid, uuid) from public, anon, authenticated;
grant execute on function public.compute_checkout_total(uuid, uuid) to service_role;
