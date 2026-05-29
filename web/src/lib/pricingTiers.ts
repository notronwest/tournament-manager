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
import { formatUsd } from "./pricing";

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

// Group a flat list of tier rows (e.g. from one `.in("tournament_id",
// ids)` query) into a per-tournament map. Used by list/home pages
// that show many tournaments and want to batch-load tiers in one
// round-trip instead of N+1.
export function groupTiersByTournament(
  rows: PricingTier[],
): Map<string, PricingTier[]> {
  const m = new Map<string, PricingTier[]>();
  for (const r of rows) {
    const arr = m.get(r.tournament_id);
    if (arr) arr.push(r);
    else m.set(r.tournament_id, [r]);
  }
  return m;
}

// Compact price label for list / detail / home displays. Shows the
// active tier's first-event fee; when the tournament has more than
// one tier, appends the active tier's label so "Early bird" pricing
// is distinguishable from the regular price at a glance. Falls back
// to the first tier if no window is currently active.
export function compactTierPriceLabel(tiers: PricingTier[]): string {
  if (tiers.length === 0) return "—";
  const active =
    pickActivePricingTier(tiers) ??
    [...tiers].sort((a, b) => a.sort_order - b.sort_order)[0];
  const base =
    active.first_event_fee_cents === 0
      ? "Free"
      : formatUsd(active.first_event_fee_cents);
  return tiers.length > 1 ? `${base} · ${active.label}` : base;
}

// ─────────────────────────────────────────────────────────────────────
// Public lifecycle status — the OTHER surface of the tier dates.
//
// "One concept, two surfaces": the same tier windows that decide what
// a player pays also decide the public registration-status label.
// This derives that label from the registration window + the active
// tier, so the public page shows "Early Bird Registration Open" /
// "Registration Open" / "Late Registration Open" without the
// organizer managing a separate status flag.
// ─────────────────────────────────────────────────────────────────────

export type RegistrationStatusTone = "open" | "soon" | "closed";

export type RegistrationStatus = {
  // The headline label, e.g. "Early Bird Registration Open".
  label: string;
  tone: RegistrationStatusTone;
};

// Minimal tournament shape this needs. Kept loose so callers can pass
// either a full row or a projection.
type StatusTournament = {
  status: Database["public"]["Enums"]["tournament_status"];
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  pricing_pattern: PricingPattern;
};

// Map an active preset/custom tier to its lifecycle phrase. Presets
// (early_bird / early_bird_plus_late) have fixed labels we match on;
// Custom uses the organizer's literal tier name since we don't know
// its intended semantics.
function tierPhase(
  pattern: PricingPattern,
  activeTier: PricingTier | null,
): string {
  if (pattern === "single" || !activeTier) return "Registration Open";
  if (pattern === "custom") {
    return `${activeTier.label} — Registration Open`;
  }
  const label = activeTier.label.toLowerCase();
  if (label.includes("early")) return "Early Bird Registration Open";
  if (label.includes("late")) return "Late Registration Open";
  return "Registration Open";
}

export function deriveRegistrationStatus(
  t: StatusTournament,
  tiers: PricingTier[],
  now: Date = new Date(),
): RegistrationStatus {
  if (t.status === "completed") return { label: "Completed", tone: "closed" };
  if (t.status === "cancelled") return { label: "Cancelled", tone: "closed" };
  if (t.status === "closed") {
    return { label: "Registration Closed", tone: "closed" };
  }
  if (t.status === "draft") return { label: "Draft", tone: "closed" };

  // status === 'published'
  const opensAt = t.registration_opens_at
    ? new Date(t.registration_opens_at)
    : null;
  const closesAt = t.registration_closes_at
    ? new Date(t.registration_closes_at)
    : null;

  if (opensAt && opensAt > now) {
    return { label: "Registration Opens Soon", tone: "soon" };
  }
  if (closesAt && closesAt <= now) {
    return { label: "Registration Closed", tone: "closed" };
  }

  // Registration is open — phase by the active pricing tier.
  const activeTier = pickActivePricingTier(tiers, now);
  return { label: tierPhase(t.pricing_pattern, activeTier), tone: "open" };
}

