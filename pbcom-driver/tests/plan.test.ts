import { describe, expect, it } from "vitest";
import {
  bracketLedgerEntry,
  computePlan,
  divisionKeyOf,
  isPushable,
  matchIdentity,
  resolveTeams,
  scoreDigest,
  scoreLedgerEntry,
  winnerSide,
} from "../src/push/plan.js";
import type { BandeDraw, BandeEntry, BandeMatch, PushLedgerEntry } from "../src/types.js";

// ── synthetic builders (no real member data) ────────────────────────────────────

function entry(p: Partial<BandeEntry> & { registrationId: string }): BandeEntry {
  return {
    eventId: "event-01",
    playerId: `player-${p.registrationId}`,
    partnerRegistrationId: null,
    seed: null,
    sourceSystem: "pbcom",
    sourceActivityId: null,
    sourceTeamId: null,
    sourceAttendeeHeaderId: null,
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

const LABEL = "Mens Doubles Skill: (3.0 To 3.49)";

function doublesDraw(): BandeDraw {
  return {
    division: {
      eventId: "event-01",
      tournamentId: "t-1",
      name: "Men's Doubles 3.0",
      sourceSystem: "pbcom",
      sourceDivisionLabel: LABEL,
      format: "doubles",
      gender: "men",
      bracketType: "round_robin",
    },
    entries: [
      entry({ registrationId: "reg-a1", partnerRegistrationId: "reg-a2", seed: 1, sourceActivityId: "AID-1001", sourceTeamId: "T-1" }),
      entry({ registrationId: "reg-a2", partnerRegistrationId: "reg-a1", seed: 1, sourceActivityId: "AID-1002", sourceTeamId: "T-1" }),
      entry({ registrationId: "reg-b1", partnerRegistrationId: "reg-b2", seed: 2, sourceActivityId: "AID-2001", sourceTeamId: "T-2" }),
      entry({ registrationId: "reg-b2", partnerRegistrationId: "reg-b1", seed: 2, sourceActivityId: "AID-2002", sourceTeamId: "T-2" }),
    ],
    matches: [
      match({ matchId: "m-1", teamARegId: "reg-a1", teamBRegId: "reg-b1", status: "completed", teamAScore: 11, teamBScore: 6, winnerRegId: "reg-a1" }),
      match({ matchId: "m-2", stage: "playoff", bracket: "final", round: 2, teamARegId: "reg-a1", teamBRegId: "reg-b1", status: "pending" }),
    ],
  };
}

describe("resolveTeams", () => {
  it("groups doubles partners by shared source_team_id", () => {
    const teams = resolveTeams(doublesDraw().entries);
    expect(teams).toHaveLength(2);
    const t1 = teams.find((t) => t.sourceTeamId === "T-1")!;
    expect(t1.registrationIds).toEqual(["reg-a1", "reg-a2"]);
    expect(t1.sourceActivityIds).toEqual(["AID-1001", "AID-1002"]);
    expect(t1.seed).toBe(1);
  });

  it("falls back to partner_registration_id when no team id, else solo", () => {
    const paired = resolveTeams([
      entry({ registrationId: "r1", partnerRegistrationId: "r2", sourceActivityId: "A1" }),
      entry({ registrationId: "r2", partnerRegistrationId: "r1", sourceActivityId: "A2" }),
    ]);
    expect(paired).toHaveLength(1);
    expect(paired[0]!.registrationIds).toEqual(["r1", "r2"]);

    const solo = resolveTeams([entry({ registrationId: "s1", sourceActivityId: "A9" })]);
    expect(solo).toHaveLength(1);
    expect(solo[0]!.registrationIds).toEqual(["s1"]);
  });
});

describe("matchIdentity", () => {
  it("is stable and symmetric across A/B ordering", () => {
    const teams = resolveTeams(doublesDraw().entries);
    const ab = match({ matchId: "x", teamARegId: "reg-a1", teamBRegId: "reg-b1" });
    const ba = match({ matchId: "x", teamARegId: "reg-b1", teamBRegId: "reg-a1" });
    expect(matchIdentity(LABEL, ab, teams)).toBe(matchIdentity(LABEL, ba, teams));
  });

  it("uses preserved PB.com activity ids, not registration ids", () => {
    const teams = resolveTeams(doublesDraw().entries);
    const id = matchIdentity(LABEL, match({ matchId: "x", teamARegId: "reg-a1", teamBRegId: "reg-b1" }), teams);
    expect(id).toContain("AID-1001,AID-1002");
    expect(id).toContain("AID-2001,AID-2002");
    expect(id).not.toContain("reg-a1");
  });

  it("distinguishes stage/bracket/round/position", () => {
    const teams = resolveTeams(doublesDraw().entries);
    const rr = match({ matchId: "x", teamARegId: "reg-a1", teamBRegId: "reg-b1", stage: "round_robin", round: 1 });
    const po = match({ matchId: "x", teamARegId: "reg-a1", teamBRegId: "reg-b1", stage: "playoff", bracket: "final", round: 2 });
    expect(matchIdentity(LABEL, rr, teams)).not.toBe(matchIdentity(LABEL, po, teams));
  });
});

describe("scoreDigest / winnerSide", () => {
  it("derives the winning side from winner_reg_id membership", () => {
    const teams = resolveTeams(doublesDraw().entries);
    const m = match({ matchId: "m", teamARegId: "reg-a1", teamBRegId: "reg-b1", teamAScore: 11, teamBScore: 6, winnerRegId: "reg-a1" });
    expect(winnerSide(m, teams)).toBe("a");
    expect(scoreDigest(m, teams)).toBe("11-6/w:a");
  });

  it("winnerSide is b when the partner of team B won", () => {
    const teams = resolveTeams(doublesDraw().entries);
    const m = match({ matchId: "m", teamARegId: "reg-a1", teamBRegId: "reg-b1", teamAScore: 9, teamBScore: 11, winnerRegId: "reg-b2" });
    expect(winnerSide(m, teams)).toBe("b");
  });
});

describe("isPushable", () => {
  it("only completed matches with a real score + winner", () => {
    expect(isPushable(match({ matchId: "m", status: "pending" }))).toBe(false);
    expect(isPushable(match({ matchId: "m", status: "completed", teamAScore: 11, teamBScore: null, winnerRegId: "r" }))).toBe(false);
    expect(isPushable(match({ matchId: "m", status: "completed", teamAScore: 11, teamBScore: 6, winnerRegId: "r" }))).toBe(true);
  });
});

describe("computePlan (reconcile / delta)", () => {
  it("first run: create the bracket + push the one completed score, skip the pending", () => {
    const plan = computePlan(doublesDraw(), []);
    expect(plan.bracketToCreate).toBe(true);
    expect(plan.scoresToPush).toHaveLength(1);
    expect(plan.scoresToPush[0]!.matchId).toBe("m-1");
    expect(plan.notReady).toBe(1); // the pending final
    expect(plan.divisionComplete).toBe(false);
  });

  it("is idempotent: a second run with everything recorded pushes nothing", () => {
    const draw = doublesDraw();
    const teams = resolveTeams(draw.entries);
    const now = "2026-09-28T00:00:00Z";
    const ledger: PushLedgerEntry[] = [
      bracketLedgerEntry(LABEL, now),
      scoreLedgerEntry(
        { matchId: "m-1", identity: matchIdentity(LABEL, draw.matches[0]!, teams), digest: scoreDigest(draw.matches[0]!, teams), teamActivityIdsA: [], teamActivityIdsB: [] },
        now,
      ),
    ];
    const plan = computePlan(draw, ledger);
    expect(plan.bracketToCreate).toBe(false);
    expect(plan.scoresToPush).toHaveLength(0);
    expect(plan.alreadyPushed).toHaveLength(1);
  });

  it("re-pushes only a CORRECTED score", () => {
    const draw = doublesDraw();
    const teams = resolveTeams(draw.entries);
    const now = "2026-09-28T00:00:00Z";
    // Ledger holds an OLD score digest for m-1 → the current (different) score must re-push.
    const staleDigest = "9-11/w:b";
    const ledger: PushLedgerEntry[] = [
      bracketLedgerEntry(LABEL, now),
      { key: matchIdentity(LABEL, draw.matches[0]!, teams), kind: "score", scoreDigest: staleDigest, pushedAt: now },
    ];
    const plan = computePlan(draw, ledger);
    expect(plan.scoresToPush).toHaveLength(1);
    expect(plan.scoresToPush[0]!.digest).toBe("11-6/w:a");
  });

  it("reports orphaned ledger scores (match gone from the draw) and blocks completion", () => {
    const draw = doublesDraw();
    draw.matches = draw.matches.filter((m) => m.status !== "completed"); // remove m-1
    const ledger: PushLedgerEntry[] = [
      bracketLedgerEntry(LABEL, "t"),
      { key: `${divisionKeyOf(LABEL)}|AID-1001,AID-1002|AID-2001,AID-2002|round_robin|main|r1|p1`, kind: "score", scoreDigest: "11-6/w:a", pushedAt: "t" },
    ];
    const plan = computePlan(draw, ledger);
    expect(plan.orphaned).toHaveLength(1);
    expect(plan.divisionComplete).toBe(false);
  });

  it("divisionComplete only when bracket recorded, all scores pushed, none pending, no orphans", () => {
    const draw = doublesDraw();
    draw.matches = [draw.matches[0]!]; // only the completed match
    const teams = resolveTeams(draw.entries);
    const now = "t";
    const ledger: PushLedgerEntry[] = [
      bracketLedgerEntry(LABEL, now),
      { key: matchIdentity(LABEL, draw.matches[0]!, teams), kind: "score", scoreDigest: scoreDigest(draw.matches[0]!, teams), pushedAt: now },
    ];
    expect(computePlan(draw, ledger).divisionComplete).toBe(true);
  });
});
