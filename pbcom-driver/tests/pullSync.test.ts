import { describe, expect, it } from "vitest";
import { planPull } from "../src/pull/sync.js";
import { parseMatch, type PbPublicMatch } from "../src/pbcom/results.js";
import type { BandeDraw, BandeEntry, BandeMatch } from "../src/types.js";

// ── a minimal doubles division: team A = Moody/Pelow, team B = Ross/Cummings ──────
function entry(reg: string, last: string, teamId: string): BandeEntry {
  return {
    registrationId: reg,
    eventId: "ev-1",
    playerId: `p-${reg}`,
    firstName: "x",
    lastName: last,
    partnerRegistrationId: null,
    seed: null,
    sourceSystem: "pbcom",
    sourceActivityId: "div-1",
    sourceTeamId: teamId,
    sourceAttendeeHeaderId: `a-${reg}`,
  };
}

const ENTRIES: BandeEntry[] = [
  entry("rA1", "Moody", "TA"),
  entry("rA2", "Pelow", "TA"),
  entry("rB1", "Ross", "TB"),
  entry("rB2", "Cummings", "TB"),
];

function rrMatch(over: Partial<BandeMatch> = {}): BandeMatch {
  return {
    matchId: "be-m1",
    eventId: "ev-1",
    stage: "round_robin",
    bracket: null,
    round: 1,
    position: 0,
    slotKey: null,
    teamARegId: "rA1", // team A = Moody/Pelow
    teamBRegId: "rB1", // team B = Ross/Cummings
    status: "pending",
    teamAScore: null,
    teamBScore: null,
    winnerRegId: null,
    ...over,
  };
}

function draw(match: BandeMatch): BandeDraw {
  return {
    division: {
      eventId: "ev-1",
      tournamentId: "t-1",
      name: "Womens Doubles Skill: (3.0 To 3.49)",
      sourceSystem: "pbcom",
      sourceDivisionLabel: "Womens Doubles Skill: (3.0 To 3.49)",
      format: "doubles",
      gender: "women",
      bracketType: "round_robin",
    },
    entries: ENTRIES,
    matches: [match],
  };
}

// PB.com reports team one = Moody/Pelow, team two = Ross/Cummings, 9-11, team two won.
const PB_COMPLETED: PbPublicMatch = parseMatch({
  matchUuid: "pb-1",
  teamOnePlayerOneName: "Rebekah Moody ",
  teamOnePlayerTwoName: "Heather Pelow ",
  teamTwoPlayerOneName: "Aimee Ross ",
  teamTwoPlayerTwoName: "Kalie Cummings ",
  matchStatus: 4,
  winner: 2,
  inBracketType: "RR",
  teamOneGameOneScore: 9,
  teamTwoGameOneScore: 11,
});

