import type { Database } from "../types/supabase";

// Match-generation is the source of bug #993: the round-robin and playoff
// generate paths INSERTed a fresh set of rows without first clearing the
// event's existing matches, so any second invocation (double-click, an
// effect re-firing, a partial regen) APPENDED a duplicate set. A real
// 5-team round-robin ended with 12 matches / 10 distinct pairs, two
// pairings duplicated with conflicting scores.
//
// The fix has two layers:
//   1. This module owns the row-builders (pure) and the idempotent
//      "replace" writers (delete-then-insert). The console page calls
//      these instead of hand-rolling `insert(rows)`, so a second call
//      REPLACES rather than APPENDS. Because they're plain functions over
//      a tiny client interface, they're unit-tested directly.
//   2. A DB unique index (migration 20260929120000) is the backstop, so a
//      regression — or a concurrent interleave that slips past the app —
//      still can't land duplicate rows.

export type MatchInsert = Database["public"]["Tables"]["matches"]["Insert"];

// The narrow slice of the supabase client these writers touch. Kept
// structural so tests can pass an in-memory fake, and so we don't depend
// on the (lagging) generated table types for the fluent surface.
export interface MatchDeleteChain extends PromiseLike<{ error: { message: string } | null }> {
  eq(column: string, value: string): MatchDeleteChain;
}
export interface MatchesWriteClient {
  from(table: "matches"): {
    delete(): MatchDeleteChain;
    insert(rows: MatchInsert[]): PromiseLike<{ error: { message: string } | null }>;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Round robin
// ─────────────────────────────────────────────────────────────────────

export interface RoundRobinEvent {
  id: string;
  pool_count: number;
  play_each_team_times: number;
}
export interface RoundRobinTeam {
  captainRegId: string;
  poolIndex: number | null;
}

// n-choose-2 pairings, generated once per `play_each_team_times`. Multi-pool:
// pairings only happen within a single pool. `position` increments GLOBALLY
// across pools and reps, so every row in one generate gets a distinct
// position — which is exactly what the (event_id, stage, round, position)
// unique index keys on. The same pair legitimately repeats when
// play_each_team_times > 1, and lands at a different position each rep, so
// the constraint allows it.
export function buildRoundRobinRows(
  event: RoundRobinEvent,
  teams: RoundRobinTeam[],
): MatchInsert[] {
  const rows: MatchInsert[] = [];
  let position = 0;
  const poolGroups: RoundRobinTeam[][] =
    event.pool_count > 1
      ? Array.from({ length: event.pool_count }, (_, idx) =>
          teams.filter((t) => t.poolIndex === idx + 1),
        )
      : [teams];
  for (let rep = 0; rep < event.play_each_team_times; rep++) {
    for (const group of poolGroups) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          rows.push({
            event_id: event.id,
            stage: "round_robin",
            round: 1,
            position: position++,
            team_a_reg_id: group[i].captainRegId,
            team_b_reg_id: group[j].captainRegId,
            status: "pending",
          });
        }
      }
    }
  }
  return rows;
}

// Idempotent round-robin generate. Clears the event's existing round-robin
// matches AND any dependent playoff matches (a re-generated round robin
// invalidates the standings the playoff seeded from), then inserts the
// fresh set. Safe when zero matches exist — the deletes are no-ops.
export async function replaceRoundRobinMatches(
  client: MatchesWriteClient,
  event: RoundRobinEvent,
  teams: RoundRobinTeam[],
): Promise<{ error: { message: string } | null }> {
  const delRr = await client
    .from("matches")
    .delete()
    .eq("event_id", event.id)
    .eq("stage", "round_robin");
  if (delRr.error) return delRr;
  const delPlayoff = await client
    .from("matches")
    .delete()
    .eq("event_id", event.id)
    .eq("stage", "playoff");
  if (delPlayoff.error) return delPlayoff;
  return client.from("matches").insert(buildRoundRobinRows(event, teams));
}

// ─────────────────────────────────────────────────────────────────────
// Single-elim / pairwise playoff
// ─────────────────────────────────────────────────────────────────────

