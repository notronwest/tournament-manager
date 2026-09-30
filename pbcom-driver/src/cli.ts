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
class DbDrawSource implements DrawSource {
  constructor(private readonly cfg: DriverConfig) {
    if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey) {
      throw new MissingCredentials("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    }
  }

  async listDivisionDraws(tournamentId: string): Promise<BandeDraw[]> {
    // Lazy import so dry-runs / tests never require the dependency to be installed.
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(this.cfg.supabaseUrl!, this.cfg.supabaseServiceRoleKey!, {
      auth: { persistSession: false },
    });

    const { data: events, error: evErr } = await db
      .from("events")
      .select("id, tournament_id, name, source_system, source_division_label, format, gender, bracket_type")
      .eq("tournament_id", tournamentId)
      .eq("source_system", "pbcom")
      .is("deleted_at", null);
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

/** Build the real per-division drive callback (opens one PB.com session per run). */
function makeDrive(cfg: DriverConfig, bindingPath: string) {
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
    });
  };
}

function usage(): number {
  log.error(
    "usage: cli.ts push <tournamentId> <divisionLabel|ALL> [--dry-run] [--fixture f.json] [--force-host]",
  );
  return 1;
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (command !== "push" && command !== "verify") return usage();

  const pos = positionals();
  const tournamentId = pos[0];
  const rawLabel = pos[1];
  const fixture = opt("fixture");
  const dryRun = flag("dry-run") || command === "verify";

  if (!tournamentId) return usage();
  // divisionLabel is required for push (ALL = every division); optional for verify.
  const divisionLabel =
    rawLabel && rawLabel.toUpperCase() !== "ALL" ? rawLabel : undefined;
  if (command === "push" && !rawLabel) return usage();

  let cfg: DriverConfig;
  try {
    cfg = loadConfig(process.env, !dryRun); // creds required only for a real push
  } catch (err) {
    if (err instanceof MissingCredentials) {
      log.warn(err.message);
      return NO_CREDENTIALS; // clean no-credential skip, never a crash
    }
    throw err;
  }

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

  const ledger = new MemoryLedger(); // TODO(seam): DB-backed ledger at productionization
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
