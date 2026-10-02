import { describe, it, expect } from "vitest";
import {
  nextPow2,
  seedSlotOrder,
  bracketRoundsForN,
  winnerTarget,
  bronzeTarget,
  buildSingleElimBracket,
  playoffRoundName,
  ordinal,
  BRONZE_POSITION,
  type BracketMatch,
} from "./playoffBracket";

describe("nextPow2", () => {
  it("rounds up to the next power of two", () => {
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(2)).toBe(2);
    expect(nextPow2(3)).toBe(4);
    expect(nextPow2(4)).toBe(4);
    expect(nextPow2(5)).toBe(8);
    expect(nextPow2(6)).toBe(8);
    expect(nextPow2(8)).toBe(8);
    expect(nextPow2(9)).toBe(16);
  });
});

describe("seedSlotOrder", () => {
  it("produces the canonical single-elim seeding order", () => {
    expect(seedSlotOrder(2)).toEqual([1, 2]);
    expect(seedSlotOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedSlotOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it("keeps seed s opposite seed (size+1-s) in round 1", () => {
    const order = seedSlotOrder(8);
    for (let p = 0; p < order.length / 2; p++) {
      expect(order[2 * p] + order[2 * p + 1]).toBe(9);
    }
  });

  it("puts the top two seeds in opposite halves (can only meet in the final)", () => {
    const order = seedSlotOrder(8);
    const half = order.length / 2;
    const seed1 = order.indexOf(1);
    const seed2 = order.indexOf(2);
    expect(seed1 < half).toBe(true);
    expect(seed2 < half).toBe(false);
  });
});

describe("bracketRoundsForN", () => {
  it("maps N to round count for supported sizes", () => {
    expect(bracketRoundsForN(4)).toBe(2);
    expect(bracketRoundsForN(5)).toBe(3);
    expect(bracketRoundsForN(6)).toBe(3);
    expect(bracketRoundsForN(7)).toBe(3);
    expect(bracketRoundsForN(8)).toBe(3);
  });

  it("returns null where a proper bracket with a bronze game isn't defined", () => {
    expect(bracketRoundsForN(0)).toBeNull();
    expect(bracketRoundsForN(2)).toBeNull();
    expect(bracketRoundsForN(3)).toBeNull();
    expect(bracketRoundsForN(9)).toBeNull();
    expect(bracketRoundsForN(16)).toBeNull();
  });
});

describe("winnerTarget / bronzeTarget", () => {
  it("feeds winners forward by floor(position/2), alternating slots", () => {
    expect(winnerTarget(1, 0, 3)).toEqual({ round: 2, position: 0, slot: "a" });
    expect(winnerTarget(1, 1, 3)).toEqual({ round: 2, position: 0, slot: "b" });
    expect(winnerTarget(1, 2, 3)).toEqual({ round: 2, position: 1, slot: "a" });
    expect(winnerTarget(1, 3, 3)).toEqual({ round: 2, position: 1, slot: "b" });
    expect(winnerTarget(2, 0, 3)).toEqual({ round: 3, position: 0, slot: "a" });
    expect(winnerTarget(2, 1, 3)).toEqual({ round: 3, position: 0, slot: "b" });
  });

  it("has no winner target for the final round", () => {
    expect(winnerTarget(2, 0, 2)).toBeNull();
    expect(winnerTarget(3, 0, 3)).toBeNull();
  });

  it("feeds only semifinal losers into the bronze game", () => {
    // R=2: semis are round 1.
    expect(bronzeTarget(1, 0, 2)).toEqual({ round: 2, position: 1, slot: "a" });
    expect(bronzeTarget(1, 1, 2)).toEqual({ round: 2, position: 1, slot: "b" });
    // R=3: semis are round 2; round-1 losers are eliminated.
    expect(bronzeTarget(2, 0, 3)).toEqual({ round: 3, position: 1, slot: "a" });
    expect(bronzeTarget(2, 1, 3)).toEqual({ round: 3, position: 1, slot: "b" });
    expect(bronzeTarget(1, 0, 3)).toBeNull();
    // The final and bronze games themselves feed nothing.
    expect(bronzeTarget(3, 0, 3)).toBeNull();
  });
});

// ── Structure ──────────────────────────────────────────────────────────

function find(matches: BracketMatch[], round: number, position: number) {
  return matches.find((m) => m.round === round && m.position === position);
}

describe("buildSingleElimBracket — structure", () => {
  it("Top-4: two semis (1v4, 2v3) → gold final + bronze", () => {
    const b = buildSingleElimBracket(4);
    expect(b).toHaveLength(4); // N matches total (N-1 elim + 1 bronze)
    expect(find(b, 1, 0)).toMatchObject({ seedA: 1, seedB: 4, kind: "bracket" });
    expect(find(b, 1, 1)).toMatchObject({ seedA: 2, seedB: 3, kind: "bracket" });
    expect(find(b, 2, 0)).toMatchObject({ seedA: null, seedB: null, kind: "bracket" });
    expect(find(b, 2, BRONZE_POSITION)).toMatchObject({ kind: "bronze" });
  });

  it("Top-6: seeds 1-2 bye, 4v5 & 3v6 play in, then semis, then final + bronze", () => {
    const b = buildSingleElimBracket(6);
    expect(b).toHaveLength(6);
    // Play-in round: only two real matches, at the bracket positions that
    // feed the open semifinal slots (positions 1 and 3, not 0 and 2).
    const round1 = b.filter((m) => m.round === 1);
    expect(round1).toHaveLength(2);
    expect(find(b, 1, 1)).toMatchObject({ seedA: 4, seedB: 5 });
    expect(find(b, 1, 3)).toMatchObject({ seedA: 3, seedB: 6 });
    // Byes: seeds 1 and 2 pre-placed into the semifinals (slot A); the other
    // slot is filled by the play-in winner via feed-forward.
    expect(find(b, 2, 0)).toMatchObject({ seedA: 1, seedB: null });
    expect(find(b, 2, 1)).toMatchObject({ seedA: 2, seedB: null });
    // Final + bronze.
    expect(find(b, 3, 0)).toMatchObject({ seedA: null, seedB: null, kind: "bracket" });
    expect(find(b, 3, BRONZE_POSITION)).toMatchObject({ kind: "bronze" });
  });

  it("Top-8: four quarterfinals → semis → final + bronze, no byes", () => {
    const b = buildSingleElimBracket(8);
    expect(b).toHaveLength(8);
    const round1 = b.filter((m) => m.round === 1);
    expect(round1).toHaveLength(4);
    // Canonical quarterfinal matchups.
    expect(find(b, 1, 0)).toMatchObject({ seedA: 1, seedB: 8 });
    expect(find(b, 1, 1)).toMatchObject({ seedA: 4, seedB: 5 });
    expect(find(b, 1, 2)).toMatchObject({ seedA: 2, seedB: 7 });
    expect(find(b, 1, 3)).toMatchObject({ seedA: 3, seedB: 6 });
    // No seeds placed in the semis (no byes for Top-8).
    expect(find(b, 2, 0)).toMatchObject({ seedA: null, seedB: null });
    expect(find(b, 2, 1)).toMatchObject({ seedA: null, seedB: null });
    expect(find(b, 3, 0)).toMatchObject({ kind: "bracket" });
    expect(find(b, 3, BRONZE_POSITION)).toMatchObject({ kind: "bronze" });
  });

  it("throws for unsupported sizes", () => {
    expect(() => buildSingleElimBracket(3)).toThrow();
    expect(() => buildSingleElimBracket(9)).toThrow();
  });
});

// ── Full play-out simulation ─────────────────────────────────────────────
//
// Mirrors how the real system plays out: build the bracket, then repeatedly
// complete matches that have both teams, routing winners (winnerTarget) and
// semifinal losers (bronzeTarget) into the next slots — exactly the logic in
// playoffFeedForward.ts. `pick(a, b)` decides each winner so we can model both
// chalk and upsets. Returns the final medal seeds.

type Slots = { a: number | null; b: number | null };

function simulate(
  n: number,
  pick: (a: number, b: number) => number,
): { gold: number; silver: number; bronze: number } {
  const R = bracketRoundsForN(n)!;
  const built = buildSingleElimBracket(n);
  // Mutable live state keyed by "round:position".
  const live = new Map<string, Slots & { kind: string }>();
  for (const m of built) {
    live.set(`${m.round}:${m.position}`, { a: m.seedA, b: m.seedB, kind: m.kind });
  }
  const done = new Set<string>();

  // Iterate to a fixpoint: play any match whose both slots are filled.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const m of built) {
      const k = `${m.round}:${m.position}`;
      if (done.has(k)) continue;
      const slot = live.get(k)!;
      if (slot.a == null || slot.b == null) continue;
      const winner = pick(slot.a, slot.b);
      const loser = winner === slot.a ? slot.b : slot.a;
      done.add(k);
      progressed = true;

      const wt = winnerTarget(m.round, m.position, R);
      if (wt) {
        const t = live.get(`${wt.round}:${wt.position}`)!;
        t[wt.slot] = winner;
      }
      const bt = bronzeTarget(m.round, m.position, R);
      if (bt) {
        const t = live.get(`${bt.round}:${bt.position}`)!;
        t[bt.slot] = loser;
      }
    }
  }

  // Every match must have been played (no stuck/unfilled slots).
  expect(done.size).toBe(built.length);

  const gold = live.get(`${R}:0`)!;
  const goldWinner = pick(gold.a!, gold.b!);
  const bronze = live.get(`${R}:${BRONZE_POSITION}`)!;
  return {
    gold: goldWinner,
    silver: goldWinner === gold.a ? gold.b! : gold.a!,
    bronze: pick(bronze.a!, bronze.b!),
  };
}

const chalk = (a: number, b: number) => Math.min(a, b); // lower seed number wins

describe("buildSingleElimBracket — full play-out (chalk)", () => {
  for (const n of [4, 6, 8]) {
    it(`Top-${n}: favorites win → 1 gold, 2 silver, 3 bronze`, () => {
      expect(simulate(n, chalk)).toEqual({ gold: 1, silver: 2, bronze: 3 });
    });
  }
});

describe("buildSingleElimBracket — medals follow results, not seeds", () => {
  it("Top-8 upset: bottom seed runs the table and wins gold", () => {
    // Seed 8 beats anyone; otherwise chalk. 8's path: 8>1 (QF), then wins
    // its semi and the final.
    const pick = (a: number, b: number) =>
      a === 8 || b === 8 ? 8 : Math.min(a, b);
    const r = simulate(8, pick);
    expect(r.gold).toBe(8);
    // 8 knocked out seed 1 in the quarterfinal, so 1 cannot medal — it never
    // reached a semifinal and so never reached the bronze game.
    expect(r.silver).not.toBe(1);
    expect(r.bronze).not.toBe(1);
  });

  it("Top-6 upset: a play-in team beats a bye seed in the semifinal", () => {
    // Seed 5 wins the 4v5 play-in, then upsets bye-seed 1 in the semifinal,
    // then loses the final to 2. Bronze is contested by the two semi losers
    // (1 and the 3v6 winner = 3); 1 takes bronze.
    const pick = (a: number, b: number) => {
      const pair = [a, b];
      if (pair.includes(5) && pair.includes(4)) return 5; // play-in upset
      if (pair.includes(5) && pair.includes(1)) return 5; // semifinal upset
      return Math.min(a, b);
    };
    const r = simulate(6, pick);
    expect(r.gold).toBe(2);
    expect(r.silver).toBe(5);
    expect(r.bronze).toBe(1); // semifinal loser, won the bronze game over 3
  });
});

describe("playoffRoundName", () => {
  it("names pairwise and bracket rounds", () => {
    expect(playoffRoundName(1, 1, 2)).toBe("Medal matches");
    // Top-4 (R=2)
    expect(playoffRoundName(1, 2, 2)).toBe("Semifinals");
    expect(playoffRoundName(2, 2, 1)).toBe("Final + bronze");
    // Top-8 (R=3): 4 QFs
    expect(playoffRoundName(1, 3, 4)).toBe("Quarterfinals");
    expect(playoffRoundName(2, 3, 2)).toBe("Semifinals");
    expect(playoffRoundName(3, 3, 2)).toBe("Final + bronze");
    // Top-6 (R=3): 2-match play-in
    expect(playoffRoundName(1, 3, 2)).toBe("Play-in round");
  });
});

describe("ordinal", () => {
  it("formats ordinals", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(4)).toBe("4th");
    expect(ordinal(5)).toBe("5th");
    expect(ordinal(11)).toBe("11th");
  });
});
