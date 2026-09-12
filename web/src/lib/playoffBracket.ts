// Single-elimination playoff brackets.
//
// The tournament supports two playoff *styles*, both keyed off the event's
// `teams_advancing_to_playoff` (N) and `playoff_rounds` (R):
//
//   * Pairwise medal matches (R = 1): adjacent seeds pair off — (1v2) for
//     gold, (3v4) for bronze, (5v6) for 5th, … — every match is its own
//     medal slot and nothing feeds forward. Works for any even N. Built
//     inline in EventConsolePage; this file does not own it.
//
//   * Single-elimination bracket (R >= 2): a seeded knockout with byes for
//     the top seeds, a gold final, and a separate bronze game contested by
//     the two semifinal losers. This file owns the bracket math.
//
// Round count follows from N: Top-4 → 2 rounds (semis → final+bronze),
// Top-5..8 → 3 rounds (quarterfinals/play-in → semis → final+bronze).
//
// Match topology is stored purely as (round, position) on the matches row —
// there is no explicit "next match" pointer — so winners/losers feed forward
// by position arithmetic (see winnerTarget / bronzeTarget). Everything here
// is pure and unit-tested (playoffBracket.test.ts); the Supabase-facing code
// in playoffFeedForward.ts and EventConsolePage.tsx is a thin adapter over it.

// The bronze game always sits at (round = R, position = 1), alongside the
// gold final at (round = R, position = 0).
export const BRONZE_POSITION = 1;

// Smallest power of two >= n (the bracket size; byes = nextPow2(n) - n).
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Standard single-elimination seeding order for a bracket of `size` slots
// (a power of two). Returns 1-based seeds in slot order so that pairing
// adjacent entries — (slot0,slot1), (slot2,slot3), … — gives seed s its
// canonical opponent (size + 1 - s) and keeps the top seeds in opposite
// halves (1 and 2 can only meet in the final, 1v4 / 2v3 in the semis).
//
//   size 2 → [1, 2]
//   size 4 → [1, 4, 2, 3]
//   size 8 → [1, 8, 4, 5, 2, 7, 3, 6]
export function seedSlotOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const m = order.length * 2;
    const next: number[] = [];
    for (const s of order) {
      next.push(s);
      next.push(m + 1 - s);
    }
    order = next;
  }
  return order;
}

// Round count for a single-elimination bracket with N teams, or null when a
// bracket isn't supported for that N (use pairwise instead). A proper bracket
// needs two semifinals so the bronze game has two losers to contest it, which
// means N >= 4. Capped at 8 (3 rounds) for now — the math below generalizes to
// any N, so extending the cap is a one-line change here plus wider UI options.
export function bracketRoundsForN(n: number): number | null {
  if (n === 4) return 2;
  if (n >= 5 && n <= 8) return 3;
  return null;
}

// Where the feeder slot in the next round a match's WINNER flows into, or
// null when `round` is the final (no further round). Classic binary-tree
// feed-forward: position p in round r feeds position floor(p/2) in round
// r+1, taking slot A for even p and slot B for odd p.
export type FeedTarget = { round: number; position: number; slot: "a" | "b" };

export function winnerTarget(
  round: number,
  position: number,
  totalRounds: number,
): FeedTarget | null {
  const next = round + 1;
  if (next > totalRounds) return null;
  return {
    round: next,
    position: Math.floor(position / 2),
    slot: position % 2 === 0 ? "a" : "b",
  };
}

// Where a match's LOSER flows into, or null when the loser is simply
// eliminated. Only the semifinal round (round = R - 1) feeds the bronze
// game; the two semi losers take slots A and B of (round R, position 1).
// Earlier-round losers (e.g. a quarterfinal in a Top-8 bracket) are out.
export function bronzeTarget(
  round: number,
  position: number,
  totalRounds: number,
): FeedTarget | null {
  if (totalRounds < 2) return null;
  if (round !== totalRounds - 1) return null;
  return {
    round: totalRounds,
    position: BRONZE_POSITION,
    slot: position % 2 === 0 ? "a" : "b",
  };
}

