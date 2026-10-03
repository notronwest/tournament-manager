/**
 * pbcom-driver CLI — an ON-DEMAND, SUPERVISED-RUN tool (NOT a standing service).
 *
 *   tsx src/cli.ts push <tournamentId> <divisionLabel> [--dry-run] [--fixture f.json] [--force-host]
 *   tsx src/cli.ts push <tournamentId> ALL           [--dry-run] [--fixture f.json] [--force-host]
 *   tsx src/cli.ts verify <tournamentId> [<divisionLabel>] [--fixture f.json]
 *
 * `<divisionLabel>` is the PB.com division string (events.source_division_label), e.g.
 * "Mens Doubles Skill: (3.5 To 3.99)". Use ALL to push every pbcom-sourced division.
 *
 * `--dry-run` (and `verify`) never open a browser: they read the draw, plan the delta,
 * and print it. A real `push` enforces the singleton gates and drives PB.com through the
 * trace-filled Playwright flows, verifying each write before recording the ledger.
 *
 * Standing/unattended running (launchd on the mini, headless login) is a SEPARATE
 * INFRA-INTAKE decision — see DESIGN.md. This CLI is the on-demand supervised entry point.
 */
import { readFileSync } from "node:fs";
import { loadConfig, MissingCredentials, NO_CREDENTIALS, type DriverConfig } from "./config.js";
import { DiscordAlerter } from "./alert.js";
import { BindingError, loadBinding, resolveDivisionTarget, resolveEventBinding } from "./binding.js";
import { log } from "./log.js";
import type { BandeDraw } from "./types.js";
import { PbcomSession, withSession } from "./pbcom/session.js";
import { createBracketOnPbcom, submitScoreCard, probeDivisionBracket } from "./pbcom/driver.js";
import { rehearsalVerdict } from "./rehearse.js";
import { fetchAttendeesPartnersPages, parsePages } from "./pbcom/attendees.js";
import {
  buildPreflightReport,
  preflightClear,
  countByStatus,
  type BeDivision,
  type Check,
} from "./preflight.js";
import { buildReconcileReport, type DivisionReconcileInput } from "./reconcile.js";
import { divisionKeyOf, divisionSurnameCollisions } from "./push/plan.js";
import {
  DbPartnerData,
  runAutoLinkPartners,
  type PartnerScraper,
  type TournamentPartnerData,
} from "./push/linkPartners.js";
import type { ResolvedDivisionTarget } from "./binding.js";
import {
  bracketLedgerEntry,
  DbPushLedger,
  DbPushStateSink,
  initMachine,
  MemoryLedger,
  next,
  runAutoPush,
  runPush,
  scoreLedgerEntry,
  summarizePlan,
  type AutoDriver,
  type DivisionPlan,
  type DrawSource,
  type PushStateSink,
  type RunDeps,
} from "./push/run.js";
import type { PushState } from "./push/state.js";
import type { PushLedger, PushLedgerEntry } from "./types.js";
import { runPullScores, type ScoreWriter } from "./pull/run.js";
import type { PulledScore } from "./pull/sync.js";
import { PUBLIC_FETCH_HEADERS } from "./pbcom/results.js";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
/** Positional args after the command (skip node, script, command, and any --flags/values). */
function positionals(): string[] {
  const out: string[] = [];
  const args = process.argv.slice(3); // after node, script, command
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      // consume a value for known value-taking flags
      if (a === "--fixture") i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** A fixture-backed draw source for dry-runs / demos (no DB). */
class FixtureDrawSource implements DrawSource {
  constructor(private readonly path: string) {}
  async listDivisionDraws(_tournamentId: string): Promise<BandeDraw[]> {
    return JSON.parse(readFileSync(this.path, "utf8")) as BandeDraw[];
  }
}

/**
 * The production draw source: reads the pbcom-sourced divisions + entries + matches for a
 * tournament from the tournament-manager Supabase project, using the SERVICE-ROLE key.
 * READ-ONLY here — writes happen only on PB.com. Secrets come from the environment
 * (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY); nothing is committed.
 */
/** Events whose status means the division is live or finished — worth pushing (auto loop). */
const ACTIVE_EVENT_STATUSES = ["active", "medal_round", "complete"] as const;

class DbDrawSource implements DrawSource {
  constructor(private readonly cfg: DriverConfig) {
    if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey) {
      throw new MissingCredentials("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    }
  }

  /** All pbcom-sourced divisions of a tournament (manual/supervised push). */
  async listDivisionDraws(tournamentId: string): Promise<BandeDraw[]> {
    return this.readDraws(tournamentId, false);
  }

  /** Only ACTIVE pbcom divisions (active/medal_round/complete) — the unattended auto loop. */
  async listActiveDivisionDraws(tournamentId: string): Promise<BandeDraw[]> {
    return this.readDraws(tournamentId, true);
  }

  private async readDraws(tournamentId: string, activeOnly: boolean): Promise<BandeDraw[]> {
    // Lazy import so dry-runs / tests never require the dependency to be installed.
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(this.cfg.supabaseUrl!, this.cfg.supabaseServiceRoleKey!, {
      auth: { persistSession: false },
    });

    let eventsQuery = db
      .from("events")
      .select("id, tournament_id, name, source_system, source_division_label, format, gender, bracket_type")
      .eq("tournament_id", tournamentId)
      .eq("source_system", "pbcom")
      .is("deleted_at", null);
    if (activeOnly) eventsQuery = eventsQuery.in("status", ACTIVE_EVENT_STATUSES as unknown as string[]);
    const { data: events, error: evErr } = await eventsQuery;
    if (evErr) throw new Error(`read events: ${evErr.message}`);

    const draws: BandeDraw[] = [];
    for (const ev of events ?? []) {
      const { data: regs, error: rErr } = await db
        .from("event_registrations")
        .select(
          "id, event_id, player_id, partner_registration_id, seed, source_system, source_activity_id, source_team_id, source_attendee_header_id, players(first_name, last_name)",
        )
        .eq("event_id", ev.id)
        .is("deleted_at", null);
      if (rErr) throw new Error(`read event_registrations (${ev.id}): ${rErr.message}`);

      const { data: matches, error: mErr } = await db
        .from("matches")
        .select(
          "id, event_id, stage, bracket, round, position, slot_key, team_a_reg_id, team_b_reg_id, status, team_a_score, team_b_score, winner_reg_id",
        )
        .eq("event_id", ev.id);
      if (mErr) throw new Error(`read matches (${ev.id}): ${mErr.message}`);

      draws.push({
        division: {
          eventId: ev.id,
          tournamentId: ev.tournament_id,
          name: ev.name,
          sourceSystem: ev.source_system,
          sourceDivisionLabel: ev.source_division_label,
          format: ev.format,
          gender: ev.gender,
          bracketType: ev.bracket_type,
        },
        entries: (regs ?? []).map((r) => {
          const player = Array.isArray(r.players) ? r.players[0] : r.players;
          return {
            registrationId: r.id,
            eventId: r.event_id,
            playerId: r.player_id,
            firstName: player?.first_name ?? "",
            lastName: player?.last_name ?? "",
            partnerRegistrationId: r.partner_registration_id,
            seed: r.seed,
            sourceSystem: r.source_system,
            sourceActivityId: r.source_activity_id,
            sourceTeamId: r.source_team_id,
            sourceAttendeeHeaderId: r.source_attendee_header_id,
          };
        }),
        matches: (matches ?? []).map((m) => ({
          matchId: m.id,
          eventId: m.event_id,
          stage: m.stage,
          bracket: m.bracket,
          round: m.round,
          position: m.position,
          slotKey: m.slot_key,
          teamARegId: m.team_a_reg_id,
          teamBRegId: m.team_b_reg_id,
          status: m.status,
          teamAScore: m.team_a_score,
          teamBScore: m.team_b_score,
          winnerRegId: m.winner_reg_id,
        })),
      });
    }
    return draws;
  }
}

/**
 * Drive ONE division to PB.com on an already-open session: create the bracket if
 * needed, then push the score delta, verify-before-ledger. Shared by the on-demand
 * per-run drive (makeDrive) and the unattended auto loop (makeOpenDriver), so the
 * orchestration lives in exactly one place. Returns "error" on a write that would
 * not verify (the caller decides whether that is a transient retry or the D-0045
 * out-of-sync signal); NEVER records an unverified push, NEVER deletes on PB.com.
 */
async function driveDivisionOnSession(
  session: PbcomSession,
  target: ResolvedDivisionTarget,
  dp: DivisionPlan,
): Promise<{ state: PushState; recorded: PushLedgerEntry[] }> {
  const recorded: PushLedgerEntry[] = [];
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
      log.warn("bracket create not verified", { division: dp.plan.divisionLabel, detail: res.detail });
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
      teamALastNames: s.teamALastNames,
      teamBLastNames: s.teamBLastNames,
      teamAFirstNames: s.teamAFirstNames,
      teamBFirstNames: s.teamBFirstNames,
      teamAScore: s.teamAScore,
      teamBScore: s.teamBScore,
      winnerSide: s.winnerSide,
    });
    if (!res.verified) {
      log.warn("score submit not verified", { matchId: s.matchId, detail: res.detail });
      machine = next(machine, "push_failed");
      return { state: machine.state, recorded };
    }
    recorded.push(scoreLedgerEntry(s, new Date().toISOString()));
    machine = next(machine, "score_pushed");
  }

  if (machine.state === "running" && dp.plan.notReady === 0 && dp.plan.orphaned.length === 0) {
    machine = next(machine, "all_complete");
  }
  return { state: machine.state, recorded };
}

