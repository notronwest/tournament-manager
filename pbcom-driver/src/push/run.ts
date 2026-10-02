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
import type { Alerter } from "../alert.js";
import { MissingCredentials, type DriverConfig } from "../config.js";
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
      // The lock file exists — but is its holder still ALIVE? A crashed / Ctrl-C'd
      // run leaves a stale lock that would otherwise wedge EVERY future run (and the
      // unattended loop). If the recorded PID is gone, reclaim it; if alive, it's a
      // genuine concurrent run and we yield.
      if (!this.isStale()) return false;
      rmSync(this.path, { force: true });
      try {
        this.fd = openSync(this.path, "wx");
        writeSync(this.fd, `${process.pid}\n`);
        return true;
      } catch {
        return false;
      }
    }
  }

  /** True when the lock file's recorded PID is no longer a running process. */
  private isStale(): boolean {
    try {
      const pid = parseInt(readFileSync(this.path, "utf8").trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) return true; // empty/garbage → stale
      try {
        process.kill(pid, 0); // signal 0 = existence check; throws if no such process
        return false; // holder is alive → genuinely held
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ESRCH"; // no such process → stale
      }
    } catch {
      return true; // can't read the lock → treat as stale
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

/**
 * The narrow slice of the Supabase client the ledger + state sink use. Declared
 * so a test can inject a fake (the real PostgrestFilterBuilder is structurally
 * compatible: `.from().select().eq()` is awaitable, and `.upsert()` returns a
 * promise). Only the two shapes we call are modelled.
 */
export interface SupabaseLike {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: string): PromiseLike<{ data: Array<Record<string, unknown>> | null; error: { message: string } | null }>;
    };
    upsert(
      row: Record<string, unknown>,
      opts: { onConflict: string },
    ): PromiseLike<{ error: { message: string } | null }>;
  };
}

/**
 * Lazily build a service-role Supabase client. Same custody as DbDrawSource
 * (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, never committed). Lazy-imported so
 * dry-runs / tests never require @supabase to be installed.
 */
async function supabaseClient(cfg: DriverConfig): Promise<SupabaseLike> {
  if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey) {
    throw new MissingCredentials("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  }
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  }) as unknown as SupabaseLike;
}

/**
 * The DURABLE, DB-backed push ledger — the production seam that replaces
 * MemoryLedger for a real (unattended) run. Reads/writes public.pbcom_push_ledger
 * via the service-role key. Scoped to ONE tournament: list() returns only that
 * tournament's confirmed pushes, so the pure planner sees exactly what it did
 * before. record() UPSERTs on the (tournament, kind, entry_key) identity, so a
 * re-run of a corrected score updates the row instead of double-recording it.
 *
 * The in-memory MemoryLedger above stays for --fixture / dry-runs / tests.
 */