// ─────────────────────────────────────────────────────────────────────
// Admin pricing-editor helpers — form-draft ↔ DB-row conversion.
//
// The editor (PricingTiersEditor) works with a friendlier draft
// shape than the DB: dollars-as-strings (so typing "12.5" doesn't
// fight a number input), and a single "through" date per tier
// instead of explicit starts_at/ends_at windows. Adjacent tiers
// share a boundary — tier N's "through" date IS tier N+1's start —
// so the organizer only sets one date per gap. The first tier has
// an implicit open start; the last tier has an implicit open end.
// ─────────────────────────────────────────────────────────────────────

// A tier as the form holds it while the organizer edits.
export type TierDraft = {
  // Stable client-only id for React keys + add/remove tracking.
  key: string;
  label: string;
  // The inclusive "through" date for this tier, as a local date
  // string (YYYY-MM-DD). Empty = open-ended. Only the LAST tier is
  // allowed to be open-ended; the editor enforces that.
  endsOn: string;
  firstEventFeeDollars: string;
  additionalEventFeeDollars: string;
};

// A DB-ready tier row for the replace_pricing_tiers RPC.
export type TierInsert = {
  label: string;
  starts_at: string | null;
  ends_at: string | null;
  first_event_fee_cents: number;
  additional_event_fee_cents: number;
};

// How many tiers each preset pattern uses, and their fixed labels.
// Custom is open-ended (any count, editable labels) so it's absent
// here.
const PRESET_LABELS: Record<
  Exclude<PricingPattern, "custom">,
  string[]
> = {
  single: ["Standard"],
  early_bird: ["Early bird", "Regular"],
  early_bird_plus_late: ["Early bird", "Regular", "Late fee"],
};

let draftKeySeq = 0;
function nextDraftKey(): string {
  draftKeySeq += 1;
  return `tier-${draftKeySeq}`;
}

export function makeEmptyTierDraft(label = ""): TierDraft {
  return {
    key: nextDraftKey(),
    label,
    endsOn: "",
    firstEventFeeDollars: "0",
    additionalEventFeeDollars: "0",
  };
}

// Reshape the current draft list to fit a newly-chosen pattern,
// preserving fee values (and dates) by index where the slot survives.
// Switching to a preset rewrites labels to the preset's fixed names;
// switching to Custom keeps whatever's there (seeding two tiers if
// the list was a single tier, so there's something to edit).
export function defaultTiersForPattern(
  pattern: PricingPattern,
  existing: TierDraft[],
): TierDraft[] {
  if (pattern === "custom") {
    if (existing.length >= 2) return existing;
    // Seed from the single existing tier (keep its fees) + a blank
    // second tier so the organizer has a gap to date.
    const first = existing[0] ?? makeEmptyTierDraft("Tier 1");
    return [
      { ...first, label: first.label || "Tier 1" },
      makeEmptyTierDraft("Tier 2"),
    ];
  }

  const labels = PRESET_LABELS[pattern];
  return labels.map((label, i) => {
    const prev = existing[i];
    return {
      key: prev?.key ?? nextDraftKey(),
      label,
      // The last preset tier is open-ended; earlier ones keep any
      // date the organizer already set.
      endsOn: i === labels.length - 1 ? "" : (prev?.endsOn ?? ""),
      firstEventFeeDollars: prev?.firstEventFeeDollars ?? "0",
      additionalEventFeeDollars: prev?.additionalEventFeeDollars ?? "0",
    };
  });
}

// Convert a loaded DB tier set (edit mode) back into form drafts.
export function tiersToDrafts(tiers: PricingTier[]): TierDraft[] {
  const sorted = [...tiers].sort((a, b) => a.sort_order - b.sort_order);
  return sorted.map((t) => ({
    key: nextDraftKey(),
    label: t.label,
    endsOn: endsAtIsoToThroughDate(t.ends_at),
    firstEventFeeDollars: (t.first_event_fee_cents / 100).toFixed(2),
    additionalEventFeeDollars: (t.additional_event_fee_cents / 100).toFixed(2),
  }));
}

