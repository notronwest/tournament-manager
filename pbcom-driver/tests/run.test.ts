import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  designatedHost,
  isPushHost,
  MemoryLedger,
  planTournament,
  runPush,
  stateFromPlan,
  summarizePlan,
  type DrawSource,
} from "../src/push/run.js";
import { computePlan } from "../src/push/plan.js";
import type { BandeDraw } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "draws.synthetic.json");

function fixtureDraws(): BandeDraw[] {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as BandeDraw[];
}

class StubSource implements DrawSource {
  constructor(private draws: BandeDraw[]) {}
  async listDivisionDraws(): Promise<BandeDraw[]> {
    return this.draws;
  }
}

describe("host gate", () => {
  it("an unset fact designates nobody (fail-closed)", () => {
    const missing = join(HERE, "fixtures", "NO-SUCH-HOST-FACT");
    expect(designatedHost(missing)).toBeNull();
    expect(isPushHost(missing)).toBe(false);
  });
  it("force overrides the gate for local dev", () => {
    const missing = join(HERE, "fixtures", "NO-SUCH-HOST-FACT");
    expect(isPushHost(missing, true)).toBe(true);
  });
});

describe("stateFromPlan", () => {
  it("waiting when the bracket is not yet created", () => {
    const plan = computePlan(fixtureDraws()[0]!, []);
    expect(stateFromPlan(plan)).toBe("waiting");
  });
});

describe("planTournament (dry-run planning)", () => {
  it("plans each division without a browser", async () => {
    const plans = await planTournament("t-1", new StubSource(fixtureDraws()), new MemoryLedger());
    expect(plans).toHaveLength(1);
    expect(plans[0]!.plan.bracketToCreate).toBe(true);
    expect(plans[0]!.plan.scoresToPush).toHaveLength(1);
    expect(summarizePlan(plans[0]!).state).toBe("waiting");
  });
});

describe("runPush", () => {
  it("dry-run computes the plan and never drives", async () => {
    const drove = { called: false };
    const result = await runPush(
      { tournamentId: "t-1", dryRun: true },
      {
        cfg: {} as never,
        source: new StubSource(fixtureDraws()),
        ledger: new MemoryLedger(),
        drive: async () => {
          drove.called = true;
          return { state: "running", recorded: [] };
        },
      },
    );
    expect(result.ran).toBe(true);
    expect(drove.called).toBe(false);
    expect(result.divisions).toHaveLength(1);
  });

  it("a real run refuses when not the designated host", async () => {
    const result = await runPush(
      { tournamentId: "t-1", dryRun: false, forceHost: false },
      { cfg: {} as never, source: new StubSource(fixtureDraws()), ledger: new MemoryLedger() },
    );
    // No PBCOM-PUSH-HOST fact exists in the test worktree → gate refuses.
    expect(result.ran).toBe(false);
    expect(result.reason).toMatch(/designated/);
  });

  it("a forced real run drives each division and records confirmed pushes", async () => {
    const ledger = new MemoryLedger();
    const result = await runPush(
      { tournamentId: "t-1", dryRun: false, forceHost: true },
      {
        cfg: {} as never,
        source: new StubSource(fixtureDraws()),
        ledger,
        drive: async (dp) => ({
          state: "running",
          recorded: [{ key: `bracket:${dp.plan.divisionLabel}`, kind: "bracket", scoreDigest: "", pushedAt: "t" }],
        }),
      },
    );
    expect(result.ran).toBe(true);
    expect(await ledger.list()).toHaveLength(1);
  });
});