/** Build the on-demand per-division drive callback (opens one PB.com session per division). */
function makeDrive(cfg: DriverConfig, bindingPath: string) {
  const binding = loadBinding(bindingPath);
  return async (dp: DivisionPlan): Promise<{ state: PushState; recorded: PushLedgerEntry[] }> => {
    const eventBinding = resolveEventBinding(binding, dp.draw.division.tournamentId);
    const target = resolveDivisionTarget(eventBinding, dp.draw.division);
    return withSession(cfg, (session) => driveDivisionOnSession(session, target, dp));
  };
}

/**
 * Build the auto loop's session opener: opens ONE PB.com session for the tick and
 * returns a driver that reuses it across every division. Throws PbcomLoginError
 * from open() when the session has lapsed — runAutoPush catches that and records
 * needs_attention + alerts rather than crash-looping.
 */
function makeOpenDriver(cfg: DriverConfig, bindingPath: string): () => Promise<AutoDriver> {
  const binding = loadBinding(bindingPath);
  return async (): Promise<AutoDriver> => {
    const session = new PbcomSession(cfg);
    await session.open(); // throws PbcomLoginError on a lapsed / OTP-required session
    return {
      drive: async (dp: DivisionPlan) => {
        const eventBinding = resolveEventBinding(binding, dp.draw.division.tournamentId);
        const target = resolveDivisionTarget(eventBinding, dp.draw.division);
        return driveDivisionOnSession(session, target, dp);
      },
      close: () => session.close(),
    };
  };
}

