/**
 * The REVERSE poller executor (PB.com → B&E): every ~5 min on the mini, read the
 * PUBLIC results API, match each completed round-robin score onto its B&E match,
 * and write only the delta. Mirrors push/run.ts's discipline:
 *   • SINGLETON in code: the committed PBCOM-PUSH-HOST fact gates which machine runs
 *     (shared with the forward push — one host owns the PB.com bridge), plus a
 *     same-machine lock (a SEPARATE pbcom-pull.lock, so a pull and a push tick can
 *     overlap harmlessly — they touch different write targets).
 *   • FAIL-CLOSED: a completed PB match that maps to no B&E match is alerted, never
 *     written. No PB.com login is needed (public read); the only credential is the
 *     B&E service role, used by the ScoreWriter.
 *   • Idempotent: planPull compares against B&E's own current score, so a tick with
 *     nothing new writes nothing.
 *
 * Data access (B&E draw read, the score write, the public fetch) is behind
 * interfaces so this orchestration is unit-testable without a browser, a DB, or
 * the network — see tests/pullRun.test.ts.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Alerter } from "../alert.js";
import type { DriverConfig } from "../config.js";
import { log } from "../log.js";
import { FileLock, isPushHost, type DrawSource } from "../push/run.js";
import { planPull, divisionKeyOf, type PulledScore, type PullPlan } from "./sync.js";
import {
  discoverDivisions,
  fetchDivisionMatches,
  type FetchLike,
  type PbDivision,
} from "../pbcom/results.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PULL_LOCK_PATH = join(REPO_ROOT, "state", "pbcom-pull.lock");

/** Writes one resolved score into B&E (the record-pbcom-score edge function). */
export interface ScoreWriter {
  write(score: PulledScore, tournamentId: string): Promise<{ ok: boolean; detail?: string }>;
}

export interface PullRunOptions {
  /** The B&E tournaments bound to PB.com (from the binding config). */
  tournamentIds: string[];
  dryRun: boolean;
  forceHost?: boolean;
  lockPath?: string;
}

export interface PullRunDeps {
  cfg: DriverConfig;
  /** Reads the B&E draws (DbDrawSource in production; a stub in tests). */
  source: DrawSource;
  /** The public-API fetch (Node global fetch in production; a fake in tests). */
  fetchFn: FetchLike;
  /** Writes scores to B&E. Undefined in dry-run (never called). */
  writer?: ScoreWriter;
  /** Posts unmatched/divergence alerts. Optional (unset → logged + skipped). */
  alert?: Alerter;
  /** Resolve a tournament's PB.com eid (from the binding). */
  eidFor: (tournamentId: string) => string;
  /** The candidate dates to scan (division discovery). Defaults to a window around now (ET). */
  datesFor?: () => string[];
}

export interface PullDivisionResult {
  tournamentId: string;
  divisionLabel: string;
  /** Did a PB.com division (by title) match this B&E division this tick? */
  matchedPbDivision: boolean;
  written: number;
  alreadyInSync: number;
  unmatched: number;
  skippedMultiGame: number;
  notReady: number;
}

export interface PullRunResult {
  ran: boolean;
  reason?: string;
  divisions: PullDivisionResult[];
}

/**
 * A window of YYYY-MM-DD dates around `now` in America/New_York (the club's tz), so
 * the division-discovery grid finds divisions whichever tournament day it is.
 */
export function datesAround(now: Date, before = 3, after = 3, tz = "America/New_York"): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const out: string[] = [];
  for (let d = -before; d <= after; d++) {
    out.push(fmt.format(new Date(now.getTime() + d * 86_400_000)));
  }
  return [...new Set(out)];
}

/** Find the PB.com division whose title matches a B&E division label. */
function matchPbDivision(label: string, pbDivisions: PbDivision[]): PbDivision | undefined {
  const want = divisionKeyOf(label);
  return pbDivisions.find((d) => divisionKeyOf(d.title) === want);
}

/**
 * Run ONE reverse poll tick across the bound tournaments. Returns per-division
 * results. In dry-run, computes + logs the plan and writes nothing.
 */
