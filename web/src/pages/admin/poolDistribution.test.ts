import { describe, expect, it } from "vitest";
import {
  planPoolDistribution,
  snakePoolIndex,
  type PoolDistributionTeam,
} from "./poolDistribution";

const team = (
  captainRegId: string,
  seed: number | null,
  partnerRegId: string | null = null,
): PoolDistributionTeam => ({ captainRegId, seed, partnerRegId });

const fourTeams: PoolDistributionTeam[] = [
  team("t1", 1),
  team("t2", 2),
  team("t3", 3),
  team("t4", 4),
];

describe("planPoolDistribution", () => {
  it("is a no-op once matches exist (locks re-pooling to protect the bracket)", () => {
    // The core guard: re-pooling after games are created would corrupt the
    // matches/standings, so distributePools must produce ZERO writes.
    for (const pattern of ["alternate", "snake"] as const) {
      const plan = planPoolDistribution({
        teams: fourTeams,
        poolCount: 2,
        pattern,
        hasMatches: true,
      });
      expect(plan).toEqual([]);
    }
  });

  it("is a no-op for a single pool", () => {
    const plan = planPoolDistribution({
      teams: fourTeams,
      poolCount: 1,
      pattern: "alternate",
      hasMatches: false,
    });
    expect(plan).toEqual([]);
  });

  it("alternates seeds across pools when no matches exist", () => {
    const plan = planPoolDistribution({
      teams: fourTeams,
      poolCount: 2,
      pattern: "alternate",
      hasMatches: false,
    });
    expect(plan).toEqual([
      { ids: ["t1"], poolIndex: 1 },
      { ids: ["t2"], poolIndex: 2 },
      { ids: ["t3"], poolIndex: 1 },
      { ids: ["t4"], poolIndex: 2 },
    ]);
  });

  it("snake-drafts seeds (1,2,2,1) when no matches exist", () => {
    const plan = planPoolDistribution({
      teams: fourTeams,
      poolCount: 2,
      pattern: "snake",
      hasMatches: false,
    });
    expect(plan.map((a) => a.poolIndex)).toEqual([1, 2, 2, 1]);
  });

  it("moves the partner registration together with the captain", () => {
    const plan = planPoolDistribution({
      teams: [team("cap", 1, "partner")],
      poolCount: 2,
      pattern: "alternate",
      hasMatches: false,
    });
    expect(plan).toEqual([{ ids: ["cap", "partner"], poolIndex: 1 }]);
  });

  it("orders by seed with unseeded teams last", () => {
    const plan = planPoolDistribution({
      teams: [team("b", null), team("a", 5), team("c", null), team("d", 1)],
      poolCount: 2,
      pattern: "alternate",
      hasMatches: false,
    });
    // Seeded first (1 then 5), then the two unseeded in original order.
    expect(plan.map((a) => a.ids[0])).toEqual(["d", "a", "b", "c"]);
  });
});

describe("snakePoolIndex", () => {
  it("produces the 1,2,2,1,1,2 serpentine pattern for 2 pools", () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => snakePoolIndex(i, 2))).toEqual([
      1, 2, 2, 1, 1, 2,
    ]);
  });
});