/**
 * Build the auto-linkage scraper opener: opens ONE PB.com session for the tick and
 * returns a scraper that drives the raS.aspx Attendees report per eid (reusing the
 * attendees.ts seam + pbPartners' pure parser). Throws PbcomLoginError from open()
 * on a lapsed session — runAutoLinkPartners catches that and alerts rather than
 * crash-looping, exactly like the push loop's makeOpenDriver.
 */
function makeOpenScraper(cfg: DriverConfig): () => Promise<PartnerScraper> {
  return async (): Promise<PartnerScraper> => {
    const session = new PbcomSession(cfg);
    await session.open(); // throws PbcomLoginError on a lapsed / OTP-required session
    return {
      scrape: async (eid: string) => {
        const pages = await fetchAttendeesPartnersPages(session, cfg.pbcomBaseUrl, eid);
        const entries = parsePages(pages);
        log.info("attendees: parsed partner entries", { eid, entries: entries.length });
        return entries;
      },
      close: () => session.close(),
    };
  };
}

/**
 * Run doubles partner-linkage for the given tournaments. Shared by the supervised
 * `link-partners <tid>` command and the unattended `poll` fold-in. DB-backed data +
 * service-role writes + Discord alerting on a real run; the cheap unpaired-doubles
 * pre-check means NO browser opens unless there is something to link.
 */
async function runLinkPartners(cfg: DriverConfig, tournamentIds: string[], dryRun: boolean): Promise<void> {
  if (tournamentIds.length === 0) {
    log.info("link: no bound tournaments — nothing to link");
    return;
  }
  if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey) {
    log.warn("link: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping partner linkage");
    return;
  }
  let binding;
  try {
    binding = loadBinding(cfg.bindingPath);
  } catch (err) {
    if (err instanceof BindingError) {
      log.warn("link: no usable binding config — nothing bound to PB.com", { error: err.message });
      return;
    }
    throw err;
  }

  const dataFor = (tid: string): TournamentPartnerData => new DbPartnerData(cfg, tid);
  const eidFor = (tid: string): string => resolveEventBinding(binding, tid).pbcomEid;
  const openScraper = dryRun ? undefined : makeOpenScraper(cfg);
  const alert = dryRun ? undefined : new DiscordAlerter(cfg.discordWebhook);

  const result = await runAutoLinkPartners(
    { tournamentIds, dryRun, forceHost: flag("force-host") },
    { cfg, dataFor, eidFor, openScraper, alert },
  );
  if (!result.ran) {
    log.warn("link: partner linkage did not run", { reason: result.reason });
    return;
  }
  for (const t of result.tournaments) {
    log.info("link tournament", {
      tournamentId: t.tournamentId,
      unpaired: t.unpaired,
      linked: t.linked,
      unchanged: t.unchanged,
      unlinked: t.unlinkedCount,
    });
  }
  log.info("link: partner linkage complete", {
    tournaments: result.tournaments.length,
    sessionLapsed: result.sessionLapsed,
  });
}

// ── sync safety: preflight + reconcile (read-only; write NOTHING) ────────────

/** Lazy service-role client, same custody as the draw source. */
async function serviceDb(cfg: DriverConfig) {
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(cfg.supabaseUrl!, cfg.supabaseServiceRoleKey!, { auth: { persistSession: false } });
}

const SPOT_HOLDING = ["pending_payment", "paid", "waitlisted_pending_payment"];

