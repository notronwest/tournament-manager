/**
 * REVERSE structural mirror (PB.com → B&E) for the divisions that `poll-scores`
 * (name-match onto a PRE-BUILT single-RR B&E bracket) cannot handle:
 *   • a division with NO B&E bracket yet (beRR == 0) — e.g. a division that only
 *     ever got registered + started on PB.com, or the multi-pool ones that go live
 *     later in the weekend; and
 *   • a MULTI round-robin on PB.com (a pairing played 2x/3x) — name-matching is
 *     ambiguous there, so poll-scores fail-closes.
 *
 * For each such division it mirrors PB.com's round-robin matches 1-to-1 into B&E:
 * one B&E match per PB match (so repeated pairings are distinct rows, which solves
 * the multi-RR ambiguity), teams resolved by last-name set, scores copied for the
 * completed ones. Positions are assigned in PB matchUuid order (stable). The reconcile
 * is a delete-then-insert of the division's `round_robin` matches — safe because these
 * divisions have no hand-entered B&E scores to lose (B&E is the mirror; PB.com is where
 * play happens). It NEVER touches the pre-built single-RR divisions poll-scores owns.
 *
 * FAIL-CLOSED: if any PB pairing has no matching B&E team (a roster/name divergence,
 * e.g. truncated PB names), the whole division is skipped and reported — never a
 * partial/guessed mirror.
 *
 * Run from pbcom-driver/: `tsx deploy/mirror.mts [--write]` (default is a dry run).
 * The scheduled wrapper runs it with --write after poll-scores.
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
import { lastNameSetKey } from "../src/pbcom/matchMap.js";
import { loadBinding } from "../src/binding.js";
import { log } from "../src/log.js";

const WRITE = process.argv.includes("--write");

function datesWindow(now: Date, span = 3, tz = "America/New_York"): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const out = new Set<string>();
  for (let d = -span; d <= span; d++) out.add(fmt.format(new Date(now.getTime() + d * 86_400_000)));
  return [...out];
}

async function main(): Promise<number> {
  const cfg = loadConfig(process.env, false);
  if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey) {
    log.warn("mirror: SUPABASE creds not set — skipping");
    return 2;
  }
  let binding;
  try {
    binding = loadBinding(cfg.bindingPath);
  } catch {
    log.warn("mirror: no binding config — nothing bound");
    return 0;
  }

  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, { auth: { persistSession: false } });
  const fetchFn = (u: string) => fetch(u, { headers: PUBLIC_FETCH_HEADERS });
  const dates = datesWindow(new Date());

  for (const ev of binding.events) {
    const pbDivs = await discoverDivisions(cfg.pbcomPublicBaseUrl, ev.pbcomEid, dates, fetchFn);
    const { data: events } = await db
      .from("events")
      .select("id, name, source_division_label")
      .eq("tournament_id", ev.tournamentId)
      .eq("source_system", "pbcom")
      .is("deleted_at", null);

    for (const e of events ?? []) {
      const label = (e.source_division_label as string) ?? (e.name as string);
      const pd = pbDivs.find((d) => divisionKeyOf(d.title) === divisionKeyOf(label));
      if (!pd) continue; // not started on PB.com — nothing to mirror (never delete a bracket)

      const pm = (await fetchDivisionMatches(cfg.pbcomPublicBaseUrl, pd, fetchFn)).filter(isRoundRobin);
      if (pm.length === 0) continue;

      // Scope: only divisions poll-scores cannot handle (no bracket OR multi-RR).
      const { data: existing } = await db.from("matches").select("stage").eq("event_id", e.id);
      const beRR = (existing ?? []).filter((m: { stage: string }) => m.stage === "round_robin").length;
      const keys = pm.map((m) => pairKey(m));
      const maxRep = Math.max(0, ...countBy(keys));
      const needsMirror = beRR === 0 || maxRep > 1;
      if (!needsMirror) continue; // pre-built single-RR → poll-scores owns it

      // Resolve B&E teams.
      const { data: regs } = await db
        .from("event_registrations")
        .select("id, partner_registration_id, source_team_id, source_attendee_header_id, source_activity_id, seed, players(last_name)")
        .eq("event_id", e.id)
        .is("deleted_at", null);
      const entries = (regs ?? []).map((r) => {
        const rr = r as Record<string, unknown>;
        const players = rr.players as { last_name?: string } | { last_name?: string }[] | null;
        const last = (Array.isArray(players) ? players[0] : players)?.last_name ?? "";
        return {
          registrationId: rr.id as string,
          eventId: e.id as string,
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

      // Build the desired B&E match set, 1-to-1 with PB (stable matchUuid order).
      const sorted = [...pm].sort((a, b) => a.matchUuid.localeCompare(b.matchUuid));
      const rows: Record<string, unknown>[] = [];
      const unmapped: string[] = [];
      let pos = 0;
      let completed = 0;
      for (const m of sorted) {
        const ta = byKey.get(lastNameSetKey(m.teamOneLastNames));
        const tb = byKey.get(lastNameSetKey(m.teamTwoLastNames));
        if (!ta || !tb) {
          unmapped.push(`${m.teamOneLastNames.join("/")} vs ${m.teamTwoLastNames.join("/")}`);
          continue;
        }
        const row: Record<string, unknown> = {
          event_id: e.id,
          stage: "round_robin",
          round: 1,
          position: pos++,
          team_a_reg_id: ta.registrationIds[0],
          team_b_reg_id: tb.registrationIds[0],
          status: m.completed && !m.multiGame && usable(m) ? "completed" : "pending",
        };
        if (m.completed && !m.multiGame && usable(m)) {
          row.team_a_score = m.teamOneScore;
          row.team_b_score = m.teamTwoScore;
          row.winner_reg_id = (m.winner === 1 ? ta : tb).registrationIds[0];
          completed++;
        }
        rows.push(row);
      }

      if (unmapped.length > 0) {
        log.warn("mirror: SKIP division (unmapped teams — roster/name divergence)", {
          division: label,
          unmapped: unmapped.length,
          first: unmapped[0],
        });
        continue;
      }

      log.info(WRITE ? "mirror: writing" : "mirror: [dry] would write", {
        division: label,
        beRR,
        maxRep,
        create: rows.length,
        completed,
      });
      if (WRITE) {
        const del = await db.from("matches").delete().eq("event_id", e.id).eq("stage", "round_robin");
        if (del.error) {
          log.error("mirror: delete failed", { division: label, error: del.error.message });
          continue;
        }
        const ins = await db.from("matches").insert(rows);
        if (ins.error) log.error("mirror: insert failed", { division: label, error: ins.error.message });
        else log.info("mirror: wrote", { division: label, matches: rows.length, completed });
      }
    }
  }
  return 0;
}

function pairKey(m: PbPublicMatch): string {
  return [lastNameSetKey(m.teamOneLastNames), lastNameSetKey(m.teamTwoLastNames)].sort().join("|");
}
function countBy(keys: string[]): number[] {
  const c: Record<string, number> = {};
  for (const k of keys) c[k] = (c[k] ?? 0) + 1;
  return Object.values(c);
}
function usable(m: PbPublicMatch): boolean {
  return m.teamOneScore != null && m.teamTwoScore != null && m.winner != null;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log.error("mirror failed", { error: String(err?.stack ?? err) });
    process.exit(1);
  },
);
