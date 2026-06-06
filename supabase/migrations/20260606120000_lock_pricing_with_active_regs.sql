-- 20260606120000_lock_pricing_with_active_regs.sql
--
-- Server-side guard for issue #16: reject replace_pricing_tiers if any
-- paid or pending_payment event_registrations exist for the tournament.
--
-- The client already locks the pricing editor in that state; this guard
-- closes the stale-browser-tab window where someone could submit the
-- form before the client-side check has kicked in.
--
-- Replaces replace_pricing_tiers in-place (create or replace). All
-- other behaviour is unchanged; the only addition is the early-exit
-- check before the DELETE/INSERT loop.

set search_path = public;

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

  -- Reject the change if any registration has already committed money.
  -- The client locks the UI in this state too, but this guard closes
  -- the stale-tab window.
  if exists (
    select 1
      from public.event_registrations er
      join public.events e on e.id = er.event_id
     where e.tournament_id = p_tournament_id
       and e.deleted_at is null
       and er.status in ('paid', 'pending_payment')
       and er.deleted_at is null
  ) then
    raise exception 'pricing_locked'
      using
        message = 'Pricing is locked — the tournament has active registrations. Cancel and refund affected players first.',
        errcode = 'P0001';
  end if;

  -- Clear the existing set (subject to the caller's RLS — a
  -- non-admin's DELETE matches zero rows and the subsequent INSERTs
  -- fail the WITH CHECK, so this is safe under SECURITY INVOKER).
  delete from public.tournament_pricing_tiers
   where tournament_id = p_tournament_id;

  for tier in select * from jsonb_array_elements(p_tiers)
  loop
    idx := idx + 1;
    insert into public.tournament_pricing_tiers (
      tournament_id, sort_order, label, starts_at, ends_at,
      first_event_fee_cents, additional_event_fee_cents
    ) values (
      p_tournament_id,
      idx,
      coalesce(nullif(trim(tier->>'label'), ''), 'Tier ' || idx),
      nullif(tier->>'starts_at', '')::timestamptz,
      nullif(tier->>'ends_at', '')::timestamptz,
      coalesce((tier->>'first_event_fee_cents')::int, 0),
      coalesce((tier->>'additional_event_fee_cents')::int, 0)
    );
  end loop;
end;
$$;

comment on function public.replace_pricing_tiers(uuid, jsonb) is
  'Atomically replace a tournament''s pricing tier set. Raises pricing_locked if paid/pending_payment registrations exist. p_tiers is a JSON array of {label, starts_at, ends_at, first_event_fee_cents, additional_event_fee_cents} in display order; sort_order is assigned 1-based from position. SECURITY INVOKER — RLS gates the write to org admins.';