describe("planPull", () => {
  it("writes a completed PB score onto the B&E match with correct orientation + winner", () => {
    const plan = planPull(draw(rrMatch()), [PB_COMPLETED]);
    expect(plan.toWrite).toHaveLength(1);
    const w = plan.toWrite[0]!;
    expect(w.matchId).toBe("be-m1");
    expect(w.eventId).toBe("ev-1");
    expect(w.pbMatchUuid).toBe("pb-1");
    expect(w.teamAScore).toBe(9); // A = Moody/Pelow = PB team one
    expect(w.teamBScore).toBe(11);
    expect(w.winnerRegId).toBe("rB1"); // PB winner 2 = Ross/Cummings = B&E team B
    expect(plan.unmatched).toHaveLength(0);
  });

  it("handles reversed orientation (PB team one = B&E team B)", () => {
    const reversed: PbPublicMatch = parseMatch({
      matchUuid: "pb-2",
      teamOnePlayerOneName: "Aimee Ross ",
      teamOnePlayerTwoName: "Kalie Cummings ",
      teamTwoPlayerOneName: "Rebekah Moody ",
      teamTwoPlayerTwoName: "Heather Pelow ",
      matchStatus: 4,
      winner: 1, // Ross/Cummings won
      inBracketType: "RR",
      teamOneGameOneScore: 11,
      teamTwoGameOneScore: 9,
    });
    const w = planPull(draw(rrMatch()), [reversed]).toWrite[0]!;
    expect(w.teamAScore).toBe(9); // A = Moody/Pelow is PB team TWO here
    expect(w.teamBScore).toBe(11);
    expect(w.winnerRegId).toBe("rB1"); // Ross/Cummings (B&E team B) won
  });

  it("skips a match B&E already holds identically (idempotent via B&E's own score)", () => {
    const inSync = rrMatch({ status: "completed", teamAScore: 9, teamBScore: 11, winnerRegId: "rB1" });
    const plan = planPull(draw(inSync), [PB_COMPLETED]);
    expect(plan.toWrite).toHaveLength(0);
    expect(plan.alreadyInSync).toBe(1);
  });

  it("re-writes when B&E holds a DIFFERENT (stale/corrected) score", () => {
    const stale = rrMatch({ status: "completed", teamAScore: 11, teamBScore: 2, winnerRegId: "rA1" });
    expect(planPull(draw(stale), [PB_COMPLETED]).toWrite).toHaveLength(1);
  });

  it("counts a not-yet-complete PB match as notReady, writes nothing", () => {
    const upcoming = parseMatch({
      matchUuid: "pb-3",
      teamOnePlayerOneName: "Rebekah Moody ",
      teamOnePlayerTwoName: "Heather Pelow ",
      teamTwoPlayerOneName: "Aimee Ross ",
      teamTwoPlayerTwoName: "Kalie Cummings ",
      matchStatus: 1,
      winner: 0,
      inBracketType: "RR",
      teamOneGameOneScore: 0,
      teamTwoGameOneScore: 0,
    });
    const plan = planPull(draw(rrMatch()), [upcoming]);
    expect(plan.toWrite).toHaveLength(0);
    expect(plan.notReady).toBe(1);
  });

  it("surfaces a completed PB match with no B&E match as unmatched (fail-closed), never writes it", () => {
    const stranger = parseMatch({
      matchUuid: "pb-x",
      teamOnePlayerOneName: "Jane Smith ",
      teamOnePlayerTwoName: "Amy Jones ",
      teamTwoPlayerOneName: "Dana Doe ",
      teamTwoPlayerTwoName: "Rae Roe ",
      matchStatus: 4,
      winner: 1,
      inBracketType: "RR",
      teamOneGameOneScore: 11,
      teamTwoGameOneScore: 4,
    });
    const plan = planPull(draw(rrMatch()), [stranger]);
    expect(plan.toWrite).toHaveLength(0);
    expect(plan.unmatched).toHaveLength(1);
    expect(plan.unmatched[0]!.reason).toBe("not_found");
  });

  it("skips a best-of-N PB result (v1 single-game only)", () => {
    const bo3 = parseMatch({
      matchUuid: "pb-bo3",
      teamOnePlayerOneName: "Rebekah Moody ",
      teamOnePlayerTwoName: "Heather Pelow ",
      teamTwoPlayerOneName: "Aimee Ross ",
      teamTwoPlayerTwoName: "Kalie Cummings ",
      matchStatus: 4,
      winner: 1,
      inBracketType: "RR",
      teamOneGameOneScore: 11,
      teamTwoGameOneScore: 7,
      teamOneGameTwoScore: 11,
      teamTwoGameTwoScore: 9,
    });
    const plan = planPull(draw(rrMatch()), [bo3]);
    expect(plan.toWrite).toHaveLength(0);
    expect(plan.skippedMultiGame).toBe(1);
  });

  it("ignores non-RR (playoff/bracket) PB matches in v1", () => {
    const playoff: PbPublicMatch = { ...PB_COMPLETED, matchUuid: "pb-po", inBracketType: "SE" };
    const plan = planPull(draw(rrMatch()), [playoff]);
    expect(plan.toWrite).toHaveLength(0);
    expect(plan.unmatched).toHaveLength(0);
  });
});
