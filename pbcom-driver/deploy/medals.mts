/**
 * REVERSE medal/playoff mirror (PB.com → B&E). The RR mirror (deploy/mirror.mts) +
 * poll-scores bring the pool games in; this brings the MEDALS in so B&E's public
 * results page shows a gold/silver/bronze podium above each bracket (and the division
 * reads as finished instead of "pool play in progress").
 *
 * PB.com's public playoff matches carry a bracket type: "GS" = the final (winner=gold,
 * loser=silver), "B" = the bronze match (winner=bronze), "W" = earlier rounds. B&E's
 * computeMedals needs only TWO rows to produce a 3-item podium: a `stage='playoff'`
 * gold/silver final at (round = events.playoff_rounds, position = 0) and a bronze at
 * (round = R, position = 1), both completed with winners set (web/src/lib/bracketTeams.ts).
 * So for each division whose PB final is completed we mirror exactly those two rows.
 *
 * Teams resolve by last-name set with the same relaxed match as the RR mirror (PB
 * truncates names). FAIL-CLOSED: if a finalist/bronze team doesn't map uniquely, the
 * division's medals are skipped + reported — never a guessed podium. Reconcile is
 * delete-then-insert of the division's `playoff` rows (safe: B&E has no hand-entered
 * playoff scores in the reverse model). We also set `events.status='complete'` for a
 * division that is done (final completed, or RR-only with every RR game completed) so
 * the ADMIN view reads finished too (the public page keys off the match rows, not status).
 *
 * Run from pbcom-driver/: `tsx deploy/medals.mts [--write]` (default dry run). The
 * scheduled wrapper runs it with --write after poll-scores + the RR mirror.
 */
import { loadConfig } from "../src/config.js";
import { resolveTeams } from "../src/push/plan.js";
import {
  discoverDivisions,
  fetchDivisionMatches,
  isRoundRobin,
  PUBLIC_FETCH_HEADERS,
  type PbPublicMatch,
} from "../src/pbcom/results.js";
import { divisionKeyOf } from "../src/pull/sync.js";
import { lastNameSetKey, relaxedSetMatch } from "../src/pbcom/matchMap.js";
import { loadBinding } from "../src/binding.js";
import { log } from "../src/log.js";
import type { BandeTeam } from "../src/types.js";

const WRITE = process.argv.includes("--write");

function datesWindow(now: Date, span = 3, tz = "America/New_York"): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const out = new Set<string>();
  for (let d = -span; d <= span; d++) out.add(fmt.format(new Date(now.getTime() + d * 86_400_000)));
  return [...out];
}

function resolveTeam(pbLastNames: string[], teams: BandeTeam[], byKey: Map<string, BandeTeam>): BandeTeam | null {
  const exact = byKey.get(lastNameSetKey(pbLastNames));
  if (exact) return exact;
  const hits = teams.filter((t) => relaxedSetMatch(pbLastNames, t.lastNames));
  return hits.length === 1 ? hits[0]! : null;
}

function usable(m: PbPublicMatch): boolean {
  return !m.multiGame && m.teamOneScore != null && m.teamTwoScore != null && m.winner != null;
}