export interface PlayoffEvent {
  id: string;
  playoff_rounds: number; // R
  medal_match_format: MatchInsert["match_format"];
  medal_points_to_win: number;
  medal_win_by: number;
  medal_minutes_per_game: number;
  semifinal_match_format: MatchInsert["match_format"];
  semifinal_points_to_win: number;
  semifinal_win_by: number;
  semifinal_minutes_per_game: number;
}
export interface PlayoffSeedTeam {
  captainRegId: string;
}

// Builds the playoff match rows from the already-seeded `top` teams.
// R=1: pairwise medal matches (seed1 v seed2), (seed3 v seed4), … — one
// row per pair, each carrying medalConfig.
// R=2 (N=4): two semis (1v4, 2v3) carrying semiConfig, plus round-2 gold +
// bronze placeholders (empty slots, filled by feedForwardPlayoffWinners)
// carrying medalConfig.
export function buildPlayoffRows(
  event: PlayoffEvent,
  top: PlayoffSeedTeam[],
): MatchInsert[] {
  const medalConfig = {
    match_format: event.medal_match_format,
    match_points_to_win: event.medal_points_to_win,
    match_win_by: event.medal_win_by,
    match_minutes_per_game: event.medal_minutes_per_game,
  } as const;
  const semiConfig = {
    match_format: event.semifinal_match_format,
    match_points_to_win: event.semifinal_points_to_win,
    match_win_by: event.semifinal_win_by,
    match_minutes_per_game: event.semifinal_minutes_per_game,
  } as const;

  const rows: MatchInsert[] = [];
  if (event.playoff_rounds === 1) {
    for (let i = 0; i < top.length; i += 2) {
      rows.push({
        event_id: event.id,
        stage: "playoff",
        round: 1,
        position: i / 2,
        team_a_reg_id: top[i].captainRegId,
        team_b_reg_id: top[i + 1].captainRegId,
        status: "pending",
        ...medalConfig,
      });
    }
  } else {
    rows.push({
      event_id: event.id,
      stage: "playoff",
      round: 1,
      position: 0,
      team_a_reg_id: top[0].captainRegId,
      team_b_reg_id: top[3].captainRegId,
      status: "pending",
      ...semiConfig,
    });
    rows.push({
      event_id: event.id,
      stage: "playoff",
      round: 1,
      position: 1,
      team_a_reg_id: top[1].captainRegId,
      team_b_reg_id: top[2].captainRegId,
      status: "pending",
      ...semiConfig,
    });
    rows.push({
      event_id: event.id,
      stage: "playoff",
      round: 2,
      position: 0,
      team_a_reg_id: null,
      team_b_reg_id: null,
      status: "pending",
      ...medalConfig,
    });
    rows.push({
      event_id: event.id,
      stage: "playoff",
      round: 2,
      position: 1,
      team_a_reg_id: null,
      team_b_reg_id: null,
      status: "pending",
      ...medalConfig,
    });
  }
  return rows;
}

// Idempotent playoff generate. Clears the event's existing playoff matches
// (mirrors "Reset playoff"), then inserts the fresh bracket. Round-robin
// matches are untouched. Safe when zero playoff matches exist.
export async function replacePlayoffMatches(
  client: MatchesWriteClient,
  eventId: string,
  rows: MatchInsert[],
): Promise<{ error: { message: string } | null }> {
  const del = await client
    .from("matches")
    .delete()
    .eq("event_id", eventId)
    .eq("stage", "playoff");
  if (del.error) return del;
  return client.from("matches").insert(rows);
}

// ─────────────────────────────────────────────────────────────────────
// Double elimination
// ─────────────────────────────────────────────────────────────────────

// Idempotent clear for the double-elimination generate. A DE event is
// entirely a playoff bracket (no round robin), so — mirroring "Reset
// bracket" — we clear every match in the event before the generator
// re-inserts. Kept separate from the insert because DE generation is a
// two-pass write (insert rows, then wire feeds by the new ids) that the
// console owns.
export async function clearEventMatches(
  client: MatchesWriteClient,
  eventId: string,
): Promise<{ error: { message: string } | null }> {
  return client.from("matches").delete().eq("event_id", eventId);
}
