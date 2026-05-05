import type { Database } from "../types/supabase";

type Match = Database["public"]["Tables"]["matches"]["Row"];

// Human-readable label for a match within an event. Same vocabulary
// across the printed scorecard, the court manager queue, and any other
// view that references a specific match — so an organizer can yell
// "Court 3 takes RR-7" or "Semi-2 to Court 1" and everyone's looking
// at the same identifier.
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
