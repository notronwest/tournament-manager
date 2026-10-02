import { describe, expect, it } from "vitest";
import {
  bracketLedgerEntry,
  computePlan,
  resolveTeams,
  scoreDigest,
  matchIdentity,
} from "../src/push/plan.js";
import {
  isSessionLapse,
  MemoryLedger,
  MemoryStateSink,
  runAutoPush,
  type AutoDriver,
  type DivisionPlan,
  type DrawSource,
} from "../src/push/run.js";
import { NoopAlerter } from "../src/alert.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DriverConfig } from "../src/config.js";
import type { BandeDraw, BandeEntry, PushLedger } from "../src/types.js";

/** An isolated lock path so parallel test files never contend for the real one. */
function lockPath(): string {
  return join(tmpdir(), `pbcom-test-${randomUUID()}.lock`);
}

// ── compact synthetic draw builder (no real member data) ──────────────────────
function entry(regId: string, partner: string, team: string, last: string): BandeEntry {
  return {
    registrationId: regId,
    eventId: "e",
    playerId: `p-${regId}`,
    firstName: "F",
    lastName: last,
    partnerRegistrationId: partner,
    seed: team === "T1" ? 1 : 2,
    sourceSystem: "pbcom",
    sourceActivityId: null,
    sourceTeamId: team,
    sourceAttendeeHeaderId: null,
    poolIndex: null,
  };
}

function draw(tid: string, label: string, opts: { withScore?: boolean } = {}): BandeDraw {
  const scored = !!opts.withScore;
  return {
    division: {
      eventId: `${tid}:${label}`,
      tournamentId: tid,
      name: label,
      sourceSystem: "pbcom",
      sourceDivisionLabel: label,
      format: "doubles",
      gender: "men",
      bracketType: "round_robin",
      teamsAdvancingToPlayoff: 0,
      playoffRounds: 1,
    },
    entries: [
      entry("a1", "a2", "T1", "Alpha"),
      entry("a2", "a1", "T1", "Bravo"),
      entry("b1", "b2", "T2", "Charlie"),
      entry("b2", "b1", "T2", "Delta"),
    ],
    matches: [
      {
        matchId: "m1",
        eventId: "e",
        stage: "round_robin",
        bracket: null,
        round: 1,
        position: 1,
        slotKey: null,
        teamARegId: "a1",
        teamBRegId: "b1",
        status: scored ? "completed" : "pending",
        teamAScore: scored ? 11 : null,
        teamBScore: scored ? 6 : null,
        winnerRegId: scored ? "a1" : null,
      },
    ],
  };
}

/** A source that returns different draws per tournament + a distinct active subset. */
class MapSource implements DrawSource {
  constructor(
    private readonly all: Record<string, BandeDraw[]>,
    private readonly active: Record<string, BandeDraw[]>,
  ) {}
  async listDivisionDraws(t: string): Promise<BandeDraw[]> {
    return this.all[t] ?? [];
  }
  async listActiveDivisionDraws(t: string): Promise<BandeDraw[]> {
    return this.active[t] ?? [];
  }
}

const CFG = {} as DriverConfig;
const memLedgerFor = (l: PushLedger) => () => l;

/** An error that mimics session.ts's PbcomLoginError (matched by name, not import). */
function loginError(): Error {
  return Object.assign(new Error("PB.com requires an email one-time code"), {
    name: "PbcomLoginError",
  });
}

describe("isSessionLapse", () => {
  it("matches a PbcomLoginError by name, not a generic error", () => {
    expect(isSessionLapse(loginError())).toBe(true);
    expect(isSessionLapse(new Error("boom"))).toBe(false);
    expect(isSessionLapse(null)).toBe(false);
  });
});

describe("runAutoPush — all-active discovery", () => {
  it("plans only ACTIVE, BOUND divisions (dry-run, no browser)", async () => {
    const source = new MapSource(
      { "t-1": [draw("t-1", "A"), draw("t-1", "B")], "t-2": [draw("t-2", "Z")] },
      { "t-1": [draw("t-1", "A")], "t-2": [draw("t-2", "Z")] },
    );
    const result = await runAutoPush(
      { tournamentIds: ["t-1"], dryRun: true }, // only t-1 is "bound"
      { cfg: CFG, source, ledgerFor: memLedgerFor(new MemoryLedger()) },
    );
    expect(result.ran).toBe(true);
    // Only t-1's ACTIVE division A — not B (inactive) and not t-2 (unbound).
    expect(result.divisions.map((d) => d.divisionLabel)).toEqual(["A"]);
  });
});

describe("runAutoPush — session lapse (no crash-loop)", () => {
  it("records needs_attention + alerts + exits cleanly when open() lapses", async () => {
    const source = new MapSource({ "t-1": [draw("t-1", "A")] }, { "t-1": [draw("t-1", "A")] });
    const stateSink = new MemoryStateSink();
    const alert = new NoopAlerter();
    const openDriver = async (): Promise<AutoDriver> => {
      throw loginError();
    };

    // Must NOT throw out of the loop.
    const result = await runAutoPush(
      { tournamentIds: ["t-1"], dryRun: false, forceHost: true, lockPath: lockPath() },
      { cfg: CFG, source, ledgerFor: memLedgerFor(new MemoryLedger()), stateSink, alert, openDriver },
    );

    expect(result.ran).toBe(true);
    expect(result.sessionLapsed).toBe(true);
    expect(result.divisions.every((d) => d.state === "needs_attention")).toBe(true);
    expect(stateSink.records.every((r) => r.state === "needs_attention")).toBe(true);
    expect(stateSink.records[0]!.detail).toMatch(/session expired/i);
    expect(alert.sent.map((a) => a.kind)).toContain("session-lapse");
  });

  it("handles a lapse that happens mid-tick (drive throws PbcomLoginError)", async () => {
    const source = new MapSource({ "t-1": [draw("t-1", "A")] }, { "t-1": [draw("t-1", "A")] });
    const stateSink = new MemoryStateSink();
    const alert = new NoopAlerter();
    const openDriver = async (): Promise<AutoDriver> => ({
      drive: async () => {
        throw loginError();
      },
      close: async () => {},
    });

    const result = await runAutoPush(
      { tournamentIds: ["t-1"], dryRun: false, forceHost: true, lockPath: lockPath() },
      { cfg: CFG, source, ledgerFor: memLedgerFor(new MemoryLedger()), stateSink, alert, openDriver },
    );
    expect(result.sessionLapsed).toBe(true);
    expect(stateSink.records.some((r) => r.state === "needs_attention")).toBe(true);
    expect(alert.sent.map((a) => a.kind)).toContain("session-lapse");
  });
});