/** B&E's pbcom divisions + per-division roster facts for this tournament. */
async function readBeDivisions(cfg: DriverConfig, tournamentId: string): Promise<BeDivision[]> {
  const db = await serviceDb(cfg);
  const { data: events, error } = await db
    .from("events")
    .select("id, source_division_label, format")
    .eq("tournament_id", tournamentId)
    .eq("source_system", "pbcom")
    .is("deleted_at", null);
  if (error) throw new Error(`read events: ${error.message}`);
  const out: BeDivision[] = [];
  for (const ev of events ?? []) {
    const { data: regs, error: rErr } = await db
      .from("event_registrations")
      .select("id, partner_status, status")
      .eq("event_id", ev.id)
      .is("deleted_at", null)
      .in("status", SPOT_HOLDING);
    if (rErr) throw new Error(`read registrations: ${rErr.message}`);
    const rows = regs ?? [];
    const regCount = rows.length;
    const seekingDoubles = rows.filter((r) => (r.partner_status as string) === "seeking").length;
    const teamCount = (ev.format as string) === "singles" ? regCount : Math.ceil(regCount / 2);
    out.push({ label: (ev.source_division_label as string | null) ?? "", regCount, teamCount, seekingDoubles });
  }
  return out;
}

function fmtStatus(s: Check["status"]): string {
  return s === "pass" ? "✅ PASS" : s === "warn" ? "⚠️  WARN" : "❌ FAIL";
}

/**
 * PREFLIGHT — prove the whole B&E⇄PB.com map before the first write. Reads the
 * DB (config + rosters) and, unless --db-only, opens a READ-ONLY PB.com session
 * to scrape attendees and prove the live division map + auth. Writes nothing.
 * Exits non-zero if any check FAILS, so it can gate "clear to push?".
 */
async function runPreflight(cfg: DriverConfig, tournamentId: string, live: boolean): Promise<number> {
  if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey) {
    log.warn("preflight: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    return NO_CREDENTIALS;
  }
  let bindingOk = true;
  let eid: string | null = null;
  try {
    eid = resolveEventBinding(loadBinding(cfg.bindingPath), tournamentId).pbcomEid ?? null;
  } catch {
    bindingOk = false;
  }

  const beDivisions = await readBeDivisions(cfg, tournamentId);

  // The draws drive both the surname-collision scan and the live bracket probe.
  let draws: Awaited<ReturnType<DbDrawSource["listDivisionDraws"]>> = [];
  let surnameCollisions: { label: string; matches: number }[] | null = null;
  try {
    draws = await new DbDrawSource(cfg).listDivisionDraws(tournamentId);
    surnameCollisions = [];
    for (const draw of draws) {
      const groups = divisionSurnameCollisions(draw);
      const matches = groups.reduce((n, g) => n + g.matchIds.length, 0);
      if (matches > 0) {
        surnameCollisions.push({ label: draw.division.sourceDivisionLabel ?? draw.division.name, matches });
      }
    }
  } catch (err) {
    log.warn("preflight: surname-collision scan failed (skipping)", { error: String((err as Error)?.message ?? err) });
  }

  let pbcomEntryCounts: Map<string, number> | null = null;
  let sessionAuthenticated: boolean | null = null;
  let bracketProbes: { label: string; reachable: boolean; rows: number; expectedMatches: number }[] | null = null;
  if (live && eid && cfg.pbcomUsername) {
    const session = new PbcomSession(cfg);
    try {
      await session.open(); // throws on a lapsed / OTP-required session
      sessionAuthenticated = true;
      // (a) attendees → per-division registration counts (the roster map).
      const entries = parsePages(await fetchAttendeesPartnersPages(session, cfg.pbcomBaseUrl, eid));
      pbcomEntryCounts = new Map();
      for (const e of entries) {
        pbcomEntryCounts.set(e.divisionLabel, (pbcomEntryCounts.get(e.divisionLabel) ?? 0) + 1);
      }
      // (b) READ-ONLY probe of each division's live score page (write surface).
      const binding = loadBinding(cfg.bindingPath);
      const eventBinding = resolveEventBinding(binding, tournamentId);
      bracketProbes = [];
      for (const draw of draws) {
        const label = draw.division.sourceDivisionLabel ?? draw.division.name;
        try {
          const target = resolveDivisionTarget(eventBinding, draw.division);
          const probe = await probeDivisionBracket(session, target);
          bracketProbes.push({ label, reachable: probe.reachable, rows: probe.rows, expectedMatches: draw.matches.length });
        } catch (err) {
          log.warn("preflight: bracket probe failed", { division: label, error: String((err as Error)?.message ?? err) });
          bracketProbes.push({ label, reachable: false, rows: 0, expectedMatches: draw.matches.length });
        }
      }
    } catch (err) {
      sessionAuthenticated = false;
      log.warn("preflight: live PB.com check failed", { error: String((err as Error)?.message ?? err) });
    } finally {
      await session.close().catch(() => {});
    }
  }

  const checks = buildPreflightReport({
    baseUrl: cfg.pbcomBaseUrl,
    hasServiceRole: !!cfg.supabaseServiceRoleKey,
    hasUsername: !!cfg.pbcomUsername,
    bindingOk,
    eid,
    beDivisions,
    pbcomEntryCounts,
    sessionAuthenticated,
    surnameCollisions,
    bracketProbes,
  });

  const counts = countByStatus(checks);
  log.info(`\n── PREFLIGHT · tournament ${tournamentId} ──`);
  for (const c of checks) log.info(`  ${fmtStatus(c.status)}  ${c.name} — ${c.detail}`);
  log.info(
    `── ${counts.pass} pass · ${counts.warn} warn · ${counts.fail} fail — ${
      preflightClear(checks) ? "CLEAR to push ✅" : "NOT clear — resolve the ❌ above ⛔"
    } ──\n`,
  );
  return preflightClear(checks) ? 0 : 1;
}

