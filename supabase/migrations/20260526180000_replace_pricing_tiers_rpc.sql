-- 20260526180000_replace_pricing_tiers_rpc.sql
--
-- Atomic "replace the whole tier set" RPC for the pricing editor.
--
-- The admin pricing editor (TournamentFormPage) edits a tournament's
-- tiers as a set: the organizer picks a pattern (Single / Early bird
-- / Early bird + Late fee / Custom) and lays out N tier rows. On
-- save we want to replace ALL of that tournament's tiers in one shot.
--
-- Doing this client-side as DELETE-then-INSERT is non-atomic: a
-- failure between the two leaves the tournament with no tiers. This
-- RPC wraps both in a single transaction. It also sidesteps the
-- create-mode conflict where the AFTER INSERT trigger on tournaments
-- (20260526170001) auto-creates a 'Standard' tier — the DELETE here
-- clears that placeholder before inserting the real set.
--
-- SECURITY INVOKER: the DELETE + INSERTs run with the caller's
-- privileges, so the existing "pricing tiers write by org admins"
-- RLS policy still gates the write. A non-admin can't replace tiers
-- for a tournament they don't administer.
--
-- p_tiers shape — a JSON array, in display order:
--   [
--     { "label": "Early bird",
--       "starts_at": null,                       -- ISO string or null
--       "ends_at": "2026-06-16T04:00:00.000Z",   -- ISO string or null
--       "first_event_fee_cents": 5000,
--       "additional_event_fee_cents": 1500 },
--     ...
--   ]
-- sort_order is assigned from array position (1-based), so the
-- client doesn't have to manage it.

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
  'Atomically replace a tournament''s pricing tier set. p_tiers is a JSON array of {label, starts_at, ends_at, first_event_fee_cents, additional_event_fee_cents} in display order; sort_order is assigned 1-based from position. SECURITY INVOKER — RLS gates the write to org admins.';