export class DbPushLedger implements PushLedger {
  constructor(
    private readonly cfg: DriverConfig,
    private readonly tournamentId: string,
    /** Injected client for tests; production builds the service-role client lazily. */
    private readonly injectedDb?: SupabaseLike,
  ) {
    if (!injectedDb && (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey)) {
      throw new MissingCredentials("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    }
  }

  private async db(): Promise<SupabaseLike> {
    return this.injectedDb ?? (await supabaseClient(this.cfg));
  }

  async list(): Promise<PushLedgerEntry[]> {
    const db = await this.db();
    const { data, error } = await db
      .from("pbcom_push_ledger")
      .select("entry_key, kind, score_digest, pushed_at")
      .eq("tournament_id", this.tournamentId);
    if (error) throw new Error(`read pbcom_push_ledger: ${error.message}`);
    return (data ?? []).map((r) => ({
      key: r.entry_key as string,
      kind: r.kind as "bracket" | "score",
      scoreDigest: (r.score_digest as string) ?? "",
      pushedAt: r.pushed_at as string,
    }));
  }

  async record(entry: PushLedgerEntry): Promise<void> {
    const db = await this.db();
    // The division key is the first segment of the identity (bracket key IS the
    // division key; a score identity starts with it). Kept as a column for
    // scoping + dashboards; it is not part of the uniqueness key.
    const divisionKey = entry.key.split("|")[0] ?? entry.key;
    const { error } = await db.from("pbcom_push_ledger").upsert(
      {
        tournament_id: this.tournamentId,
        division_key: divisionKey,
        kind: entry.kind,
        entry_key: entry.key,
        score_digest: entry.scoreDigest,
        pushed_at: entry.pushedAt,
      },
      { onConflict: "tournament_id,kind,entry_key" },
    );
    if (error) throw new Error(`record pbcom_push_ledger: ${error.message}`);
  }
}

// ── push-state sink (the D-0045 "out of sync" surface) ──────────────────────

/** One division's persisted lifecycle state, for the dashboard's out-of-sync surface. */
export interface DivisionStateRecord {
  tournamentId: string;
  divisionKey: string;
  divisionLabel: string;
  state: PushState;
  detail?: string;
}

/** Persists per-division push state (esp. needs_attention). Optional in a run. */
export interface PushStateSink {
  record(s: DivisionStateRecord): Promise<void>;
}

/** In-memory state sink for tests / dry-runs. Captures what was recorded. */
export class MemoryStateSink implements PushStateSink {
  public readonly records: DivisionStateRecord[] = [];
  async record(s: DivisionStateRecord): Promise<void> {
    this.records.push(s);
  }
}

/** DB-backed state sink → public.pbcom_push_state (one row per division). */
export class DbPushStateSink implements PushStateSink {
  constructor(
    private readonly cfg: DriverConfig,
    private readonly injectedDb?: SupabaseLike,
  ) {
    if (!injectedDb && (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey)) {
      throw new MissingCredentials("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    }
  }

  async record(s: DivisionStateRecord): Promise<void> {
    const db = this.injectedDb ?? (await supabaseClient(this.cfg));
    const { error } = await db.from("pbcom_push_state").upsert(
      {
        tournament_id: s.tournamentId,
        division_key: s.divisionKey,
        division_label: s.divisionLabel,
        state: s.state,
        detail: s.detail ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tournament_id,division_key" },
    );
    if (error) throw new Error(`record pbcom_push_state: ${error.message}`);
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
  /**
   * Only the ACTIVE pbcom divisions (events with status active/medal_round/complete)
   * — what the unattended auto loop pushes each tick. When a source does not
   * implement it, callers fall back to listDivisionDraws (fixtures are already the
   * active set).
   */
  listActiveDivisionDraws?(tournamentId: string): Promise<BandeDraw[]>;
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
  activeOnly = false,
): Promise<DivisionPlan[]> {
  const draws =
    activeOnly && source.listActiveDivisionDraws
      ? await source.listActiveDivisionDraws(tournamentId)
      : await source.listDivisionDraws(tournamentId);
  const ledgerEntries = await ledger.list();
  return draws.map((draw) => {
    const plan = computePlan(draw, ledgerEntries);
    return { draw, plan, state: stateFromPlan(plan) };
  });
}

/** True when a division's plan has something to drive onto PB.com this tick. */
export function hasWork(plan: PushPlan): boolean {
  return plan.bracketToCreate || plan.scoresToPush.length > 0;
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
  /**
   * Skip bracket creation and push ONLY the score delta onto an already-live bracket
   * — e.g. one the director built/verified by hand on PB.com (so the ledger has no
   * create record, but re-running the verify wizard would fail on a Running event).
   */
  scoreOnly?: boolean;
  maxAttempts?: number;
  /** Override the same-machine lock path (tests use an isolated one). */
  lockPath?: string;
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

  const lock = new FileLock(opts.lockPath ?? LOCK_PATH);
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

    if (opts.scoreOnly) {
      // Treat the bracket as already present (built by hand) — push scores only.
      divisions = divisions.map((dp) => ({ ...dp, plan: { ...dp.plan, bracketToCreate: false } }));
      log.info("score-only mode — skipping bracket create, pushing score delta onto the live bracket");
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

// ── auto / all-active mode (the unattended launchd loop) ─────────────────────

/**
 * Recognise the "PB.com session lapsed / would need the email OTP again"
 * condition WITHOUT importing session.ts (which pulls in playwright, so run.ts —
 * and its tests — stay browser-free). session.ts throws `PbcomLoginError` in
 * exactly this case; we match by name so a lapse never crash-loops the launchd
 * job — it records needs_attention, alerts, and exits cleanly.
 */
export function isSessionLapse(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "PbcomLoginError"
  );
}

const SESSION_LAPSE_DETAIL = "PB.com session expired — re-auth needed";
const SESSION_LAPSE_ALERT =
  "⚠️ **PB.com session expired** — the B&E → PickleballBrackets.com results push " +
  "needs a re-auth on the mini. It has recorded `needs_attention` and stopped " +
  "cleanly (no crash-loop). Fix: on the club mini, run the driver **headed** once " +
  "and complete the emailed code; it resumes automatically next tick.";

/** A PB.com session bound to a per-division drive, opened once per auto tick. */
export interface AutoDriver {
  /** Drive one division to PB.com (create-if-needed + score delta), verify-after-write. */
  drive(dp: DivisionPlan): Promise<{ state: PushState; recorded: PushLedgerEntry[] }>;
  /** Tear the session down (always called, even after an error). */
  close(): Promise<void>;
}

export interface AutoRunOptions {
  /** The B&E tournaments bound to PB.com (discovered from the binding config). */
  tournamentIds: string[];
  dryRun: boolean;
  forceHost?: boolean;
  /** Override the same-machine lock path (tests use an isolated one). */
  lockPath?: string;
}

export interface AutoRunDeps {
  cfg: DriverConfig;
  /** Draw source; the auto loop uses listActiveDivisionDraws (active/medal_round/complete). */
  source: DrawSource;
  /** A per-tournament ledger (DbPushLedger in production, MemoryLedger in tests). */
  ledgerFor: (tournamentId: string) => PushLedger;
  /** Persists per-division state for the dashboard's out-of-sync surface. Optional. */
  stateSink?: PushStateSink;
  /** Posts needs_attention alerts to Discord. Optional (unset → logged + skipped). */
  alert?: Alerter;
  /**
   * Opens ONE PB.com session for the tick and returns a driver bound to it.
   * Throws PbcomLoginError when the session has lapsed. Undefined in dry-run.
   */
  openDriver?: () => Promise<AutoDriver>;
}

export interface AutoDivisionResult {
  tournamentId: string;
  divisionLabel: string;
  state: PushState;
}

export interface AutoRunResult {
  ran: boolean;
  reason?: string;
  /** True when the PB.com session had lapsed — needs_attention recorded, alerted, clean exit. */
  sessionLapsed: boolean;
  divisions: AutoDivisionResult[];
}

interface PlannedDivision {
  tournamentId: string;
  ledger: PushLedger;
  dp: DivisionPlan;
}

/**
 * The unattended auto/poll run. Discovers every ACTIVE, PB.com-bound division
 * across the given tournaments, then for each with a delta: creates the bracket
 * if needed and pushes the score delta, verify-before-ledger. Idempotent — a
 * re-run pushes only what the ledger doesn't already confirm.
 *
 * Fail-closed + no crash-loop:
 *   • host + lock gates as runPush.
 *   • a lapsed PB.com session records needs_attention, alerts once, exits cleanly.
 *   • a write that will not verify (or an orphan) is surfaced as needs_attention
 *     (the D-0045 "out of sync" signal) + alerted — never a silent success, and
 *     the driver NEVER deletes on PB.com.
 *   • an unexpected per-division error is caught, surfaced, and the loop moves on.
 */
export async function runAutoPush(opts: AutoRunOptions, deps: AutoRunDeps): Promise<AutoRunResult> {
  if (!opts.dryRun && !isPushHost(HOST_FACT, opts.forceHost)) {
    return { ran: false, reason: "not the designated PBCOM-PUSH-HOST", sessionLapsed: false, divisions: [] };
  }

  const lock = new FileLock(opts.lockPath ?? LOCK_PATH);
  if (!opts.dryRun && !lock.acquire()) {
    return { ran: false, reason: "another push run holds the lock", sessionLapsed: false, divisions: [] };
  }

  try {
    // 1) Discover + plan every active, bound division. No browser.
    const planned: PlannedDivision[] = [];
    for (const tid of opts.tournamentIds) {
      const ledger = deps.ledgerFor(tid);
      const divisions = await planTournament(tid, deps.source, ledger, /* activeOnly */ true);
      for (const dp of divisions) planned.push({ tournamentId: tid, ledger, dp });
    }

    if (opts.dryRun) {
      for (const p of planned) log.info("[auto dry-run] would push", { tournamentId: p.tournamentId, ...summarizePlan(p.dp) });
      return {
        ran: true,
        reason: "dry-run",
        sessionLapsed: false,
        divisions: planned.map((p) => ({ tournamentId: p.tournamentId, divisionLabel: p.dp.plan.divisionLabel, state: p.dp.state })),
      };
    }

    const results: AutoDivisionResult[] = [];
    const recordState = async (p: PlannedDivision, state: PushState, detail?: string): Promise<void> => {
      await deps.stateSink?.record({
        tournamentId: p.tournamentId,
        divisionKey: divisionKeyOf(p.dp.plan.divisionLabel),
        divisionLabel: p.dp.plan.divisionLabel,
        state,
        detail,
      });
    };

    // 2) Divisions with nothing to push: just reflect their computed state. An
    //    orphan (a confirmed score whose match vanished) surfaces as out-of-sync.
    const workItems = planned.filter((p) => hasWork(p.dp.plan));
    for (const p of planned.filter((x) => !hasWork(x.dp.plan))) {
      await recordState(p, p.dp.state, p.dp.plan.orphaned.length ? "orphaned ledger score — PB.com out of sync" : undefined);
      results.push({ tournamentId: p.tournamentId, divisionLabel: p.dp.plan.divisionLabel, state: p.dp.state });
      if (p.dp.state === "needs_attention") {
        await deps.alert?.send(
          `out-of-sync-${p.tournamentId}-${divisionKeyOf(p.dp.plan.divisionLabel)}`,
          `⚠️ **PB.com out of sync** — division "${p.dp.plan.divisionLabel}" has ${p.dp.plan.orphaned.length} orphaned score(s) on PB.com (a re-draw or withdrawal). The driver never deletes on PB.com; a human must reconcile.`,
        );
      }
    }

    // Nothing to drive this tick — cheap no-op (no browser opened).
    if (workItems.length === 0) {
      log.info("auto: no delta to push this tick", { activeDivisions: planned.length });
      return { ran: true, reason: "no delta", sessionLapsed: false, divisions: results };
    }

    // 3) Open ONE session for the tick. A lapse → needs_attention + alert + clean exit.
    if (!deps.openDriver) throw new Error("runAutoPush: deps.openDriver is required for a real run");
    let driver: AutoDriver;
    try {
      driver = await deps.openDriver();
    } catch (err) {
      if (isSessionLapse(err)) {
        for (const p of workItems) {
          await recordState(p, "needs_attention", SESSION_LAPSE_DETAIL);
          results.push({ tournamentId: p.tournamentId, divisionLabel: p.dp.plan.divisionLabel, state: "needs_attention" });
        }
        await deps.alert?.send("session-lapse", SESSION_LAPSE_ALERT);
        log.warn("auto: PB.com session lapsed — recorded needs_attention, alerted, exiting cleanly");
        return { ran: true, reason: "session lapsed — needs_attention recorded", sessionLapsed: true, divisions: results };
      }
      throw err;
    }

    // 4) Drive each work item on the shared session, verify-before-ledger.
    let sessionLapsed = false;
    try {
      for (const p of workItems) {
        log.info("auto: pushing division", { tournamentId: p.tournamentId, ...summarizePlan(p.dp) });
        try {
          const { state, recorded } = await driver.drive(p.dp);
          for (const entry of recorded) await p.ledger.record(entry);
          // A write that would not verify comes back as "error" from the drive;
          // for the unattended loop that is the D-0045 out-of-sync signal, not a
          // transient retry — surface it as needs_attention (never silent success).
          const surfaced: PushState = state === "error" ? "needs_attention" : state;
          await recordState(p, surfaced, surfaced === "needs_attention" ? "a PB.com write did not verify" : undefined);
          results.push({ tournamentId: p.tournamentId, divisionLabel: p.dp.plan.divisionLabel, state: surfaced });
          if (surfaced === "needs_attention") {
            await deps.alert?.send(
              `out-of-sync-${p.tournamentId}-${divisionKeyOf(p.dp.plan.divisionLabel)}`,
              `⚠️ **PB.com out of sync** — a write for division "${p.dp.plan.divisionLabel}" did not read back on PickleballBrackets.com. It was NOT recorded (so it re-pushes next tick); if it persists a human must check PB.com.`,
            );
          }
          log.info("auto: division finished", { division: p.dp.plan.divisionLabel, state: surfaced });
        } catch (err) {
          if (isSessionLapse(err)) {
            // Session dropped mid-tick → stop driving, surface, alert once, exit clean.
            sessionLapsed = true;
            await recordState(p, "needs_attention", SESSION_LAPSE_DETAIL);
            results.push({ tournamentId: p.tournamentId, divisionLabel: p.dp.plan.divisionLabel, state: "needs_attention" });
            await deps.alert?.send("session-lapse", SESSION_LAPSE_ALERT);
            log.warn("auto: PB.com session lapsed mid-tick — recorded needs_attention, stopping");
            break;
          }
          // Any other per-division error: surface + alert, but keep the loop alive.
          const msg = String((err as Error)?.message ?? err);
          log.error("auto: division drive errored", { division: p.dp.plan.divisionLabel, error: msg });
          await recordState(p, "needs_attention", `drive error: ${msg}`);
          results.push({ tournamentId: p.tournamentId, divisionLabel: p.dp.plan.divisionLabel, state: "needs_attention" });
          await deps.alert?.send(
            `drive-error-${p.tournamentId}-${divisionKeyOf(p.dp.plan.divisionLabel)}`,
            `⚠️ **PB.com push errored** on division "${p.dp.plan.divisionLabel}": ${msg}. Recorded needs_attention; will retry next tick.`,
          );
        }
      }
    } finally {
      await driver.close().catch(() => {});
    }

    return { ran: true, sessionLapsed, divisions: results };
  } finally {
    lock.release();
  }
}

// Re-export the ledger-entry builders so the CLI's drive callback can record pushes.
export { bracketLedgerEntry, scoreLedgerEntry, initMachine, next };
export type { PushMachine };