/**
 * RECONCILE — "are we in sync?" read-only report, run any time. Compares B&E's
 * completed matches against the push ledger (what is CONFIRMED on PB.com), per
 * division. Exits non-zero if anything is pending or orphaned.
 */
async function runReconcile(cfg: DriverConfig, tournamentId: string): Promise<number> {
  if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey) {
    log.warn("reconcile: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    return NO_CREDENTIALS;
  }
  const db = await serviceDb(cfg);
  const { data: events, error } = await db
    .from("events")
    .select("id, source_division_label")
    .eq("tournament_id", tournamentId)
    .eq("source_system", "pbcom")
    .is("deleted_at", null);
  if (error) throw new Error(`read events: ${error.message}`);

  const entries = await new DbPushLedger(cfg, tournamentId).list();
  const scoreByDiv = new Map<string, number>();
  const bracketDivs = new Set<string>();
  for (const e of entries) {
    const dk = e.key.split("|")[0] ?? e.key;
    if (e.kind === "score") scoreByDiv.set(dk, (scoreByDiv.get(dk) ?? 0) + 1);
    else if (e.kind === "bracket") bracketDivs.add(dk);
  }

  const input: DivisionReconcileInput[] = [];
  for (const ev of events ?? []) {
    const label = (ev.source_division_label as string | null) ?? "";
    const dk = divisionKeyOf(label);
    const { data: matches, error: mErr } = await db
      .from("matches")
      .select("id, status, winner_reg_id")
      .eq("event_id", ev.id);
    if (mErr) throw new Error(`read matches: ${mErr.message}`);
    const ms = matches ?? [];
    const completedMatches = ms.filter((m) => (m.status as string) === "completed" || m.winner_reg_id != null).length;
    const confirmed = scoreByDiv.get(dk) ?? 0;
    input.push({
      label,
      completedMatches,
      confirmedScorePushes: confirmed,
      orphanedPushes: Math.max(0, confirmed - completedMatches),
      bracketConfirmed: bracketDivs.has(dk),
      hasBracket: ms.length > 0,
    });
  }

  const report = buildReconcileReport(input);
  const icon = (s: string): string =>
    s === "in_sync" ? "✅" : s === "pending" ? "⏳" : s === "needs_attention" ? "❌" : "·";
  log.info(`\n── RECONCILE · tournament ${tournamentId} ──`);
  for (const d of report.divisions) {
    log.info(
      `  ${icon(d.status)}  ${d.label || "(unlabeled)"} — ${d.completedMatches} done / ${d.confirmedScorePushes} on PB.com` +
        (d.pendingScorePushes > 0 ? ` · ${d.pendingScorePushes} PENDING` : "") +
        (d.orphanedPushes > 0 ? ` · ${d.orphanedPushes} ORPHANED` : "") +
        (d.bracketConfirmed ? "" : d.hasBracket ? " · bracket not yet on PB.com" : ""),
    );
  }
  log.info(
    `── ${report.totals.confirmedScorePushes}/${report.totals.completedMatches} scores confirmed on PB.com` +
      (report.totals.pendingScorePushes > 0 ? ` · ${report.totals.pendingScorePushes} pending` : "") +
      (report.totals.orphanedPushes > 0 ? ` · ${report.totals.orphanedPushes} orphaned` : "") +
      ` — ${report.inSync ? "IN SYNC ✅" : "NOT in sync ⚠️"} ──\n`,
  );
  return report.inSync ? 0 : 1;
}

/**
 * REHEARSE — drive ONE division end-to-end against the CONFIGURED PB.com (create
 * the bracket + push its completed scores), verify-after-write, with an IN-MEMORY
 * ledger so nothing persists. Proves the automated WRITE path actually works before
 * the real event. REFUSES the live host unless --allow-live, so a "rehearsal" can't
 * accidentally write to production.
 */
