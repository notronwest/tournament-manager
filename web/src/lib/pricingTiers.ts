// Pricing-tier helpers.
//
// A tournament's pricing is stored as an ordered list of tiers in
// the tournament_pricing_tiers table. At any given instant exactly
// one tier is "active" — that's the price a player commits to if
// they checkout right now.
//
// Tier-window semantics (from migration 20260526170000):
//   starts_at NULL = "from the beginning"
//   ends_at   NULL = "until registration closes"
//   ends_at is EXCLUSIVE  →  active range = [starts_at, ends_at)
//
// The DB ships a `current_pricing_tier(tournament_id, as_of)` SQL
// helper that returns the active tier — useful for server-side
// (RLS policies, RPCs, edge functions). On the client we usually
// load all tiers alongside the tournament and pick locally, so
// these helpers exist to keep the boundary semantics in one place.

import type { Database } from "../types/supabase";

export type PricingTier =
  Database["public"]["Tables"]["tournament_pricing_tiers"]["Row"];

export type PricingPattern =
  Database["public"]["Enums"]["pricing_pattern"];

/**
 * Pick the tier whose window covers `asOf` (default: now).
 *
 * Returns null if no tier covers the instant — shouldn't happen
 * given the save flow keeps adjacent tier boundaries matched, but
 * defined nullable so callers can render a sane fallback rather
 * than crash.
 */
export function pickActivePricingTier(
  tiers: PricingTier[],
  asOf: Date = new Date(),
): PricingTier | null {
  if (tiers.length === 0) return null;
  const sorted = [...tiers].sort((a, b) => a.sort_order - b.sort_order);
  const at = asOf.getTime();
  for (const t of sorted) {
    const starts = t.starts_at ? new Date(t.starts_at).getTime() : -Infinity;
    const ends = t.ends_at ? new Date(t.ends_at).getTime() : Infinity;
    if (starts <= at && at < ends) return t;
  }
  return null;
}

/**
 * Pick the tier that comes AFTER the currently-active one (or
 * null if the active tier is the last). Used to render countdowns
 * like "Early bird ends in 4 days — Regular pricing starts Jun 16."
 */
export function pickNextPricingTier(
  tiers: PricingTier[],
  asOf: Date = new Date(),
): PricingTier | null {
  if (tiers.length === 0) return null;
  const sorted = [...tiers].sort((a, b) => a.sort_order - b.sort_order);
  const at = asOf.getTime();
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const starts = t.starts_at ? new Date(t.starts_at).getTime() : -Infinity;
    const ends = t.ends_at ? new Date(t.ends_at).getTime() : Infinity;
    if (starts <= at && at < ends) {
      return sorted[i + 1] ?? null;
    }
  }
  return null;
}
