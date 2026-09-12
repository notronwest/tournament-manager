import type { Database } from "../types/supabase";
import { BRONZE_POSITION, ordinal } from "./playoffBracket";

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
  // Playoff. Compact identifiers by round, relative to the last round so a
  // 3-round Top-6/8 bracket reads correctly (Quarter → Semi → Final/Bronze).
  // The verbose playoffStageLabel is preferred wherever the event is loaded;
  // this is the fallback for views without it.
  const playoff = all
    .filter((x) => x.stage === "playoff")
    .sort((a, b) => a.round - b.round || a.position - b.position);
  const maxRound = playoff.reduce((mx, x) => Math.max(mx, x.round), m.round);
  const sameRound = playoff.filter((x) => x.round === m.round);
  // Rank within the round (handles Top-6 play-in at positions 1 and 3).
  const rank = sameRound.findIndex((x) => x.id === m.id) + 1;

  if (m.round === maxRound) {
    // Final round. A bracket's last round is the gold final (pos 0) plus the
    // bronze game (pos 1); pairwise rounds hold several medal matches.
    if (sameRound.length === 1) return "Final";
    if (sameRound.length === 2) {
      return m.position === BRONZE_POSITION ? "Bronze" : "Final";
    }
    return `Medal-${rank}`;
  }
  if (m.round === maxRound - 1) return `Semi-${rank}`;
  // Earlier rounds of a 3-round bracket: a 2-match round is the Top-6 play-in.
  return sameRound.length >= 3 ? `Quarter-${rank}` : `Play-in-${rank}`;
}

// Verbose, panel-friendly label for playoff matches. Distinguishes Gold vs
// Bronze medal matches across both playoff styles (see playoffBracket.ts).
// Returns null for round_robin — callers treat null as "no badge".
//
// Pairwise (R=1): matches pair adjacent seeds — position 0 is the Gold Medal
//   Match (1v2), position 1 the Bronze Medal Match (3v4), and for larger N
//   position k is the (2k+1)th place match (5th, 7th, …).
// Single-elim bracket (R>=2): the last round (R) holds the Gold Medal Final
//   (position 0) and the Bronze Medal Game (position 1). Round R-1 is the
//   semifinals; for a 3-round bracket round 1 is the quarterfinals (4 matches,
//   Top-8) or the play-in (2 matches, Top-6).
export function playoffStageLabel(
  m: Match,
  all: Match[],
  event: Pick<Event, "playoff_rounds" | "teams_advancing_to_playoff">,
): string | null {
  if (m.stage !== "playoff") return null;

  const R = event.playoff_rounds;
  const sameRound = all
    .filter((x) => x.stage === "playoff" && x.round === m.round)
    .sort((a, b) => a.position - b.position);
  // Rank within the round (handles the Top-6 play-in at positions 1 and 3).
  const rank = Math.max(0, sameRound.findIndex((x) => x.id === m.id)) + 1;

  // Pairwise medal matches (R=1): each match is a placement match.
  if (R <= 1) {
    if (sameRound.length === 1) return "Final";
    if (m.position === 0) return "Gold Medal Match";
    if (m.position === 1) return "Bronze Medal Match";
    return `${ordinal(2 * m.position + 1)} Place Match`;
  }

  // Single-elimination bracket (R>=2).
  if (m.round === R) {
    if (m.position === 0) return "Gold Medal Final";
    if (m.position === BRONZE_POSITION) return "Bronze Medal Game";
  }
  if (m.round === R - 1) return `Semifinal ${rank}`;
  // Earlier rounds of a 3-round bracket: a 2-match round is the play-in.
  if (sameRound.length >= 3) return `Quarterfinal ${rank}`;
  if (m.round === 1) return `Play-in ${rank}`;
  return `Round ${m.round} Match ${rank}`;
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