async function runRehearse(cfg: DriverConfig, tournamentId: string, divisionLabel: string): Promise<number> {
  if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey) {
    log.warn("rehearse: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    return NO_CREDENTIALS;
  }
  const base = cfg.pbcomBaseUrl ?? "https://pickleballbrackets.com";
  const isLive = base.includes("pickleballbrackets.com");
  if (isLive && !flag("allow-live")) {
    log.error(
      "rehearse: PBCOM_BASE_URL is the LIVE site — a rehearsal WRITES to PB.com. Point it at the training site " +
        "(PBCOM_BASE_URL=https://train.pickleballbrackets.dev) to rehearse safely, or pass --allow-live to rehearse " +
        "on a DISPOSABLE live division.",
    );
    return 1;
  }
  log.info(`\n── REHEARSAL · ${tournamentId} / "${divisionLabel}" ──`);
  log.info(
    `Driving ${base} end-to-end (create bracket + push completed scores), verify-after-write, NO DB ledger written. ` +
      `${isLive ? "⚠️  LIVE site (--allow-live)" : "training site"}.`,
  );

  const source: DrawSource = new DbDrawSource(cfg);
  const ledger = new MemoryLedger();
  const drive = makeDrive(cfg, cfg.bindingPath);
  const result = await runPush(
    { tournamentId, divisionLabel, dryRun: false, forceHost: true },
    { cfg, source, ledger, drive },
  );
  if (!result.ran) {
    log.warn("rehearse: did not run", { reason: result.reason });
    return 1;
  }
  let expected = 0;
  for (const dp of result.divisions) {
    expected += (dp.plan.bracketToCreate ? 1 : 0) + dp.plan.scoresToPush.length;
    log.info("rehearse division", { ...summarizePlan(dp), state: dp.state });
  }
  const verified = (await ledger.list()).length;
  const verdict = rehearsalVerdict(expected, verified);
  log.info(`── ${verdict.summary} ──\n`);
  return verdict.outcome === "failed" ? 1 : 0;
}

function usage(): number {
  log.error(
    "usage:\n" +
      "  cli.ts push <tournamentId> <divisionLabel|ALL> [--dry-run] [--fixture f.json] [--force-host]\n" +
      "  cli.ts verify <tournamentId> [<divisionLabel>] [--fixture f.json]\n" +
      "  cli.ts link-partners <tournamentId> [--dry-run] [--force-host]  # supervised doubles partner-linkage\n" +
      "  cli.ts preflight <tournamentId> [--live]                        # READ-ONLY: prove the B&E⇄PB.com map before pushing (--live opens PB.com)\n" +
      "  cli.ts reconcile <tournamentId>                                 # READ-ONLY: 'are we in sync?' — B&E vs confirmed PB.com pushes\n" +
      "  cli.ts rehearse <tournamentId> <divisionLabel> [--allow-live]   # DRESS-REHEARSAL: drive ONE division end-to-end (training site; no DB ledger)\n" +
      "  cli.ts poll [--dry-run] [--fixture f.json] [--force-host]      # unattended all-active: link partners + push\n" +
      "  cli.ts push --auto [...]                                        # alias for poll\n" +
      "  cli.ts poll-scores [<tournamentId>] [--dry-run] [--force-host]  # REVERSE: pull completed scores PB.com → B&E (public API, no login)",
  );
  return 1;
}

/** Distinct tournament ids present in a fixture (auto dry-run without a binding). */
function fixtureTournamentIds(path: string): string[] {
  const draws = JSON.parse(readFileSync(path, "utf8")) as BandeDraw[];
  return [...new Set(draws.map((d) => d.division.tournamentId))];
}

/**
 * The UNATTENDED auto/poll path: discover every active, PB.com-bound division and
 * push each division's delta. Durable DB ledger + state sink + Discord alerting on
 * a real run; MemoryLedger + no side effects for --fixture / --dry-run.
 */
