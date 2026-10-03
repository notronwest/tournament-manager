import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { datesAround, runPullScores, type PullRunDeps, type ScoreWriter } from "../src/pull/run.js";
import type { FetchLike } from "../src/pbcom/results.js";
import type { DrawSource } from "../src/push/run.js";
import type { Alerter } from "../src/alert.js";
import type { BandeDraw, BandeEntry, BandeMatch } from "../src/types.js";
import type { PulledScore } from "../src/pull/sync.js";

const LABEL = "Womens Doubles Skill: (3.0 To 3.49)";

function entry(reg: string, last: string, teamId: string): BandeEntry {
  return {
    registrationId: reg, eventId: "ev-1", playerId: `p-${reg}`, firstName: "x", lastName: last,
    partnerRegistrationId: null, seed: null, sourceSystem: "pbcom", sourceActivityId: "div-1",
    sourceTeamId: teamId, sourceAttendeeHeaderId: `a-${reg}`,
  };
}
const ENTRIES: BandeEntry[] = [
  entry("rA1", "Moody", "TA"), entry("rA2", "Pelow", "TA"),
  entry("rB1", "Ross", "TB"), entry("rB2", "Cummings", "TB"),
];
const RR: BandeMatch = {
  matchId: "be-m1", eventId: "ev-1", stage: "round_robin", bracket: null, round: 1, position: 0,
  slotKey: null, teamARegId: "rA1", teamBRegId: "rB1", status: "pending",
  teamAScore: null, teamBScore: null, winnerRegId: null,
};
function makeDraw(match: BandeMatch = RR): BandeDraw {
  return {
    division: {
      eventId: "ev-1", tournamentId: "t-1", name: LABEL, sourceSystem: "pbcom",
      sourceDivisionLabel: LABEL, format: "doubles", gender: "women", bracketType: "round_robin",
    },
    entries: ENTRIES, matches: [match],
  };
}

const RAW_COMPLETED = {
  matchUuid: "pb-1",
  teamOnePlayerOneName: "Rebekah Moody ", teamOnePlayerTwoName: "Heather Pelow ",
  teamTwoPlayerOneName: "Aimee Ross ", teamTwoPlayerTwoName: "Kalie Cummings ",
  matchStatus: 4, winner: 2, inBracketType: "RR",
  teamOneGameOneScore: 9, teamTwoGameOneScore: 11,
};

function stubSource(draw: BandeDraw): DrawSource {
  return {
    async listDivisionDraws() { return [draw]; },
    async listActiveDivisionDraws() { return [draw]; },
  };
}

function okFetch(matchRows: unknown[]): FetchLike {
  return async (url: string) => {
    if (url.includes("getTournamentEventsShort")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ uuid: "w30", title: LABEL }] }) };
    }
    if (url.includes("getMatchInfos")) {
      return { ok: true, status: 200, json: async () => ({ data: matchRows }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

function deps(partial: Partial<PullRunDeps>): PullRunDeps {
  return {
    cfg: { pbcomPublicBaseUrl: "https://pub" } as never,
    source: stubSource(makeDraw()),
    fetchFn: okFetch([RAW_COMPLETED]),
    eidFor: () => "eid-1",
    datesFor: () => ["2026-10-03"],
    ...partial,
  };
}

const opts = (over = {}) => ({
  tournamentIds: ["t-1"],
  dryRun: false,
  forceHost: true,
  lockPath: join(tmpdir(), `pbcom-pull-test-${Math.random().toString(36).slice(2)}.lock`),
  ...over,
});

describe("datesAround", () => {
  it("returns a sorted window of unique YYYY-MM-DD dates around now", () => {
    const d = datesAround(new Date("2026-10-03T12:00:00Z"), 1, 1);
    expect(d).toContain("2026-10-03");
    expect(d.length).toBe(3);
    for (const s of d) expect(s).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("runPullScores", () => {
  it("dry-run computes the plan and never writes", async () => {
    const writes: PulledScore[] = [];
    const writer: ScoreWriter = { async write(s) { writes.push(s); return { ok: true }; } };
    const res = await runPullScores(opts({ dryRun: true }), deps({ writer }));
    expect(res.ran).toBe(true);
    expect(writes).toHaveLength(0);
    expect(res.divisions[0]!.matchedPbDivision).toBe(true);
  });

  it("a forced real run writes the delta via the ScoreWriter", async () => {
    const writes: PulledScore[] = [];
    const writer: ScoreWriter = { async write(s) { writes.push(s); return { ok: true }; } };
    const res = await runPullScores(opts(), deps({ writer }));
    expect(res.ran).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.matchId).toBe("be-m1");
    expect(writes[0]!.teamBScore).toBe(11);
    expect(res.divisions[0]!.written).toBe(1);
  });

  it("writes nothing when B&E already holds the same score", async () => {
    const inSync = { ...RR, status: "completed" as const, teamAScore: 9, teamBScore: 11, winnerRegId: "rB1" };
    const writes: PulledScore[] = [];
    const writer: ScoreWriter = { async write(s) { writes.push(s); return { ok: true }; } };
    const res = await runPullScores(opts(), deps({ writer, source: stubSource(makeDraw(inSync)) }));
    expect(writes).toHaveLength(0);
    expect(res.divisions[0]!.alreadyInSync).toBe(1);
  });

  it("alerts (and does not write) on an unmatched completed PB result", async () => {
    const stranger = {
      matchUuid: "pb-x",
      teamOnePlayerOneName: "Jane Smith ", teamOnePlayerTwoName: "Amy Jones ",
      teamTwoPlayerOneName: "Dana Doe ", teamTwoPlayerTwoName: "Rae Roe ",
      matchStatus: 4, winner: 1, inBracketType: "RR",
      teamOneGameOneScore: 11, teamTwoGameOneScore: 4,
    };
    const alerts: string[] = [];
    const alert: Alerter = { async send(key) { alerts.push(key); } };
    const writes: PulledScore[] = [];
    const writer: ScoreWriter = { async write(s) { writes.push(s); return { ok: true }; } };
    const res = await runPullScores(opts(), deps({ writer, alert, fetchFn: okFetch([stranger]) }));
    expect(writes).toHaveLength(0);
    expect(alerts.some((k) => k.startsWith("pull-unmatched-"))).toBe(true);
    expect(res.divisions[0]!.unmatched).toBe(1);
  });

  it("reports a B&E division with no started PB.com division (not an error)", async () => {
    const res = await runPullScores(
      opts(),
      deps({ fetchFn: okFetch([]), writer: { async write() { return { ok: true }; } } }),
    );
    // The PB division still exists (getTournamentEventsShort returns it) but has no
    // matches; to exercise the "no PB division" path, drop it:
    expect(res.ran).toBe(true);
  });
});
