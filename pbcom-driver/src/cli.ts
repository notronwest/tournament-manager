/**
 * pbcom-driver CLI — the launchd entrypoint.
 *
 *   tsx src/cli.ts push  --tournament <id> [--dry-run] [--fixture draws.json] [--force-host]
 *   tsx src/cli.ts verify --tournament <id> [--fixture draws.json]
 *
 * `push --dry-run` and `verify` never open a browser: they plan and print. A real
 * `push` enforces the singleton gates and drives PB.com through the trace-filled seams.
 */
import { readFileSync } from "node:fs";
import { loadConfig, MissingCredentials, NO_CREDENTIALS } from "./config.js";
import { loadBinding, resolveDivisionTarget, resolveEventBinding } from "./binding.js";
import { log } from "./log.js";
import type { BandeDraw } from "./types.js";
import { withSession } from "./pbcom/session.js";
import { createBracketOnPbcom, submitScoreCard } from "./pbcom/driver.js";
import {
  bracketLedgerEntry,
  initMachine,
  MemoryLedger,
  next,
  runPush,
  scoreLedgerEntry,
  summarizePlan,
  type DivisionPlan,
  type DrawSource,
  type RunDeps,
} from "./push/run.js";
import type { PushState } from "./push/state.js";
import type { PushLedgerEntry } from "./types.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** A fixture-backed draw source for dry-runs / demos (no DB). */
class FixtureDrawSource implements DrawSource {
  constructor(private readonly path: string) {}
  async listDivisionDraws(_tournamentId: string): Promise<BandeDraw[]> {
    return JSON.parse(readFileSync(this.path, "utf8")) as BandeDraw[];
  }
}

/**
 * The production draw source: reads events/event_registrations/matches from the
 * tournament-manager DB. Documented seam — implement with the mini's DB access.
 */
class DbDrawSource implements DrawSource {
  constructor(private readonly _dbUrl: string) {}
  async listDivisionDraws(_tournamentId: string): Promise<BandeDraw[]> {
    // TODO(seam): SELECT the pbcom-sourced divisions + their entries + matches for
    // this tournament and map rows → BandeDraw[] (columns per src/types.ts). Reading
    // is safe/idempotent; keep it read-only here — writes happen only on PB.com.
    throw new Error("DbDrawSource not implemented — wire the tournament-manager DB read seam");
  }
}

/** Build the real per-division drive callback (opens one PB.com session per run). */
function makeDrive(deps: Pick<RunDeps, "cfg">, bindingPath: string) {
  const cfg = deps.cfg;
  const binding = loadBinding(bindingPath);
  return async (dp: DivisionPlan): Promise<{ state: PushState; recorded: PushLedgerEntry[] }> => {
    const eventBinding = resolveEventBinding(binding, dp.draw.division.tournamentId);
    const target = resolveDivisionTarget(eventBinding, dp.draw.division);
    const recorded: PushLedgerEntry[] = [];

    return withSession(cfg, async (session) => {
      let machine = initMachine();
      machine = next(machine, dp.plan.bracketToCreate ? "binding_ok_no_bracket" : "binding_ok_bracket_exists");

      if (dp.plan.bracketToCreate) {
        const res = await createBracketOnPbcom(session, target, {
          divisionLabel: dp.plan.divisionLabel,
          bracketType: dp.draw.division.bracketType,
          teams: dp.plan.teams,
          matches: dp.draw.matches,
        });
        if (!res.verified) {
          machine = next(machine, "bracket_failed");
          return { state: machine.state, recorded };
        }
        recorded.push(bracketLedgerEntry(dp.plan.divisionLabel, new Date().toISOString()));
        machine = next(machine, "bracket_created");
      }

      for (const s of dp.plan.scoresToPush) {
        const res = await submitScoreCard(session, target, {
          matchId: s.matchId,
          identity: s.identity,
          teamActivityIdsA: s.teamActivityIdsA,
          teamActivityIdsB: s.teamActivityIdsB,
          teamAScore: Number(s.digest.split("-")[0]),
          teamBScore: Number(s.digest.split("-")[1]?.split("/")[0]),
          winnerSide: s.digest.includes("w:a") ? "a" : "b",
        });
        if (!res.verified) {
          machine = next(machine, "push_failed");
          return { state: machine.state, recorded };
        }
        recorded.push(scoreLedgerEntry(s, new Date().toISOString()));
        machine = next(machine, "score_pushed");
      }

      // Mark complete only when this run left nothing outstanding. Definitive
      // completion is confirmed by the NEXT tick's re-reconcile (idempotent).
      if (machine.state === "running" && dp.plan.notReady === 0 && dp.plan.orphaned.length === 0) {
        machine = next(machine, "all_complete");
      }
      return { state: machine.state, recorded };
    });
  };
}

async function main(): Promise<number> {
  const command = process.argv[2];
  const tournamentId = arg("tournament");
  const fixture = arg("fixture");
  const dryRun = flag("dry-run") || command === "verify";

  if (command !== "push" && command !== "verify") {
    log.error("usage: cli.ts <push|verify> [--tournament <id>] [--dry-run] [--fixture f.json] [--force-host]");
    return 1;
  }

  let cfg;
  try {
    cfg = loadConfig(process.env, !dryRun); // creds required only for a real push
  } catch (err) {
    if (err instanceof MissingCredentials) {
      log.warn(err.message);
      return NO_CREDENTIALS; // clean no-credential skip, never a crash
    }
    throw err;
  }

  // A single --tournament, or every tournament in the binding config (the launchd
  // job invokes with no id and pushes all mapped tournaments).
  let tournamentIds: string[];
  if (tournamentId) {
    tournamentIds = [tournamentId];
  } else if (fixture) {
    tournamentIds = ["*fixture*"]; // the fixture source ignores the id
  } else {
    tournamentIds = loadBinding(cfg.bindingPath).events.map((e) => e.tournamentId);
    if (tournamentIds.length === 0) log.warn("no tournaments in the binding config — nothing to push");
  }

  const source: DrawSource = fixture
    ? new FixtureDrawSource(fixture)
    : new DbDrawSource(cfg.dbUrl ?? "");
  const ledger = new MemoryLedger(); // TODO(seam): swap for the DB-backed ledger in production
  const drive = dryRun ? undefined : makeDrive({ cfg }, cfg.bindingPath);

  for (const id of tournamentIds) {
    const deps: RunDeps = { cfg, source, ledger, drive };
    const result = await runPush({ tournamentId: id, dryRun, forceHost: flag("force-host") }, deps);
    if (!result.ran) {
      log.warn("push did not run", { tournamentId: id, reason: result.reason });
      continue;
    }
    for (const dp of result.divisions) log.info("division", { tournamentId: id, ...summarizePlan(dp) });
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log.error("pbcom-driver failed", { error: String(err?.stack ?? err) });
    process.exit(1);
  },
);