async function runAutoMode(cfg: DriverConfig, fixture: string | undefined, dryRun: boolean): Promise<number> {
  let source: DrawSource;
  try {
    source = fixture ? new FixtureDrawSource(fixture) : new DbDrawSource(cfg);
  } catch (err) {
    if (err instanceof MissingCredentials) {
      log.warn(err.message);
      return NO_CREDENTIALS;
    }
    throw err;
  }

  // Discover the tournaments to poll: the binding config IS the set bound to PB.com.
  // A fixture run (no binding) derives them from the fixture's own draws.
  let tournamentIds: string[];
  try {
    tournamentIds = fixture ? fixtureTournamentIds(fixture) : loadBinding(cfg.bindingPath).events.map((e) => e.tournamentId);
  } catch (err) {
    if (err instanceof BindingError) {
      // No binding yet (or malformed): nothing is bound to PB.com, so there is
      // nothing to push. Exit 0 (not a crash-loop) with a loud log for the mini.
      log.warn("auto: no usable binding config — nothing bound to PB.com", { error: err.message });
      return 0;
    }
    throw err;
  }

  // Fold doubles partner-linkage into the standing poll: pair seeking doubles from
  // the raS.aspx Attendees page BEFORE pushing, so brackets are built on the correct
  // teams. DB-only (linkage needs the real players/registrations); skipped for a
  // --fixture run. Best-effort: linkage catches its own per-tournament errors and
  // never aborts the push that follows.
  if (!fixture) {
    try {
      await runLinkPartners(cfg, tournamentIds, dryRun);
    } catch (err) {
      if (err instanceof MissingCredentials) {
        log.warn(err.message);
      } else {
        log.error("link: partner linkage pass errored (continuing to push)", {
          error: String((err as Error)?.message ?? err),
        });
      }
    }
  }

  try {
    const useDb = !fixture;
    const ledgerFor = useDb
      ? (tid: string): PushLedger => new DbPushLedger(cfg, tid)
      : ((): ((tid: string) => PushLedger) => {
          const mem = new MemoryLedger();
          return () => mem;
        })();
    const stateSink: PushStateSink | undefined = dryRun || fixture ? undefined : new DbPushStateSink(cfg);
    const alert = dryRun || fixture ? undefined : new DiscordAlerter(cfg.discordWebhook);
    const openDriver = dryRun ? undefined : makeOpenDriver(cfg, cfg.bindingPath);

    const result = await runAutoPush(
      { tournamentIds, dryRun, forceHost: flag("force-host") },
      { cfg, source, ledgerFor, stateSink, alert, openDriver },
    );
    if (!result.ran) {
      log.warn("auto push did not run", { reason: result.reason });
      return 0;
    }
    for (const d of result.divisions) {
      log.info("auto division", { tournamentId: d.tournamentId, division: d.divisionLabel, state: d.state });
    }
    log.info("auto push complete", { divisions: result.divisions.length, sessionLapsed: result.sessionLapsed });
    return 0;
  } catch (err) {
    if (err instanceof MissingCredentials) {
      log.warn(err.message);
      return NO_CREDENTIALS;
    }
    throw err;
  }
}

/**
 * The REVERSE write side (PB.com → B&E): POST a resolved score to the
 * record-pbcom-score edge function, authenticated with the service-role key
 * (service-to-service; the function re-checks the Bearer equals the service role).
 */
class EdgeFnScoreWriter implements ScoreWriter {
  constructor(private readonly cfg: DriverConfig) {
    if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey) {
      throw new MissingCredentials("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    }
  }

  async write(score: PulledScore, tournamentId: string): Promise<{ ok: boolean; detail?: string }> {
    const url = `${this.cfg.supabaseUrl}/functions/v1/record-pbcom-score`;
    const key = this.cfg.supabaseServiceRoleKey!;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          apikey: key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tournamentId,
          eventId: score.eventId,
          matchId: score.matchId,
          teamAScore: score.teamAScore,
          teamBScore: score.teamBScore,
          winnerRegId: score.winnerRegId,
          source: { system: "pbcom", matchUuid: score.pbMatchUuid },
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: String((err as Error)?.message ?? err) };
    }
  }
}

/**
 * The REVERSE poll path (PB.com → B&E): read the PUBLIC results API for every bound
 * tournament (or one, when a tid is given), match completed round-robin scores onto
 * B&E matches, and write the delta via the edge function. No PB.com login — a plain
 * public fetch. Fail-closed: an unmatched completed PB result is alerted, not written.
 */