async function main(): Promise<number> {
  const cfg = loadConfig(process.env, false);
  if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey) {
    log.warn("medals: SUPABASE creds not set — skipping");
    return 2;
  }
  let binding;
  try {
    binding = loadBinding(cfg.bindingPath);
  } catch {
    log.warn("medals: no binding config — nothing bound");
    return 0;
  }

  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, { auth: { persistSession: false } });
  const fetchFn = (u: string) => fetch(u, { headers: PUBLIC_FETCH_HEADERS });
  const dates = datesWindow(new Date());

  for (const bnd of binding.events) {
    const pbDivs = await discoverDivisions(cfg.pbcomPublicBaseUrl, bnd.pbcomEid, dates, fetchFn);
    const { data: events } = await db
      .from("events")
      .select("id, name, source_division_label, status, teams_advancing_to_playoff, playoff_rounds, bracket_type")
      .eq("tournament_id", bnd.tournamentId)
      .eq("source_system", "pbcom")
      .is("deleted_at", null);

    for (const e of events ?? []) {
      const ev = e as Record<string, unknown>;
      const label = (ev.source_division_label as string) ?? (ev.name as string);
      const eventId = ev.id as string;
      const pd = pbDivs.find((d) => divisionKeyOf(d.title) === divisionKeyOf(label));
      if (!pd) continue;

      const all = await fetchDivisionMatches(cfg.pbcomPublicBaseUrl, pd, fetchFn);
      const gs = all.find((m) => m.inBracketType.toUpperCase() === "GS" && m.completed);
      const bz = all.find((m) => m.inBracketType.toUpperCase() === "B" && m.completed);

      const advancing = (ev.teams_advancing_to_playoff as number) ?? 0;
      const isDoubleElim = ev.bracket_type === "double_elim";
      const R = (ev.playoff_rounds as number) ?? (advancing <= 2 ? 1 : 2);

      // ── medal rows ──────────────────────────────────────────────────────────────
      const rows: Record<string, unknown>[] = [];
      const unmapped: string[] = [];
      if (advancing > 0 && !isDoubleElim && gs) {
        const { data: regs } = await db
          .from("event_registrations")
          .select("id, partner_registration_id, source_team_id, source_attendee_header_id, source_activity_id, seed, players(last_name)")
          .eq("event_id", eventId)
          .is("deleted_at", null);
        const entries = (regs ?? []).map((r) => {
          const rr = r as Record<string, unknown>;
          const players = rr.players as { last_name?: string } | { last_name?: string }[] | null;
          const last = (Array.isArray(players) ? players[0] : players)?.last_name ?? "";
          return {
            registrationId: rr.id as string,
            eventId,
            playerId: "",
            firstName: "",
            lastName: last,
            partnerRegistrationId: (rr.partner_registration_id as string) ?? null,
            seed: (rr.seed as number) ?? null,
            sourceSystem: "pbcom" as const,
            sourceActivityId: (rr.source_activity_id as string) ?? null,
            sourceTeamId: (rr.source_team_id as string) ?? null,
            sourceAttendeeHeaderId: (rr.source_attendee_header_id as string) ?? null,
          };
        });
        const teams = resolveTeams(entries);
        const byKey = new Map(teams.map((t) => [lastNameSetKey(t.lastNames), t]));

        const medalRow = (m: PbPublicMatch, position: number): boolean => {
          const ta = resolveTeam(m.teamOneLastNames, teams, byKey);
          const tb = resolveTeam(m.teamTwoLastNames, teams, byKey);
          if (!ta || !tb || !usable(m)) return false;
          rows.push({
            event_id: eventId,
            stage: "playoff",
            round: R,
            position,
            team_a_reg_id: ta.registrationIds[0],
            team_b_reg_id: tb.registrationIds[0],
            status: "completed",
            team_a_score: m.teamOneScore,
            team_b_score: m.teamTwoScore,
            winner_reg_id: (m.winner === 1 ? ta : tb).registrationIds[0],
          });
          return true;
        };
        if (!medalRow(gs, 0)) unmapped.push("final");
        if (bz && !medalRow(bz, 1)) unmapped.push("bronze");
      }

      if (unmapped.length > 0) {
        log.warn("medals: SKIP (unmapped finalist/bronze team)", { division: label, unmapped });
        continue;
      }

      if (rows.length > 0) {
        log.info(WRITE ? "medals: writing" : "medals: [dry] would write", { division: label, R, rows: rows.length });
        if (WRITE) {
          const del = await db.from("matches").delete().eq("event_id", eventId).eq("stage", "playoff");
          if (del.error) {
            log.error("medals: delete playoff failed", { division: label, error: del.error.message });
            continue;
          }
          const ins = await db.from("matches").insert(rows);
          if (ins.error) {
            log.error("medals: insert playoff failed", { division: label, error: ins.error.message });
            continue;
          }
          log.info("medals: wrote", { division: label, gold_silver: true, bronze: rows.length > 1 });
        }
      }

      // ── status completion (admin view) ──────────────────────────────────────────
      // Done = the final is in (playoff division) OR every RR game completed (RR-only).
      const { data: ms } = await db.from("matches").select("status, stage").eq("event_id", eventId);
      const list = (ms ?? []) as { status: string; stage: string }[];
      const rr = list.filter((m) => m.stage === "round_robin");
      const rrAllDone = rr.length > 0 && rr.every((m) => m.status === "completed");
      const finalIn = rows.length > 0 || list.some((m) => m.stage === "playoff" && m.status === "completed");
      const done = advancing > 0 ? finalIn : rrAllDone;
      if (done && ev.status !== "complete") {
        log.info(WRITE ? "medals: marking complete" : "medals: [dry] would mark complete", { division: label });
        if (WRITE) {
          const up = await db.from("events").update({ status: "complete" }).eq("id", eventId);
          if (up.error) log.error("medals: status update failed", { division: label, error: up.error.message });
        }
      }
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log.error("medals failed", { error: String(err?.stack ?? err) });
    process.exit(1);
  },
);