// "through Jun 15" → ends_at = local midnight at the START of Jun 16.
// The next tier's starts_at is set equal to this, so the windows are
// contiguous and half-open: tier 1 is active [.., Jun16 00:00) and
// tier 2 is active [Jun16 00:00, ..).
export function throughDateToEndsAtIso(throughDate: string): string | null {
  if (!throughDate) return null;
  const d = new Date(`${throughDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

// Inverse: ends_at ISO → the inclusive "through" date (local YYYY-MM-DD).
export function endsAtIsoToThroughDate(endsAtIso: string | null): string {
  if (!endsAtIso) return "";
  const d = new Date(endsAtIso);
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() - 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Validate + convert the form drafts into DB-ready rows. Returns
// either { rows } or { error } — the caller surfaces the error and
// blocks save. Computes contiguous half-open windows from the
// per-tier "through" dates.
export function tierDraftsToInserts(
  tiers: TierDraft[],
): { rows: TierInsert[]; error: null } | { rows: null; error: string } {
  if (tiers.length === 0) {
    return { rows: null, error: "At least one pricing tier is required." };
  }

  // Parse fees + validate each row.
  const parsed = tiers.map((t, i) => {
    const first = Math.round(parseFloat(t.firstEventFeeDollars || "0") * 100);
    const additional = Math.round(
      parseFloat(t.additionalEventFeeDollars || "0") * 100,
    );
    return { t, i, first, additional };
  });

  for (const { t, i, first, additional } of parsed) {
    const label = t.label.trim() || `Tier ${i + 1}`;
    if (Number.isNaN(first) || first < 0) {
      return {
        rows: null,
        error: `${label}: first-event fee must be a non-negative number.`,
      };
    }
    if (Number.isNaN(additional) || additional < 0) {
      return {
        rows: null,
        error: `${label}: additional-event fee must be a non-negative number.`,
      };
    }
    // Every tier except the last needs a "through" date to define
    // where it hands off to the next.
    const isLast = i === tiers.length - 1;
    if (!isLast && !t.endsOn) {
      return {
        rows: null,
        error: `${label}: set the date this price runs through (the next tier starts the day after).`,
      };
    }
    if (isLast && t.endsOn) {
      return {
        rows: null,
        error: `${label}: the last tier runs until registration closes — it can't have an end date.`,
      };
    }
  }

  // Build contiguous windows. tier[i].ends_at = throughDate(i)+1day;
  // tier[i+1].starts_at = tier[i].ends_at. First start + last end null.
  const rows: TierInsert[] = [];
  let prevEnd: string | null = null;
  for (const { t, i, first, additional } of parsed) {
    const isLast = i === tiers.length - 1;
    const endsAt = isLast ? null : throughDateToEndsAtIso(t.endsOn);
    if (!isLast && !endsAt) {
      return {
        rows: null,
        error: `${t.label.trim() || `Tier ${i + 1}`}: invalid date.`,
      };
    }
    rows.push({
      label: t.label.trim() || `Tier ${i + 1}`,
      starts_at: prevEnd,
      ends_at: endsAt,
      first_event_fee_cents: first,
      additional_event_fee_cents: additional,
    });
    prevEnd = endsAt;
  }

  // Dates must be strictly increasing — a later tier can't start
  // before an earlier one ends. (Contiguity guarantees starts match
  // prior ends; this catches a non-monotonic date entry.)
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].ends_at;
    const curEnd = rows[i].ends_at;
    if (prev && curEnd && new Date(curEnd).getTime() <= new Date(prev).getTime()) {
      return {
        rows: null,
        error: `${rows[i].label}: each tier's date must be later than the one before it.`,
      };
    }
  }

  return { rows, error: null };
}
