import { describe, it, expect } from "vitest";
import {
  selectPlayoffSeeds,
  pairPlayoffSeeds,
  type SeedableStanding,
} from "./playoffSeeding";

// Minimal standing rows — a label rides along so the seed order and
// pairings are easy to assert. Standings arrive already record-sorted
// (best team first), which these fixtures mimic.
type Row = SeedableStanding & { label: string };
const row = (label: string, poolIndex: number | null): Row => ({
  label,
  team: { poolIndex },
});
const labels = (rows: Row[]) => rows.map((r) => r.label);

describe("selectPlayoffSeeds — overall", () => {
  const standings = [
    row("A", null),
    row("B", null),
    row("C", null),
    row("D", null),
    row("E", null),
    row("F", null),
    row("G", null),
  ];

  it("takes the top N in standings order", () => {
    expect(labels(selectPlayoffSeeds(standings, 4, false))).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
  });

  it("returns fewer than N when there aren't enough teams", () => {
    const three = standings.slice(0, 3);
    expect(selectPlayoffSeeds(three, 4, false)).toHaveLength(3);
  });
});

describe("selectPlayoffSeeds — cross-pool", () => {
  // Pools are 1-indexed: pool 1 = A, pool 2 = B. Within each pool the
  // rows are in finish order, so the first row of a pool is its winner.
  const standings = [
    row("A1", 1),
    row("B1", 2),
    row("A2", 1),
    row("B2", 2),
    row("A3", 1),
    row("B3", 2),
  ];

  it("seeds [PoolA#1, PoolB#1, PoolA#2, PoolB#2]", () => {
    expect(labels(selectPlayoffSeeds(standings, 4, true))).toEqual([
      "A1",
      "B1",
      "A2",
      "B2",
    ]);
  });

  it("filters on the 1-indexed pool values, not 0-indexed", () => {
    // A pool-0 team must never be picked — the store uses 1 and 2.
    const withPhantomPool0 = [row("X", 0), ...standings];
    expect(labels(selectPlayoffSeeds(withPhantomPool0, 4, true))).toEqual([
      "A1",
      "B1",
      "A2",
      "B2",
    ]);
  });

  it("returns [] when a pool has fewer than 2 teams", () => {
    const lopsided = [row("A1", 1), row("A2", 1), row("A3", 1), row("B1", 2)];
    expect(selectPlayoffSeeds(lopsided, 4, true)).toEqual([]);
  });
});

describe("pairPlayoffSeeds — single round (adjacent seeds)", () => {
  const seeds = [row("1", null), row("2", null), row("3", null), row("4", null)];

  it("pairs (1,2) and (3,4) for medal matches", () => {
    const pairs = pairPlayoffSeeds(seeds, 1).map(
      ([a, b]) => `${a.label}v${b.label}`,
    );
    expect(pairs).toEqual(["1v2", "3v4"]);
  });

  it("drops a trailing unpaired seed rather than crashing", () => {
    const three = seeds.slice(0, 3);
    expect(pairPlayoffSeeds(three, 1).map(([a, b]) => `${a.label}v${b.label}`)).toEqual(
      ["1v2"],
    );
  });
});

describe("pairPlayoffSeeds — two rounds (high vs low)", () => {
  const seeds = [row("1", null), row("2", null), row("3", null), row("4", null)];

  it("pairs (1,4) and (2,3) for semifinals", () => {
    const pairs = pairPlayoffSeeds(seeds, 2).map(
      ([a, b]) => `${a.label}v${b.label}`,
    );
    expect(pairs).toEqual(["1v4", "2v3"]);
  });
});

describe("pairPlayoffSeeds — degenerate", () => {
  it("returns [] for fewer than two seeds", () => {
    expect(pairPlayoffSeeds([], 1)).toEqual([]);
    expect(pairPlayoffSeeds([row("1", null)], 2)).toEqual([]);
  });
});
