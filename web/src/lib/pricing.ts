// web/src/lib/pricing.ts
//
// Centralized pricing logic for tournament registration. Shared
// between the public tournament page (which displays per-event
// indicative prices) and the register page (which computes the
// running total based on what the user has selected).
//
// See supabase/migrations/20260524180000_additional_event_fee.sql
// for the data-model side. Short version: each event either has a
// per-event override (event_fee_cents > 0, flat charge) or uses
// the tournament's two-tier defaults (entry_fee_cents for the
// first event, additional_event_fee_cents for each subsequent one).
//
// The "first" event is whichever picked event would have the
// highest stand-alone fee — that ordering hands the player the
// best deal across their picks, which matches what
// PickleballBrackets does and matches what most players would do
// in their heads.

import type { Database } from "../types/supabase";

type Tournament = Pick<
  Database["public"]["Tables"]["tournaments"]["Row"],
  "entry_fee_cents" | "additional_event_fee_cents"
>;
type Event = Pick<
  Database["public"]["Tables"]["events"]["Row"],
  "id" | "event_fee_cents"
>;

/**
 * What an individual event would cost in two scenarios:
 *   * fullPrice       — if this were the player's only / "first" pick
 *   * additionalPrice — if this were a later pick (gets the
 *                       additional-event rate, unless overridden)
 *
 * For an event with a per-event override, full === additional ===
 * override. The override is a flat charge that ignores ordering.
 */
export function priceTiers(
  ev: Event,
  tournament: Tournament,
): { fullPrice: number; additionalPrice: number } {
  if (ev.event_fee_cents > 0) {
    return {
      fullPrice: ev.event_fee_cents,
      additionalPrice: ev.event_fee_cents,
    };
  }
  return {
    fullPrice: tournament.entry_fee_cents,
    additionalPrice: tournament.additional_event_fee_cents,
  };
}

export type LineItem = {
  event: Event;
  cents: number;
  // Which tier was charged. "override" for per-event-fee events,
  // "first" for the priciest non-override pick, "additional" for
  // every other non-override pick.
  tier: "override" | "first" | "additional";
};

/**
 * Compute the running total + per-event line items for a set of
 * selected events. Ordering is by stand-alone fullPrice DESC, so
 * the player always pays their highest fee at the "first event"
 * rate and gets the additional-event rate on everything else.
 *
 * Returns line items in the order the caller passed them in (not
 * sorted), so a UI rendering them inline next to their event row
 * doesn't get reshuffled. Tier classification reflects the
 * internal sort, not the input order.
 */
export function computeLineItems(
  selectedEvents: Event[],
  tournament: Tournament,
): { items: LineItem[]; totalCents: number } {
  if (selectedEvents.length === 0) {
    return { items: [], totalCents: 0 };
  }

  // Pair each event with its tiers, sort a copy by fullPrice DESC
  // (stable on ties — we don't care which of two equal-priced
  // events gets the "first" label since the cents are identical).
  const tagged = selectedEvents.map((ev) => ({
    ev,
    tiers: priceTiers(ev, tournament),
  }));
  const sortedDesc = [...tagged].sort(
    (a, b) => b.tiers.fullPrice - a.tiers.fullPrice,
  );

  // Classify each event's tier by where it fell in the sort.
  // Overrides keep their own "override" label regardless.
  const tierByEventId = new Map<string, LineItem["tier"]>();
  sortedDesc.forEach((t, i) => {
    const hasOverride = t.ev.event_fee_cents > 0;
    if (hasOverride) {
      tierByEventId.set(t.ev.id, "override");
    } else if (i === 0) {
      tierByEventId.set(t.ev.id, "first");
    } else {
      tierByEventId.set(t.ev.id, "additional");
    }
  });

  // Build line items in the caller's order, with the charged
  // amount derived from the tier.
  const items: LineItem[] = tagged.map(({ ev, tiers }) => {
    const tier = tierByEventId.get(ev.id) ?? "additional";
    const cents =
      tier === "first"
        ? tiers.fullPrice
        : tier === "additional"
          ? tiers.additionalPrice
          : ev.event_fee_cents; // override
    return { event: ev, cents, tier };
  });

  const totalCents = items.reduce((sum, item) => sum + item.cents, 0);
  return { items, totalCents };
}

/** Format cents as a USD string. Convenience used in several pages. */
export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
