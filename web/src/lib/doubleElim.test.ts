import { describe, it, expect } from "vitest";
import { buildDoubleElim, seedOrder, simulate, playLayers, type Slot } from "./doubleElim";

const higherSeedWins = (_s: Slot, a: number, b: number) => Math.min(a, b);

describe("seedOrder", () => {
  it("puts 1 and 2 in opposite halves", () => {
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
  });
});

describe("buildDoubleElim — counts and wiring", () => {
  for (const n of [4, 6, 8, 12, 16]) {
    it(`N=${n}: bronze_only has 2N−4 matches, crossover 2N−2 (+1 if-necessary)`, () => {
      const bo = buildDoubleElim(n, "bronze_only");
      const co = buildDoubleElim(n, "crossover");
      expect(bo.slots.length).toBe(2 * n - 4);
      expect(co.slots.filter((s) => !s.ifNecessary).length).toBe(2 * n - 2);
      expect(co.slots.filter((s) => s.ifNecessary).length).toBe(1);
    });
    it(`N=${n}: every played slot's sources are seeds or played slots; no team meets itself; each feed lands once`, () => {
      const de = buildDoubleElim(n, "crossover");
      const keys = new Set(de.slots.map((s) => s.key));
      const fedSides = new Map<string, number>();
      for (const s of de.slots) {
        for (const src of [s.a, s.b]) {
          if (src.kind === "seed") expect(src.seed).toBeLessThanOrEqual(n);
          else if (src.kind === "winner" || src.kind === "loser") expect(keys.has(src.of)).toBe(true);
          else throw new Error("bye in played slot");
        }
        for (const f of [s.feedsWinnerTo, s.feedsLoserTo]) {
          if (!f) continue;
          expect(keys.has(f.key)).toBe(true);
          const id = `${f.key}:${f.side}`;
          fedSides.set(id, (fedSides.get(id) ?? 0) + 1);
        }
      }
      for (const [, c] of fedSides) expect(c).toBe(1);
    });
  }
  it("N=8: byes are none; N=6: top two seeds skip round 1", () => {
    const de = buildDoubleElim(6, "bronze_only");
    const w1 = de.slots.filter((s) => s.bracket === "winners" && s.round === 1);
    expect(w1.length).toBe(2);
    const seedsInW1 = w1.flatMap((s) => [s.a, s.b]).map((x) => (x.kind === "seed" ? x.seed : -1)).sort();
    expect(seedsInW1).toEqual([3, 4, 5, 6]);
    const w2 = de.slots.filter((s) => s.bracket === "winners" && s.round === 2);
    expect(w2.some((s) => s.a.kind === "seed" && s.a.seed === 1)).toBe(true);
  });
});

describe("simulate", () => {
  it("N=8 crossover, favourites always win: 1 gold, 2 silver, 3 bronze, no if-necessary", () => {
    const r = simulate(buildDoubleElim(8, "crossover"), higherSeedWins);
    expect(r).toEqual({ gold: 1, silver: 2, bronze: 3, playedF2: false });
  });
  it("N=8 bronze_only, favourites always win: 1 gold, 2 silver, 3 bronze — the silver team never drops", () => {
    const de = buildDoubleElim(8, "bronze_only");
    const wFinal = de.slots.find((s) => s.bracket === "winners" && s.round === de.k)!;
    expect(wFinal.feedsLoserTo).toBeNull();
    const r = simulate(de, higherSeedWins);
    expect(r).toEqual({ gold: 1, silver: 2, bronze: 3, playedF2: false });
  });
  it("crossover: the consolation champion can take gold by winning F1 and F2", () => {
    // seed 2 loses to 1 in the Winners Final, wins the consolation, then beats 1 twice
    const de = buildDoubleElim(4, "crossover");
    const pick = (s: Slot, a: number, b: number) => {
      if (s.key === "F1" || s.key === "F2") return a === 2 ? 2 : b === 2 ? 2 : Math.min(a, b);
      return Math.min(a, b);
    };
    const r = simulate(de, pick);
    expect(r.playedF2).toBe(true);
    expect(r.gold).toBe(2);
    expect(r.silver).toBe(1);
  });
  it("N=6 with byes runs to completion in both formats", () => {
    expect(simulate(buildDoubleElim(6, "crossover"), higherSeedWins).gold).toBe(1);
    expect(simulate(buildDoubleElim(6, "bronze_only"), higherSeedWins).bronze).toBe(3);
    expect(simulate(buildDoubleElim(5, "crossover"), higherSeedWins).silver).toBe(2);
    expect(simulate(buildDoubleElim(12, "bronze_only"), higherSeedWins).gold).toBe(1);
  });
});

describe("playLayers", () => {
  it("N=8 crossover has W1,L1,W2,L2,W3,L3,L4,F1,F2 layers", () => {
    const layers = playLayers(buildDoubleElim(8, "crossover"));
    expect(layers.map((l) => `${l[0].bracket}${l[0].round}:${l.length}`)).toEqual([
      "winners1:4", "consolation1:2", "winners2:2", "consolation2:2", "winners3:1", "consolation3:1", "consolation4:1", "final1:1", "final2:1",
    ]);
  });
});
