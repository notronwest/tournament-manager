// DUPR-seeded draw generation for Bert & Erne (#970 / D-0045).
//
// PickleballBrackets.com owns registration; B&E imports the players, divisions
// and partnerships and then RUNS the event. B&E does not seed by DUPR on its
// own — a generated bracket came out with every event_registrations.seed NULL.
// This module fills that gap: given a division's teams (with partner links +
// per-player ratings) it produces a deterministic seed order (1..N, seed 1 =
// strongest) that the console persists onto event_registrations.seed and that
// the existing round-robin / double-elimination generators already consume
// (buildTeams sorts by seed; doubleElim places seeds with standard byes).
//
// Pure and deterministic — no React, no Supabase — so it is unit-testable
// against synthetic fixtures (see seedTeams.test.ts).

import { parseDivisionLabel } from "./pbImport";

// Rating columns live on the PLAYER (migration
// 20260928120000_pbcom_import_source_tracking added the authoritative DUPR
// columns; player_self_ratings added the self columns). The generated
// Database types lag the DUPR columns, so this module accepts a minimal
// structural shape rather than the full Player row — callers cast.
export interface PlayerRatings {
  dupr_rating_doubles?: number | null;
  dupr_rating_singles?: number | null;
  self_rating_doubles?: number | null;
  self_rating_singles?: number | null;
  self_rating_mixed?: number | null;
}

// One entry to be seeded. For doubles a confirmed pair is ONE SeedableTeam
// (captain + partner); for singles `partner` is null. captainRegId is the
// canonical id the bracket code uses (buildTeams already picks the lower-UUID
// reg as captain), and both reg ids receive the resulting seed.
export interface SeedableTeam {
  captainRegId: string;
  partnerRegId: string | null;
  captain: PlayerRatings;
  partner: PlayerRatings | null;
}

export interface SeedDivision {
  format: "singles" | "doubles";
  // True for mixed/coed divisions — the self-rating fallback then uses
  // self_rating_mixed instead of self_rating_doubles.
  mixed: boolean;
  // Last-resort per-player rating when a player has no usable rating at all.
  // Applied uniformly, so its exact value only breaks ties among the totally
  // unrated (who then order by reg id).
  ratingFloor: number;
}

export interface SeededTeam {
  captainRegId: string;
  partnerRegId: string | null;
  seed: number; // 1..N, 1 = strongest
  strength: number; // combined effective rating — exposed for transparency/tests
}

// Sane last-resort floor for divisions with no parseable rating range
// ("Any", "Open", age brackets). Only used when a player has NO rating on any
// field, which for an imported PB.com field is rare.
export const DEFAULT_RATING_FLOOR = 3.0;

// A rating is "usable" only when present and strictly positive — PB.com
// reports 0 for "no rating", and the DB stores that as NULL, but we guard
// against a stray 0 either way.
const usable = (v: number | null | undefined): v is number =>
  typeof v === "number" && v > 0;

// Per-player effective rating. Fallback chain:
//   DOUBLES division:
//     1. dupr_rating_doubles        (authoritative DUPR, doubles)
//     2. dupr_rating_singles        (authoritative DUPR, singles)
//     3. self_rating_mixed          (mixed/coed divisions) OR
//        self_rating_doubles        (men's / women's / open doubles)
//     4. division rating floor
//   SINGLES division (singles-first):
//     1. dupr_rating_singles
//     2. dupr_rating_doubles
//     3. self_rating_singles
//     4. division rating floor
export function effectivePlayerRating(
  p: PlayerRatings,
  division: SeedDivision,
): number {
  if (division.format === "singles") {
    if (usable(p.dupr_rating_singles)) return p.dupr_rating_singles;
    if (usable(p.dupr_rating_doubles)) return p.dupr_rating_doubles;
    if (usable(p.self_rating_singles)) return p.self_rating_singles;
    return division.ratingFloor;
  }
  // doubles
  if (usable(p.dupr_rating_doubles)) return p.dupr_rating_doubles;
  if (usable(p.dupr_rating_singles)) return p.dupr_rating_singles;
  const self = division.mixed ? p.self_rating_mixed : p.self_rating_doubles;
  if (usable(self)) return self;
  return division.ratingFloor;
}

// Team strength:
//   * DOUBLES = captain effective + partner effective. An unpaired reg in a
//     doubles division is treated as captain + floor (an incomplete team ranks
//     low) so seeding never crashes on partial data — the console blocks
//     generation on unpaired teams separately.
//   * SINGLES = the player's effective rating.
export function teamStrength(team: SeedableTeam, division: SeedDivision): number {
  const cap = effectivePlayerRating(team.captain, division);
  if (division.format === "singles") return cap;
  const partner = team.partner
    ? effectivePlayerRating(team.partner, division)
    : division.ratingFloor;
  return cap + partner;
}

// Seed a division's teams by combined DUPR strength. Higher strength = better
// (lower) seed number. Ties break deterministically by captainRegId so
// re-running on the same data is stable (idempotent seeds).
export function seedTeams(
  teams: SeedableTeam[],
  division: SeedDivision,
): SeededTeam[] {
  const scored = teams.map((t) => ({
    team: t,
    strength: teamStrength(t, division),
  }));
  scored.sort(
    (a, b) =>
      b.strength - a.strength ||
      a.team.captainRegId.localeCompare(b.team.captainRegId),
  );
  return scored.map((s, i) => ({
    captainRegId: s.team.captainRegId,
    partnerRegId: s.team.partnerRegId,
    seed: i + 1,
    strength: s.strength,
  }));
}

// Derive the division context a seeding run needs from an event row. The typed
// columns (format / gender / min_rating) are authoritative; source_division_label
// is the PB.com string ("Mens Doubles Skill: (3.5 To 3.99)") we fall back to for
// the floor when min_rating is absent ("Any" / age brackets).
export interface SeedableEvent {
  format: "singles" | "doubles";
  gender: "men" | "women" | "mixed" | "open";
  min_rating?: number | null;
  source_division_label?: string | null;
}

export function divisionFromEvent(event: SeedableEvent): SeedDivision {
  return {
    format: event.format,
    mixed: event.gender === "mixed",
    ratingFloor: divisionRatingFloor(event),
  };
}

// Rating floor for the fallback chain, most-authoritative first:
//   1. events.min_rating       (the parsed division low, already backfilled)
//   2. parseDivisionLabel(label).low   ("… (3.5 To 3.99)" → 3.5)
//   3. a lone "N.N And Above / + / and up" number in the label
//   4. DEFAULT_RATING_FLOOR
export function divisionRatingFloor(event: SeedableEvent): number {
  if (usable(event.min_rating)) return event.min_rating;
  const label = event.source_division_label ?? "";
  if (label) {
    const parsed = parseDivisionLabel(label);
    if (usable(parsed.low)) return parsed.low;
    // "4.0 And Above", "4.0+", "4.0 and up" — no range, but a floor is stated.
    const above = label
      .toLowerCase()
      .match(/([\d.]+)\s*(?:\+|and\s+(?:above|up|over|higher))/);
    if (above) {
      const n = Number(above[1]);
      if (usable(n)) return n;
    }
  }
  return DEFAULT_RATING_FLOOR;
}
