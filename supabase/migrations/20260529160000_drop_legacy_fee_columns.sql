-- 20260529160000_drop_legacy_fee_columns.sql
--
-- Slice 6 cleanup: retire the legacy single-tier fee columns now that
-- pricing lives entirely in tournament_pricing_tiers and every read
-- path reads the active tier.
--
-- History of these columns:
--   * tournaments.entry_fee_cents          (init schema — "first event" fee)
--   * tournaments.additional_event_fee_cents (20260524180000 — additional)
-- After 20260526170000 introduced the pricing-tiers model, these
-- became a write-only mirror of tier 1, kept in sync by the forward
-- triggers added in 20260526170001 so read sites that hadn't yet
-- migrated stayed accurate. Slice 5 migrated every read site to the
-- tiers, and slice 6 removed the mirror-write from TournamentFormPage.
-- Nothing reads or writes these columns anymore, so drop them along
-- with the now-pointless sync triggers + their functions.
--
-- Tournament creation no longer relies on the INSERT trigger to seed
-- a tier: TournamentFormPage writes the real tiers via the
-- replace_pricing_tiers RPC right after inserting the tournament.
--
-- The CHECK constraints on these columns (entry_fee_cents >= 0,
-- additional_event_fee_cents >= 0) drop automatically with the columns.

set search_path = public;

-- Triggers first (they reference the columns), then their functions.
drop trigger if exists tournaments_create_single_tier on public.tournaments;
drop trigger if exists tournaments_sync_single_tier on public.tournaments;

drop function if exists public.create_single_tier_on_tournament_insert();
drop function if exists public.sync_single_tier_on_tournament_update();

-- Then the columns.
alter table public.tournaments
  drop column if exists entry_fee_cents,
  drop column if exists additional_event_fee_cents;