describe("runAutoPush — driving + reconcile", () => {
  it("drives a work item, records the confirmed push, and persists running", async () => {
    const source = new MapSource({ "t-1": [draw("t-1", "A")] }, { "t-1": [draw("t-1", "A")] });
    const ledger = new MemoryLedger();
    const stateSink = new MemoryStateSink();
    const alert = new NoopAlerter();
    const openDriver = async (): Promise<AutoDriver> => ({
      drive: async (dp: DivisionPlan) => ({
        state: "running",
        recorded: [bracketLedgerEntry(dp.plan.divisionLabel, "t1")],
      }),
      close: async () => {},
    });

    const result = await runAutoPush(
      { tournamentIds: ["t-1"], dryRun: false, forceHost: true, lockPath: lockPath() },
      { cfg: CFG, source, ledgerFor: memLedgerFor(ledger), stateSink, alert, openDriver },
    );

    expect(result.ran).toBe(true);
    expect(result.sessionLapsed).toBe(false);
    expect(await ledger.list()).toHaveLength(1);
    expect(stateSink.records.some((r) => r.state === "running")).toBe(true);
    expect(alert.sent).toHaveLength(0); // a clean drive alerts nobody
  });

  it("a write that will not verify surfaces needs_attention + an out-of-sync alert (never silent)", async () => {
    const source = new MapSource({ "t-1": [draw("t-1", "A")] }, { "t-1": [draw("t-1", "A")] });
    const stateSink = new MemoryStateSink();
    const alert = new NoopAlerter();
    const openDriver = async (): Promise<AutoDriver> => ({
      drive: async () => ({ state: "error", recorded: [] }), // an unverified write
      close: async () => {},
    });

    const result = await runAutoPush(
      { tournamentIds: ["t-1"], dryRun: false, forceHost: true, lockPath: lockPath() },
      { cfg: CFG, source, ledgerFor: memLedgerFor(new MemoryLedger()), stateSink, alert, openDriver },
    );
    expect(result.divisions[0]!.state).toBe("needs_attention");
    expect(stateSink.records.some((r) => r.state === "needs_attention")).toBe(true);
    expect(alert.sent.some((a) => a.kind.startsWith("out-of-sync"))).toBe(true);
  });

  it("a tick with no delta opens NO browser (cheap no-op)", async () => {
    const scoredDraw = draw("t-1", "A", { withScore: true });
    const label = scoredDraw.division.sourceDivisionLabel!;
    const teams = resolveTeams(scoredDraw.entries);
    const completed = scoredDraw.matches[0]!;
    // Pre-record the bracket + the one completed score → nothing left to push.
    const ledger = new MemoryLedger([
      bracketLedgerEntry(label, "t1"),
      {
        key: matchIdentity(label, completed, teams),
        kind: "score",
        scoreDigest: scoreDigest(completed, teams),
        pushedAt: "t1",
      },
    ]);
    // Sanity: the plan really has no work.
    expect(computePlan(scoredDraw, await ledger.list()).divisionComplete).toBe(true);

    let opened = false;
    const openDriver = async (): Promise<AutoDriver> => {
      opened = true;
      throw new Error("should not open a session when there is no delta");
    };
    const stateSink = new MemoryStateSink();

    const result = await runAutoPush(
      { tournamentIds: ["t-1"], dryRun: false, forceHost: true, lockPath: lockPath() },
      { cfg: CFG, source: new MapSource({ "t-1": [scoredDraw] }, { "t-1": [scoredDraw] }), ledgerFor: memLedgerFor(ledger), stateSink, openDriver },
    );

    expect(opened).toBe(false);
    expect(result.ran).toBe(true);
    expect(result.divisions[0]!.state).toBe("completed");
  });
});

describe("runAutoPush — host gate", () => {
  it("refuses to drive when this host is not PBCOM-PUSH-HOST (and not forced)", async () => {
    const source = new MapSource({ "t-1": [draw("t-1", "A")] }, { "t-1": [draw("t-1", "A")] });
    let opened = false;
    const openDriver = async (): Promise<AutoDriver> => {
      opened = true;
      throw new Error("gate should have blocked this");
    };
    const result = await runAutoPush(
      { tournamentIds: ["t-1"], dryRun: false, forceHost: false, lockPath: lockPath() },
      { cfg: CFG, source, ledgerFor: memLedgerFor(new MemoryLedger()), openDriver },
    );
    expect(result.ran).toBe(false);
    expect(result.reason).toMatch(/PBCOM-PUSH-HOST/);
    expect(opened).toBe(false);
  });
});
