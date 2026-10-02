import { describe, expect, it } from "vitest";
import type { BandeMatch, BandeTeam } from "../src/types.js";
import { lastNameSetKey } from "../src/pbcom/matchMap.js";
import {
  bandePools,
  bandeRoundRobinMatchups,
  compareMatchups,
  pairKey,
  teamKeyForReg,
} from "../src/push/structure.js";

// ── synthetic builders ───────────────────────────────────────────────────────

function team(p: Partial<BandeTeam> & { teamKey: string; registrationIds: string[]; lastNames: string[] }): BandeTeam {
  return {
    sourceTeamId: null,
    firstNames: [],
    sourceAttendeeHeaderIds: [],
    sourceActivityIds: [],
    seed: null,
    poolIndex: null,
    ...p,
  };
}

function match(p: Partial<BandeMatch> & { matchId: string }): BandeMatch {
  return {
    eventId: "event-01",
    stage: "round_robin",
    bracket: null,
    round: 1,
    position: 1,
    slotKey: null,
    teamARegId: null,
    teamBRegId: null,
    status: "pending",
    teamAScore: null,
    teamBScore: null,
    winnerRegId: null,
    ...p,
  };
}

// Three single-player teams, one per registration for simple RR wiring.
const alpha = team({ teamKey: "team:alpha", registrationIds: ["r-a"], lastNames: ["alpha"], poolIndex: 0 });
const bravo = team({ teamKey: "team:bravo", registrationIds: ["r-b"], lastNames: ["bravo"], poolIndex: 0 });
const charlie = team({ teamKey: "team:charlie", registrationIds: ["r-c"], lastNames: ["charlie"], poolIndex: 1 });
const delta = team({ teamKey: "team:delta", registrationIds: ["r-d"], lastNames: ["delta"], poolIndex: 1 });

const kA = lastNameSetKey(alpha.lastNames);
const kB = lastNameSetKey(bravo.lastNames);
const kC = lastNameSetKey(charlie.lastNames);
const kD = lastNameSetKey(delta.lastNames);

describe("teamKeyForReg", () => {
  it("resolves a reg to its team's last-name key, null for unknown / null regId", () => {
    expect(teamKeyForReg("r-a", [alpha, bravo])).toBe(kA);
    expect(teamKeyForReg("r-x", [alpha, bravo])).toBeNull();
    expect(teamKeyForReg(null, [alpha, bravo])).toBeNull();
  });
});

describe("pairKey", () => {
  it("is order-free", () => {
    expect(pairKey(kA, kB)).toBe(pairKey(kB, kA));
  });
});

describe("bandeRoundRobinMatchups", () => {
  it("one RR match between two teams in a pool → one pair key", () => {
    const set = bandeRoundRobinMatchups(
      [alpha, bravo],
      [match({ matchId: "m1", teamARegId: "r-a", teamBRegId: "r-b", stage: "round_robin" })],
    );
    expect(set).toEqual(new Set([pairKey(kA, kB)]));
  });

  it("excludes playoff-stage matches", () => {
    const set = bandeRoundRobinMatchups(
      [alpha, bravo],
      [
        match({ matchId: "m1", teamARegId: "r-a", teamBRegId: "r-b", stage: "round_robin" }),
        match({ matchId: "m2", teamARegId: "r-a", teamBRegId: "r-b", stage: "playoff", bracket: "final" }),
      ],
    );
    expect(set).toEqual(new Set([pairKey(kA, kB)]));
  });

  it("multi-pool: teams only play within their pool, cross-pool pairs never appear", () => {
    const teams = [alpha, bravo, charlie, delta];
    const matches = [
      match({ matchId: "p0", teamARegId: "r-a", teamBRegId: "r-b", stage: "round_robin" }),
      match({ matchId: "p1", teamARegId: "r-c", teamBRegId: "r-d", stage: "round_robin" }),
    ];
    const set = bandeRoundRobinMatchups(teams, matches);
    expect(set).toEqual(new Set([pairKey(kA, kB), pairKey(kC, kD)]));
    expect(set.has(pairKey(kA, kC))).toBe(false);
    expect(set.has(pairKey(kB, kD))).toBe(false);
  });
});

describe("compareMatchups", () => {
  it("identical sets → ok, empty diffs", () => {
    const a = new Set([pairKey(kA, kB), pairKey(kC, kD)]);
    const b = new Set([pairKey(kA, kB), pairKey(kC, kD)]);
    expect(compareMatchups(a, b)).toEqual({
      ok: true,
      matched: [pairKey(kA, kB), pairKey(kC, kD)].sort(),
      missingOnPbcom: [],
      extraOnPbcom: [],
    });
  });

  it("a pair only in B&E → missingOnPbcom, not ok", () => {
    const bande = new Set([pairKey(kA, kB), pairKey(kC, kD)]);
    const pbcom = new Set([pairKey(kA, kB)]);
    const diff = compareMatchups(bande, pbcom);
    expect(diff.ok).toBe(false);
    expect(diff.missingOnPbcom).toEqual([pairKey(kC, kD)]);
    expect(diff.extraOnPbcom).toEqual([]);
  });

  it("a pair only in PB.com → extraOnPbcom, not ok", () => {
    const bande = new Set([pairKey(kA, kB)]);
    const pbcom = new Set([pairKey(kA, kB), pairKey(kC, kD)]);
    const diff = compareMatchups(bande, pbcom);
    expect(diff.ok).toBe(false);
    expect(diff.missingOnPbcom).toEqual([]);
    expect(diff.extraOnPbcom).toEqual([pairKey(kC, kD)]);
  });
});

describe("bandePools", () => {
  it("groups team keys by poolIndex", () => {
    const pools = bandePools([alpha, bravo, charlie, delta]);
    expect(pools.get(0)).toEqual([kA, kB].sort());
    expect(pools.get(1)).toEqual([kC, kD].sort());
  });

  it("null-pool teams grouped under -1", () => {
    const solo = team({ teamKey: "team:echo", registrationIds: ["r-e"], lastNames: ["echo"], poolIndex: null });
    const pools = bandePools([alpha, solo]);
    expect(pools.get(0)).toEqual([kA]);
    expect(pools.get(-1)).toEqual([lastNameSetKey(solo.lastNames)]);
  });
});
