import type { Database } from "../types/supabase";
import { buildSingleElimBracket } from "./playoffBracket";

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

// Circle / polygon-rotation round-robin scheduler. Teams must arrive in SEED
// ORDER (the console's buildTeams sorts by seed, unseeded last, before this
// runs). Returns the schedule as an ordered list of rounds; each round lists
// its real pairings, with bye pairings omitted.
//
// Round 1 is the "fold": seed i vs seed (n+1−i). For 7 seeded teams that is
// {1v7, 2v6, 3v5} with the MIDDLE seed (4) idle — exactly what
// PickleballBrackets.com schedules. We realize this by laying the seeds out
// with a phantom BYE inserted at the middle for odd counts, so the initial
// column-fold pairs the ends inward and the middle seed draws the bye; then
// we hold slot 0 fixed and rotate the rest (the canonical circle method),
// which yields n−1 rounds (even n) or n rounds (odd n, one bye per round) in
// which every unordered pair appears exactly once and each team plays at most
// once per round.
//
// CAVEAT: round 1 is verified against PB.com (the fold); rounds 2+ follow the
// canonical circle rotation and may not match PB.com's later-round ordering
// slot-for-slot. For a round robin that is cosmetic — the full set of games
// and the scoring (by player, not slot) are identical.
const RR_BYE = Symbol("rr-bye");
export function circleMethodRounds<T>(teams: T[]): [T, T][][] {
  const n = teams.length;
  if (n < 2) return [];
  type Slot = T | typeof RR_BYE;
  // Pad odd counts to an even slot count with a BYE placed at the middle, so
  // the opening fold idles the MIDDLE seed (PB.com's round 1) rather than seed 1.
  const slots: Slot[] =
    n % 2 === 0
      ? [...teams]
      : [...teams.slice(0, Math.ceil(n / 2)), RR_BYE, ...teams.slice(Math.ceil(n / 2))];
  const m = slots.length; // always even
  const rounds: [T, T][][] = [];
  let cur = slots.slice();
  for (let r = 0; r < m - 1; r++) {
    const round: [T, T][] = [];
    for (let k = 0; k < m / 2; k++) {
      const a = cur[k];
      const b = cur[m - 1 - k];
      if (a !== RR_BYE && b !== RR_BYE) round.push([a as T, b as T]);
    }
    rounds.push(round);
    // Hold slot 0 fixed; rotate the rest (move the last slot to the front of
    // the rotating tail). Direction is immaterial to correctness.
    cur = [cur[0], cur[m - 1], ...cur.slice(1, m - 1)];
  }
  return rounds;
}

// Build the round-robin schedule as match rows. Unlike the old naive C(n,2)
// nested loop (which marked EVERY match round 1 and let seed 1 play
// back-to-back), this schedules pairings into real ROUNDS via the circle
// method above, so each team plays at most once per round and round 1 is the
// PB.com fold.
//
// Keys / constraints:
//   * `position` increments GLOBALLY across pools and reps in schedule
//     (round-major) order, so every row in one generate has a distinct
//     position. That alone makes (event_id, stage, round, position) unique —
//     and, because it is emitted round-major within each pool, the display
//     helper packRoundRobinRounds (which re-derives rounds by walking matches
//     in position order) reproduces this exact schedule without change.
//   * Multi-pool (pool_count > 1): the circle method runs INDEPENDENTLY within
//     each pool (pairings never cross pools). Round numbers are per pool; the
//     global position counter keeps (round, position) unique across pools.
//   * play_each_team_times > 1: the whole schedule repeats, and each later rep
//     CONTINUES the round numbering after the previous rep's last round
//     (round = rep * roundsThisGroup + localRound). This keeps every team to
//     at most one match per round across the whole event, and the global
//     position counter keeps the repeated pairs at distinct positions so the
//     unique index allows the legitimate repeat.
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
      const rounds = circleMethodRounds(group);
      rounds.forEach((pairs, roundIdx) => {
        const round = rep * rounds.length + roundIdx + 1;
        for (const [a, b] of pairs) {
          rows.push({
            event_id: event.id,
            stage: "round_robin",
            round,
            position: position++,
            team_a_reg_id: a.captainRegId,
            team_b_reg_id: b.captainRegId,
            status: "pending",
          });
        }
      });
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
// R>=2: a single-elimination bracket from playoffBracket.buildSingleElimBracket
// (Top-4 → 2 rounds: semis → final + bronze; Top-6/8 → 3 rounds: play-in/
// quarters → semis → final + bronze). Seeding, byes, and bronze routing live
// in playoffBracket.ts; here each 1-based seed maps to a team reg id, byes /
// downstream placeholders stay empty (filled by feedForwardPlayoffWinners),
// the final round carries medalConfig and earlier rounds semiConfig.
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
    const seedReg = (seed: number | null) =>
      seed == null ? null : top[seed - 1].captainRegId;
    for (const b of buildSingleElimBracket(top.length)) {
      rows.push({
        event_id: event.id,
        stage: "playoff",
        round: b.round,
        position: b.position,
        team_a_reg_id: seedReg(b.seedA),
        team_b_reg_id: seedReg(b.seedB),
        status: "pending",
        ...(b.round === event.playoff_rounds ? medalConfig : semiConfig),
      });
    }
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
