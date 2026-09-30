/**
 * The push executor: singleton gate → lock → plan → drive → verify → record.
 *
 * Mirrors courtreserve-api's drain executors (events_drain / billing) discipline:
 *   • SINGLETON in code, not by install discipline. `reconcile.sh` copies this to
 *     every machine, so gating on "I only installed it once" is not a guarantee.
 *     Two independent gates: a committed PBCOM-PUSH-HOST fact (which host may drive)
 *     and a same-machine lock (no two overlapping runs on that host).
 *   • FAIL-CLOSED: an unset host fact drives NOWHERE; a missing credential is a clean
 *     skip; the ledger is recorded only after PB.com verify, so a crash mid-push
 *     re-reconciles cleanly instead of double-submitting.
 *   • DRY-RUN: compute and print the full plan (what WOULD be pushed) with no browser.
 *
 * Data access (reading the B&E draw, persisting the ledger) is behind interfaces so
 * the non-form logic here is fully unit-testable; the DB-backed implementations are
 * the documented production seams (see DESIGN.md §data).
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DriverConfig } from "../config.js";
import { log } from "../log.js";
import type { BandeDraw, PushLedger, PushLedgerEntry } from "../types.js";
import { initMachine, next, type PushMachine, type PushState } from "./state.js";
import {
  bracketLedgerEntry,
  computePlan,
  divisionKeyOf,
  scoreLedgerEntry,
  type PushPlan,
} from "./plan.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST_FACT = join(REPO_ROOT, "PBCOM-PUSH-HOST");
const LOCK_PATH = join(REPO_ROOT, "state", "pbcom-push.lock");

// ── singleton gate 1: committed host fact ──────────────────────────────────────

function thisHost(): string {
  return hostname().split(".")[0]!.trim();
}

/** The one host allowed to drive, from the committed fact. null = unset. */
export function designatedHost(factPath = HOST_FACT): string | null {
  let text: string;
  try {
    text = readFileSync(factPath, "utf8");
  } catch {
    return null;
  }
  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0]!.trim();
    if (line) return line;
  }
  return null;
}

/**
 * Gate 1. An UNSET fact means NOBODY drives (fail-closed on purpose: an accidentally
 * deleted fact must stop the fleet, not authorize every machine).
 */
export function isPushHost(factPath = HOST_FACT, force = false): boolean {
  if (force) return true;
  const want = designatedHost(factPath);
  if (!want) {
    log.warn("PBCOM-PUSH-HOST is unset — refusing to drive anywhere");
    return false;
  }
  return want.toLowerCase() === thisHost().toLowerCase();
}

// ── singleton gate 2: same-machine lock ────────────────────────────────────────

/** An exclusive lockfile (O_EXCL). Held for the run, released on exit or crash. */
export class FileLock {
  private fd: number | null = null;
  constructor(private readonly path: string = LOCK_PATH) {}