async function runPullMode(cfg: DriverConfig, onlyTid: string | undefined, dryRun: boolean): Promise<number> {
  let source: DrawSource;
  try {
    source = new DbDrawSource(cfg);
  } catch (err) {
    if (err instanceof MissingCredentials) {
      log.warn(err.message);
      return NO_CREDENTIALS;
    }
    throw err;
  }

  let binding;
  try {
    binding = loadBinding(cfg.bindingPath);
  } catch (err) {
    if (err instanceof BindingError) {
      log.warn("pull: no usable binding config — nothing bound to PB.com", { error: err.message });
      return 0;
    }
    throw err;
  }

  const tournamentIds = onlyTid ? [onlyTid] : binding.events.map((e) => e.tournamentId);
  const eidFor = (tid: string): string => resolveEventBinding(binding, tid).pbcomEid;

  try {
    const writer = dryRun ? undefined : new EdgeFnScoreWriter(cfg);
    const alert = dryRun ? undefined : new DiscordAlerter(cfg.discordWebhook);
    const result = await runPullScores(
      { tournamentIds, dryRun, forceHost: flag("force-host") },
      { cfg, source, fetchFn: (url) => fetch(url, { headers: PUBLIC_FETCH_HEADERS }), writer, alert, eidFor },
    );
    if (!result.ran) {
      log.warn("pull did not run", { reason: result.reason });
      return 0;
    }
    for (const d of result.divisions) {
      log.info("pull division", {
        tournamentId: d.tournamentId,
        division: d.divisionLabel,
        matchedPb: d.matchedPbDivision,
        written: d.written,
        alreadyInSync: d.alreadyInSync,
        unmatched: d.unmatched,
        notReady: d.notReady,
      });
    }
    log.info("pull complete", { divisions: result.divisions.length });
    return 0;
  } catch (err) {
    if (err instanceof MissingCredentials) {
      log.warn(err.message);
      return NO_CREDENTIALS;
    }
    throw err;
  }
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (
    command !== "push" &&
    command !== "verify" &&
    command !== "poll" &&
    command !== "poll-scores" &&
    command !== "link-partners" &&
    command !== "preflight" &&
    command !== "reconcile" &&
    command !== "rehearse"
  ) {
    return usage();
  }

  const fixture = opt("fixture");
  const auto = command === "poll" || (command === "push" && flag("auto"));
  // preflight (unless --live) and reconcile never write — creds optional like a dry-run.
  const readOnly = command === "reconcile" || (command === "preflight" && !flag("live"));
  const dryRun = flag("dry-run") || command === "verify" || readOnly;

  // The reverse poller reads the PUBLIC PB.com API — it never needs a PB.com login,
  // so its credential requirement is the B&E service role only (enforced by
  // DbDrawSource / EdgeFnScoreWriter), never PBCOM_USERNAME.
  const needsPbLogin = !dryRun && command !== "poll-scores";
  let cfg: DriverConfig;
  try {
    cfg = loadConfig(process.env, needsPbLogin); // PB creds required only for a real push
  } catch (err) {
    if (err instanceof MissingCredentials) {
      log.warn(err.message);
      return NO_CREDENTIALS; // clean no-credential skip, never a crash
    }
    throw err;
  }

  // ── read-only sync safety: preflight / reconcile <tournamentId> ──────────────
  if (command === "preflight") {
    const tid = positionals()[0];
    if (!tid) return usage();
    return runPreflight(cfg, tid, flag("live"));
  }
  if (command === "reconcile") {
    const tid = positionals()[0];
    if (!tid) return usage();
    return runReconcile(cfg, tid);
  }
  if (command === "rehearse") {
    const tid = positionals()[0];
    const divisionLabel = positionals()[1];
    if (!tid || !divisionLabel) return usage();
    return runRehearse(cfg, tid, divisionLabel);
  }

  if (auto) return runAutoMode(cfg, fixture, dryRun);

  // ── REVERSE sync: poll-scores [<tournamentId>] (PB.com → B&E) ────────────────
  // Read the public results API, mirror completed round-robin scores into B&E.
  // No tid → every bound tournament (the launchd entry). --dry-run plans only.
  if (command === "poll-scores") {
    return runPullMode(cfg, positionals()[0], dryRun);
  }

  // ── supervised doubles partner-linkage: link-partners <tournamentId> ─────────
  // The watched first live run (and the manual re-run): scrape raS.aspx + pair the
  // tournament's seeking doubles. Same path the poll fold-in uses, scoped to one tid.
  if (command === "link-partners") {
    const tid = positionals()[0];
    if (!tid) return usage();
    try {
      await runLinkPartners(cfg, [tid], dryRun);
    } catch (err) {
      if (err instanceof MissingCredentials) {
        log.warn(err.message);
        return NO_CREDENTIALS;
      }
      throw err;
    }
    return 0;
  }

  // ── manual / supervised push <tournamentId> <divisionLabel|ALL> ──────────────
  const pos = positionals();
  const tournamentId = pos[0];
  const rawLabel = pos[1];

  if (!tournamentId) return usage();
  // divisionLabel is required for push (ALL = every division); optional for verify.
  const divisionLabel = rawLabel && rawLabel.toUpperCase() !== "ALL" ? rawLabel : undefined;
  if (command === "push" && !rawLabel) return usage();

  let source: DrawSource;
  let ledger: PushLedger;
  try {
    source = fixture ? new FixtureDrawSource(fixture) : new DbDrawSource(cfg);
    // Durable ledger for a real/DB run (so a supervised re-run reconciles against
    // prior confirmed pushes); in-memory only for a fixture run.
    ledger = fixture ? new MemoryLedger() : new DbPushLedger(cfg, tournamentId);
  } catch (err) {
    if (err instanceof MissingCredentials) {
      log.warn(err.message);
      return NO_CREDENTIALS;
    }
    throw err;
  }

  const drive = dryRun ? undefined : makeDrive(cfg, cfg.bindingPath);

  const deps: RunDeps = { cfg, source, ledger, drive };
  const result = await runPush(
    { tournamentId, divisionLabel, dryRun, forceHost: flag("force-host") },
    deps,
  );
  if (!result.ran) {
    log.warn("push did not run", { tournamentId, reason: result.reason });
    return result.reason?.startsWith("no pbcom division") ? 1 : 0;
  }
  for (const dp of result.divisions) log.info("division", { tournamentId, ...summarizePlan(dp) });
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log.error("pbcom-driver failed", { error: String(err?.stack ?? err) });
    process.exit(1);
  },
);