export async function runPullScores(opts: PullRunOptions, deps: PullRunDeps): Promise<PullRunResult> {
  if (!opts.dryRun && !isPushHost(undefined, opts.forceHost)) {
    return { ran: false, reason: "not the designated PBCOM-PUSH-HOST", divisions: [] };
  }

  const lock = new FileLock(opts.lockPath ?? PULL_LOCK_PATH);
  if (!opts.dryRun && !lock.acquire()) {
    return { ran: false, reason: "another pull run holds the lock", divisions: [] };
  }

  const dates = (deps.datesFor ?? (() => datesAround(new Date())))();
  const results: PullDivisionResult[] = [];

  try {
    for (const tid of opts.tournamentIds) {
      const eid = deps.eidFor(tid);
      const draws = deps.source.listActiveDivisionDraws
        ? await deps.source.listActiveDivisionDraws(tid)
        : await deps.source.listDivisionDraws(tid);

      // Discover the started PB.com divisions once per tournament/tick.
      const pbDivisions = await discoverDivisions(
        deps.cfg.pbcomPublicBaseUrl,
        eid,
        dates,
        deps.fetchFn,
      );

      for (const draw of draws) {
        const label = draw.division.sourceDivisionLabel ?? draw.division.name;
        const pbDiv = matchPbDivision(label, pbDivisions);
        if (!pbDiv) {
          // Not started on PB.com yet (or a title mismatch) — nothing to sync. Logged,
          // not alerted (a not-yet-live division is normal).
          results.push({
            tournamentId: tid,
            divisionLabel: label,
            matchedPbDivision: false,
            written: 0,
            alreadyInSync: 0,
            unmatched: 0,
            skippedMultiGame: 0,
            notReady: 0,
          });
          continue;
        }

        const pbMatches = await fetchDivisionMatches(deps.cfg.pbcomPublicBaseUrl, pbDiv, deps.fetchFn);
        const plan: PullPlan = planPull(draw, pbMatches);

        let written = 0;
        if (opts.dryRun) {
          log.info("[pull dry-run] would sync", { tournamentId: tid, ...summarize(plan) });
        } else {
          if (!deps.writer) throw new Error("runPullScores: deps.writer is required for a real run");
          for (const score of plan.toWrite) {
            const res = await deps.writer.write(score, tid);
            if (res.ok) {
              written += 1;
            } else {
              log.warn("pull: score write failed (will retry next tick)", {
                matchId: score.matchId,
                pbMatchUuid: score.pbMatchUuid,
                detail: res.detail,
              });
            }
          }
        }

        // Fail-closed: surface a completed PB match that maps to no B&E match.
        if (plan.unmatched.length > 0) {
          await deps.alert?.send(
            `pull-unmatched-${tid}-${divisionKeyOf(label)}`,
            `⚠️ **PB.com → B&E sync: unmatched result** — division "${label}" has ` +
              `${plan.unmatched.length} completed PB.com match(es) with no B&E match ` +
              `(a roster/pool divergence). Scores were NOT written. First: ` +
              `${plan.unmatched[0]!.teamOneLastNames.join("/")} vs ` +
              `${plan.unmatched[0]!.teamTwoLastNames.join("/")} (${plan.unmatched[0]!.reason}).`,
          );
        }
        if (plan.skippedMultiGame > 0) {
          log.warn("pull: skipped best-of-N results (v1 maps single-game only)", {
            division: label,
            skipped: plan.skippedMultiGame,
          });
        }

        log.info("pull: division synced", {
          tournamentId: tid,
          division: label,
          written,
          ...summarize(plan),
        });
        results.push({
          tournamentId: tid,
          divisionLabel: label,
          matchedPbDivision: true,
          written,
          alreadyInSync: plan.alreadyInSync,
          unmatched: plan.unmatched.length,
          skippedMultiGame: plan.skippedMultiGame,
          notReady: plan.notReady,
        });
      }
    }
    return { ran: true, divisions: results };
  } finally {
    lock.release();
  }
}

function summarize(plan: PullPlan): Record<string, unknown> {
  return {
    toWrite: plan.toWrite.length,
    alreadyInSync: plan.alreadyInSync,
    unmatched: plan.unmatched.length,
    skippedMultiGame: plan.skippedMultiGame,
    notReady: plan.notReady,
  };
}
