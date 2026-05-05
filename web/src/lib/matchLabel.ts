import type { Database } from "../types/supabase";

type Match = Database["public"]["Tables"]["matches"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];

// Human-readable short label for a match within an event. Same
// vocabulary across the printed scorecard, the court manager queue,
// and any other view that references a specific match — so an
// organizer can yell "Court 3 takes RR-7" or "Semi-2 to Court 1" and
// everyone's looking at the same identifier.
//
// `all` is the full list of matches in the parent event; we use it to
// figure out whether a playoff match is the only one in its round
// (final), one of two (semis), or one of four (quarters).
export function matchLabel(m: Match, all: Match[]): string {
  if (m.stage === "round_robin") {
    const rr = all
      .filter((x) => x.stage === "round_robin")
      .sort((a, b) => a.position - b.position);
    const idx = rr.findIndex((x) => x.id === m.id);
    return `RR-${idx + 1}`;
  }
  // playoff: round 1 = semis, round 2 = final (top-2 mode: round 1 = final)
  const playoff = all
    .filter((x) => x.stage === "playoff")
    .sort((a, b) => a.round - b.round || a.position - b.position);
  const sameRound = playoff.filter((x) => x.round === m.round);
  if (sameRound.length === 1) return "Final";
  if (sameRound.length === 2) return `Semi-${m.position + 1}`;
  if (sameRound.length === 4) return `Quarter-${m.position + 1}`;
  return `Playoff R${m.round}-${m.position + 1}`;
}

// Verbose, panel-friendly label for playoff matches. Distinguishes
// Gold Medal vs Bronze Medal in both the pairwise (R=1) and
// bracket-with-bronze (R=2, N=4) configurations defined in
// playoffFeedForward.ts. Returns null for round_robin — callers can
// treat null as "no badge".
//
// Pairwise (R=1, N=4): two matches in round 1 — position 0 is the
//   1v2 Gold Medal Match, position 1 is the 3v4 Bronze Medal Match.
// Bracket-with-bronze (R=2, N=4): round 1 has two semis; round 2
//   position 0 is the Gold Medal Final, position 1 is the Bronze
//   Medal Game.
// Top-2 (R=1, N=2): single match is the Final.
//
// Generic fallback uses the same Quarter/Semi/Final shape as
// matchLabel but spelled out fully.
export function playoffStageLabel(
  m: Match,
  all: Match[],
  event: Pick<Event, "playoff_rounds" | "teams_advancing_to_playoff">,
): string | null {
  if (m.stage !== "playoff") return null;

  const sameRound = all.filter(
    (x) => x.stage === "playoff" && x.round === m.round,
  );

  // Bracket-with-bronze (R=2, N=4): round 2 holds the medal matches.
  if (
    event.playoff_rounds === 2 &&
    event.teams_advancing_to_playoff === 4
  ) {
    if (m.round === 1) return `Semifinal ${m.position + 1}`;
    if (m.round === 2) {
      if (m.position === 0) return "Gold Medal Final";
      if (m.position === 1) return "Bronze Medal Game";
    }
  }

  // Pairwise medal matches (R=1, N=4): both matches are medal matches.
  if (
    event.playoff_rounds === 1 &&
    event.teams_advancing_to_playoff === 4 &&
    sameRound.length === 2
  ) {
    if (m.position === 0) return "Gold Medal Match";
    if (m.position === 1) return "Bronze Medal Match";
  }

  // Top-2 final.
  if (sameRound.length === 1) return "Final";

  // Generic shape fallback.
  if (sameRound.length === 2) return `Semifinal ${m.position + 1}`;
  if (sameRound.length === 4) return `Quarterfinal ${m.position + 1}`;
  return `Round ${m.round} Match ${m.position + 1}`;
}

// Visual treatment for a match label. Gold gets the amber palette
// from design-prefs (note-to-self family); bronze gets a muted
// copper; bracket rounds (Final / Semifinal / Quarterfinal) stay
// neutral blue; everything else (RR-N, etc.) gets a neutral gray.
// Returns null only when given a null label.
export function playoffStageStyle(
  label: string | null,
): { color: string; background: string; border: string } | null {
  if (!label) return null;
  if (label.startsWith("Gold")) {
    return { color: "#92400e", background: "#fffbeb", border: "#fde68a" };
  }
  if (label.startsWith("Bronze")) {
    return { color: "#7c2d12", background: "#fff7ed", border: "#fed7aa" };
  }
  if (
    label === "Final" ||
    label.startsWith("Semifinal") ||
    label.startsWith("Quarterfinal")
  ) {
    return { color: "#1e3a8a", background: "#eff6ff", border: "#bfdbfe" };
  }
  // RR-N or any other compact label — neutral gray badge so the
  // match name reads as informational without competing with the
  // medal-round badges.
  return { color: "#6b7280", background: "#f9fafb", border: "#e5e7eb" };
}