// One match in a generated bracket. seedA/seedB are 1-based seeds (1 = top
// seed) when a team is placed at generation time, or null when the slot is
// filled later by feed-forward. A non-null seed in a round >= 2 match marks a
// bye: a top seed that skipped round 1 and was pre-placed into its semi slot.
export type BracketMatch = {
  round: number;
  position: number;
  seedA: number | null;
  seedB: number | null;
  kind: "bracket" | "bronze";
};

// Build the full single-elimination bracket for N teams: round-1 matchups
// (minus byes), empty placeholders for later winner rounds, bye pre-placements
// into round 2, and the bronze game. Throws if N has no supported bracket.
//
// Byes: with a bracket of M = nextPow2(N) slots, the (M - N) highest seeds
// have no real opponent in round 1. Rather than store phantom one-team
// matches, the present seed is pre-placed directly into the round-2 slot it
// would have advanced to — so feed-forward and display never see a bye match.
// (Because a bracket needs N > M/2, byes always pair with a real seed, so a
// round-1 pairing never has two byes.)
export function buildSingleElimBracket(n: number): BracketMatch[] {
  const R = bracketRoundsForN(n);
  if (R == null) {
    throw new Error(`No single-elimination bracket is defined for ${n} teams.`);
  }
  const M = 1 << R; // bracket size (power of two)
  const slots = seedSlotOrder(M);
  const present = (s: number) => s >= 1 && s <= n;
  const key = (r: number, p: number, slot: "a" | "b") => `${r}:${p}:${slot}`;

  // Bye pre-placements: slot key -> seed. Only ever targets round 2.
  const prefill = new Map<string, number>();
  const matches: BracketMatch[] = [];

  // Round 1: pair adjacent slots. Both present → real match; exactly one
  // present → the present seed gets a bye and advances to round 2.
  for (let p = 0; p < M / 2; p++) {
    const sa = slots[2 * p];
    const sb = slots[2 * p + 1];
    const aPresent = present(sa);
    const bPresent = present(sb);
    if (aPresent && bPresent) {
      matches.push({
        round: 1,
        position: p,
        seedA: sa,
        seedB: sb,
        kind: "bracket",
      });
    } else if (aPresent !== bPresent) {
      const winner = aPresent ? sa : sb;
      const t = winnerTarget(1, p, R);
      if (t) prefill.set(key(t.round, t.position, t.slot), winner);
    }
    // Both byes can't happen for a supported N (N > M/2).
  }

  // Rounds 2..R: winner-bracket placeholders (with byes pre-filled), plus the
  // bronze game alongside the gold final in the last round.
  for (let r = 2; r <= R; r++) {
    const count = M >> r; // M / 2^r matches in this winner round
    for (let p = 0; p < count; p++) {
      matches.push({
        round: r,
        position: p,
        seedA: prefill.get(key(r, p, "a")) ?? null,
        seedB: prefill.get(key(r, p, "b")) ?? null,
        kind: "bracket",
      });
    }
    if (r === R) {
      matches.push({
        round: R,
        position: BRONZE_POSITION,
        seedA: null,
        seedB: null,
        kind: "bronze",
      });
    }
  }

  return matches;
}

// Human round name for a playoff round. `matchesInRound` distinguishes a
// Top-6 play-in (2 matches) from a Top-8 quarterfinal round (4 matches),
// since both sit at round 1 of a 3-round bracket.
export function playoffRoundName(
  round: number,
  totalRounds: number,
  matchesInRound: number,
): string {
  if (totalRounds <= 1) return "Medal matches";
  if (round === totalRounds) return "Final + bronze";
  if (round === totalRounds - 1) return "Semifinals";
  // First round of a 3-round bracket.
  if (matchesInRound >= 3) return "Quarterfinals";
  return "Play-in round";
}

// Ordinal suffix for placement-match labels ("5th place match", etc.).
export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