  acquire(): boolean {
    mkdirSync(dirname(this.path), { recursive: true });
    try {
      // 'wx' → fail if the file already exists = another run holds the lock.
      this.fd = openSync(this.path, "wx");
      writeSync(this.fd, `${process.pid}\n`);
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    if (this.fd != null) {
      closeSync(this.fd);
      this.fd = null;
      rmSync(this.path, { force: true });
    }
  }
}

// ── ledgers ────────────────────────────────────────────────────────────────────

/** In-memory ledger for tests and dry-runs. Production uses the DB-backed seam. */
export class MemoryLedger implements PushLedger {
  constructor(private entries: PushLedgerEntry[] = []) {}
  async list(): Promise<PushLedgerEntry[]> {
    return [...this.entries];
  }
  async record(entry: PushLedgerEntry): Promise<void> {
    this.entries = this.entries.filter((e) => !(e.kind === entry.kind && e.key === entry.key));
    this.entries.push(entry);
  }
}

// ── plan → state ────────────────────────────────────────────────────────────────

/** Derive the lifecycle state a division is in from its reconcile plan. */
export function stateFromPlan(plan: PushPlan): PushState {
  if (plan.orphaned.length > 0) return "needs_attention"; // drift a human must resolve
  if (plan.bracketToCreate) return "waiting";
  if (plan.divisionComplete) return "completed";
  return "running";
}

// ── data seams ───────────────────────────────────────────────────────────────

/** Reads the B&E draw(s) to push. DB-backed impl is the production seam. */
export interface DrawSource {
  /** All pbcom-sourced division draws for a tournament (events + regs + matches). */
  listDivisionDraws(tournamentId: string): Promise<BandeDraw[]>;
}

// ── planning (pure, no browser) ─────────────────────────────────────────────────

export interface DivisionPlan {
  draw: BandeDraw;
  plan: PushPlan;
  state: PushState;
}

/** Plan the push for every division of a tournament. No browser, no writes. */
export async function planTournament(
  tournamentId: string,
  source: DrawSource,
  ledger: PushLedger,
): Promise<DivisionPlan[]> {
  const draws = await source.listDivisionDraws(tournamentId);
  const ledgerEntries = await ledger.list();
  return draws.map((draw) => {
    const plan = computePlan(draw, ledgerEntries);
    return { draw, plan, state: stateFromPlan(plan) };
  });
}

/** Render a dry-run summary of what a push WOULD do (no side effects). */
export function summarizePlan(dp: DivisionPlan): Record<string, unknown> {
  return {
    division: dp.plan.divisionLabel,
    state: dp.state,
    teams: dp.plan.teams.length,
    bracketToCreate: dp.plan.bracketToCreate,
    scoresToPush: dp.plan.scoresToPush.length,
    alreadyPushed: dp.plan.alreadyPushed.length,
    notReady: dp.plan.notReady,
    orphaned: dp.plan.orphaned.length,
    complete: dp.plan.divisionComplete,
  };
}

// ── execution (drives the browser via the trace-filled seams) ────────────────────

export interface RunOptions {
  tournamentId: string;
  dryRun: boolean;
  /** Push only the division whose source_division_label matches (case/space-insensitive). */
  divisionLabel?: string;
  /** Ignore gate 1 for local debugging only. */
  forceHost?: boolean;
  maxAttempts?: number;
}

export interface RunDeps {
  cfg: DriverConfig;
  source: DrawSource;
  ledger: PushLedger;
  /**
   * Drives one division to PB.com via the trace-filled seams. Injected so the
   * orchestration is testable without a browser. Returns the machine's end state.
   * Left undefined in dry-run (never called).
   */
  drive?: (dp: DivisionPlan) => Promise<{ state: PushState; recorded: PushLedgerEntry[] }>;
}

export interface RunResult {
  ran: boolean;
  reason?: string;
  divisions: DivisionPlan[];
}

/**
 * Top-level run. Enforces both singleton gates, then either previews (dry-run) or
 * drives. The actual per-division drive is delegated to `deps.drive` (which the CLI
 * wires to the Playwright seams); this function owns gating, locking, planning and
 * ledger bookkeeping so all of that is testable.
 */
export async function runPush(opts: RunOptions, deps: RunDeps): Promise<RunResult> {
  if (!opts.dryRun && !isPushHost(HOST_FACT, opts.forceHost)) {
    return { ran: false, reason: "not the designated PBCOM-PUSH-HOST", divisions: [] };
  }

  const lock = new FileLock();
  if (!opts.dryRun && !lock.acquire()) {
    return { ran: false, reason: "another push run holds the lock", divisions: [] };
  }

  try {
    let divisions = await planTournament(opts.tournamentId, deps.source, deps.ledger);
    if (opts.divisionLabel) {
      const want = divisionKeyOf(opts.divisionLabel);
      divisions = divisions.filter((d) => divisionKeyOf(d.plan.divisionLabel) === want);
      if (divisions.length === 0) {
        return { ran: false, reason: `no pbcom division matching "${opts.divisionLabel}"`, divisions: [] };
      }
    }

    if (opts.dryRun) {
      for (const dp of divisions) log.info("[dry-run] would push", summarizePlan(dp));
      return { ran: true, reason: "dry-run", divisions };
    }

    if (!deps.drive) throw new Error("runPush: deps.drive is required for a real run");
    for (const dp of divisions) {
      log.info("pushing division", summarizePlan(dp));
      const { state, recorded } = await deps.drive(dp);
      for (const entry of recorded) await deps.ledger.record(entry);
      log.info("division push finished", { division: dp.plan.divisionLabel, state });
    }
    return { ran: true, divisions };
  } finally {
    lock.release();
  }
}

// Re-export the ledger-entry builders so the CLI's drive callback can record pushes.
export { bracketLedgerEntry, scoreLedgerEntry, initMachine, next };
export type { PushMachine };
