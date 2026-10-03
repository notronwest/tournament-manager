import { describe, it, expect } from "vitest";
import {
  buildRoundRobinRows,
  buildPlayoffRows,
  circleMethodRounds,
  replaceRoundRobinMatches,
  replacePlayoffMatches,
  clearEventMatches,
  type MatchInsert,
  type MatchesWriteClient,
} from "./matchGeneration";

// Helpers shared by the circle-method scheduling tests.
const pairKey = (a: unknown, b: unknown) => [a, b].map(String).sort().join("-");
// Group row pairs by round → the set of unordered pair keys per round.
function rowsByRound(rows: MatchInsert[]): Map<number, string[]> {
  const byRound = new Map<number, string[]>();
  for (const r of rows) {
    const arr = byRound.get(r.round as number) ?? [];
    arr.push(pairKey(r.team_a_reg_id, r.team_b_reg_id));
    byRound.set(r.round as number, arr);
  }
  return byRound;
}
// Assert no team plays twice in the same round (pool + rep aware via round #).
function assertAtMostOncePerRound(rows: MatchInsert[]) {
  const seen = new Map<number, Set<string>>();
  for (const r of rows) {
    const set = seen.get(r.round as number) ?? new Set<string>();
    for (const side of [r.team_a_reg_id, r.team_b_reg_id]) {
      if (side == null) continue;
      expect(set.has(side as string)).toBe(false);
      set.add(side as string);
    }
    seen.set(r.round as number, set);
  }
}

// ─────────────────────────────────────────────────────────────────────
// In-memory fake of the tiny supabase surface the writers touch. Records
// every delete (as its chained .eq filters) and every insert, and applies
// them to a `rows` store so we can assert that a second generate REPLACES
// rather than APPENDs — the #993 regression.
// ─────────────────────────────────────────────────────────────────────

interface StoredRow extends MatchInsert {
  __id: number;
}

function makeFakeClient() {
  let seq = 0;
  const store: StoredRow[] = [];
  const log: { deletes: Record<string, string>[]; insertCounts: number[] } = {
    deletes: [],
    insertCounts: [],
  };

  const client: MatchesWriteClient = {
    from() {
      return {
        delete() {
          const filters: Record<string, string> = {};
          const chain = {
            eq(column: string, value: string) {
              filters[column] = value;
              return chain;
            },
            then<T>(resolve: (v: { error: null }) => T) {
              // Apply the delete: drop every stored row matching all filters.
              log.deletes.push({ ...filters });
              for (let i = store.length - 1; i >= 0; i--) {
                const row = store[i] as unknown as Record<string, unknown>;
                const match = Object.entries(filters).every(
                  ([k, v]) => String(row[k]) === String(v),
                );
                if (match) store.splice(i, 1);
              }
              return resolve({ error: null });
            },
          };
          return chain as unknown as ReturnType<
            ReturnType<MatchesWriteClient["from"]>["delete"]
          >;
        },
        insert(rows: MatchInsert[]) {
          log.insertCounts.push(rows.length);
          for (const r of rows) store.push({ ...r, __id: seq++ });
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  return { client, store, log };
}

// Minimal event/team fixtures.
const rrEvent = { id: "ev1", pool_count: 1, play_each_team_times: 1 };
const team = (id: string, poolIndex: number | null = null) => ({
  captainRegId: id,
  poolIndex,
});

describe("buildRoundRobinRows", () => {
  it("produces n-choose-2 pairings for a single pool", () => {
    const teams = [team("A"), team("B"), team("C"), team("D"), team("E")];
    const rows = buildRoundRobinRows(rrEvent, teams);
    // C(5,2) = 10.
    expect(rows).toHaveLength(10);
    // Every row is a round_robin, pending match with a distinct position
    // 0..9. Rounds are now REAL (circle method), not all 1.
    expect(rows.every((r) => r.stage === "round_robin")).toBe(true);
    expect(rows.every((r) => (r.round ?? 0) >= 1)).toBe(true);
    expect(rows.map((r) => r.position)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    // Distinct unordered pairs.
    const pairs = new Set(
      rows.map((r) => [r.team_a_reg_id, r.team_b_reg_id].sort().join("-")),
    );
    expect(pairs.size).toBe(10);
  });

  it("repeats each pairing once per play_each_team_times, at DISTINCT positions", () => {
    const teams = [team("A"), team("B"), team("C")];
    const rows = buildRoundRobinRows(
      { ...rrEvent, play_each_team_times: 2 },
      teams,
    );
    // C(3,2) = 3 pairings, twice = 6.
    expect(rows).toHaveLength(6);
    // Positions are globally unique even though pairs repeat — this is what
    // lets the unique-slot index allow the legitimate repeat.
    expect(new Set(rows.map((r) => r.position)).size).toBe(6);
    const pairCounts = new Map<string, number>();
    for (const r of rows) {
      const key = [r.team_a_reg_id, r.team_b_reg_id].sort().join("-");
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
    // Each of the 3 pairs appears exactly twice.
    expect([...pairCounts.values()]).toEqual([2, 2, 2]);
  });

  it("pairs only within a pool for multi-pool events, positions still global", () => {
    const teams = [
      team("A", 1),
      team("B", 1),
      team("C", 1),
      team("D", 1),
      team("E", 2),
      team("F", 2),
      team("G", 2),
      team("H", 2),
    ];
    const rows = buildRoundRobinRows(
      { ...rrEvent, pool_count: 2 },
      teams,
    );
    // C(4,2) per pool = 6 + 6 = 12.
    expect(rows).toHaveLength(12);
    // No cross-pool pairing.
    const poolOf = new Map(teams.map((t) => [t.captainRegId, t.poolIndex]));
    for (const r of rows) {
      expect(poolOf.get(r.team_a_reg_id as string)).toBe(
        poolOf.get(r.team_b_reg_id as string),
      );
    }
    expect(new Set(rows.map((r) => r.position)).size).toBe(12);
  });
});

describe("buildRoundRobinRows — circle-method scheduling (PB.com fold)", () => {
  // Teams in SEED ORDER: id "1".."n" == seed 1..n.
  const seedTeams = (n: number) =>
    Array.from({ length: n }, (_, i) => team(String(i + 1)));

  it("7 teams: round 1 is the fold {1v7,2v6,3v5}, seed 4 byes", () => {
    const rows = buildRoundRobinRows(rrEvent, seedTeams(7));
    const byRound = rowsByRound(rows);
    const minRound = Math.min(...byRound.keys());
    expect(minRound).toBe(1);
    expect(new Set(byRound.get(1))).toEqual(new Set(["1-7", "2-6", "3-5"]));
    // Seed 4 appears in no round-1 match (it has the bye).
    const round1Teams = rows
      .filter((r) => r.round === 1)
      .flatMap((r) => [r.team_a_reg_id, r.team_b_reg_id]);
    expect(round1Teams).not.toContain("4");
  });

  it("7 teams: 21 distinct pairs, each exactly once, ≤1 match/team/round, 7 rounds", () => {
    const rows = buildRoundRobinRows(rrEvent, seedTeams(7));
    // C(7,2) = 21 pairings, each appearing exactly once.
    expect(rows).toHaveLength(21);
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = pairKey(r.team_a_reg_id, r.team_b_reg_id);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(counts.size).toBe(21);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
    // Odd n → n rounds, one bye each (so 3 matches per round).
    const byRound = rowsByRound(rows);
    expect(byRound.size).toBe(7);
    expect([...byRound.values()].every((ps) => ps.length === 3)).toBe(true);
    assertAtMostOncePerRound(rows);
    // Positions are globally distinct 0..20.
    expect(new Set(rows.map((r) => r.position)).size).toBe(21);
  });

  it("6 teams (even): round 1 fold {1v6,2v5,3v4}, 5 rounds, each team once per round", () => {
    const rows = buildRoundRobinRows(rrEvent, seedTeams(6));
    expect(rows).toHaveLength(15); // C(6,2)
    const byRound = rowsByRound(rows);
    expect(new Set(byRound.get(1))).toEqual(new Set(["1-6", "2-5", "3-4"]));
    // Even n → n-1 rounds, no byes (3 matches per round).
    expect(byRound.size).toBe(5);
    expect([...byRound.values()].every((ps) => ps.length === 3)).toBe(true);
    assertAtMostOncePerRound(rows);
  });

  it("4 teams (even): round 1 fold {1v4,2v3}, 3 rounds", () => {
    const rows = buildRoundRobinRows(rrEvent, seedTeams(4));
    const byRound = rowsByRound(rows);
    expect(new Set(byRound.get(1))).toEqual(new Set(["1-4", "2-3"]));
    expect(byRound.size).toBe(3);
    assertAtMostOncePerRound(rows);
  });

  it("multi-pool: circle method runs within each pool, no cross-pool pairings", () => {
    const teams = [
      team("1", 1), team("2", 1), team("3", 1), team("4", 1), team("5", 1),
      team("6", 2), team("7", 2), team("8", 2), team("9", 2), team("10", 2),
    ];
    const rows = buildRoundRobinRows({ ...rrEvent, pool_count: 2 }, teams);
    // C(5,2) per pool = 10 + 10.
    expect(rows).toHaveLength(20);
    const poolOf = new Map(teams.map((t) => [t.captainRegId, t.poolIndex]));
    for (const r of rows) {
      expect(poolOf.get(r.team_a_reg_id as string)).toBe(
        poolOf.get(r.team_b_reg_id as string),
      );
    }
    // Each pool is properly round-scheduled: no team twice in a round, and
    // (round, position) stays unique across pools via the global position.
    assertAtMostOncePerRound(rows);
    expect(new Set(rows.map((r) => r.position)).size).toBe(20);
    expect(new Set(rows.map((r) => `${r.round}:${r.position}`)).size).toBe(20);
  });

  it("play_each_team_times=2: every pair twice, ≤1/team/round, positions unique, rep 2 rounds follow rep 1", () => {
    const rows = buildRoundRobinRows(
      { ...rrEvent, play_each_team_times: 2 },
      seedTeams(4),
    );
    // C(4,2)=6 pairs, twice = 12.
    expect(rows).toHaveLength(12);
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = pairKey(r.team_a_reg_id, r.team_b_reg_id);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect([...counts.values()].every((c) => c === 2)).toBe(true);
    // Per-round constraint still holds across both reps (rep 2 continues the
    // round numbering: 4 teams → 3 rounds per rep → rounds 1..3 then 4..6).
    assertAtMostOncePerRound(rows);
    expect(new Set(rows.map((r) => r.round)).size).toBe(6);
    expect(Math.max(...rows.map((r) => r.round as number))).toBe(6);
    // Positions globally unique so the unique index allows the repeat.
    expect(new Set(rows.map((r) => r.position)).size).toBe(12);
  });
});

describe("circleMethodRounds", () => {
  it("7 seeds: round 1 is the fold, middle seed byes, n rounds", () => {
    const rounds = circleMethodRounds([1, 2, 3, 4, 5, 6, 7]);
    expect(rounds).toHaveLength(7);
    const r1 = rounds[0].map(([a, b]) => [a, b].sort((x, y) => x - y).join("-"));
    expect(new Set(r1)).toEqual(new Set(["1-7", "2-6", "3-5"]));
  });

  it("returns no rounds for fewer than 2 teams", () => {
    expect(circleMethodRounds([])).toEqual([]);
    expect(circleMethodRounds([1])).toEqual([]);
  });
});

describe("buildPlayoffRows", () => {
  const playoffEvent = {
    id: "ev1",
    playoff_rounds: 1,
    medal_match_format: "single_game" as MatchInsert["match_format"],
    medal_points_to_win: 11,
    medal_win_by: 2,
    medal_minutes_per_game: 20,
    semifinal_match_format: "single_game" as MatchInsert["match_format"],
    semifinal_points_to_win: 11,
    semifinal_win_by: 2,
    semifinal_minutes_per_game: 15,
  };
  const seed = (id: string) => ({ captainRegId: id });

  it("R=1 builds pairwise medal matches (1v2, 3v4) carrying medal config", () => {
    const top = [seed("s1"), seed("s2"), seed("s3"), seed("s4")];
    const rows = buildPlayoffRows(playoffEvent, top);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      round: 1,
      position: 0,
      team_a_reg_id: "s1",
      team_b_reg_id: "s2",
      match_points_to_win: 11,
      match_minutes_per_game: 20,
    });
    expect(rows[1]).toMatchObject({
      round: 1,
      position: 1,
      team_a_reg_id: "s3",
      team_b_reg_id: "s4",
    });
  });

  it("R=2 builds two semis (1v4, 2v3) + gold/bronze placeholders", () => {
    const top = [seed("s1"), seed("s2"), seed("s3"), seed("s4")];
    const rows = buildPlayoffRows({ ...playoffEvent, playoff_rounds: 2 }, top);
    expect(rows).toHaveLength(4);
    // Semis carry semifinal config (15 min), round 2 carries medal (20 min).
    expect(rows[0]).toMatchObject({
      round: 1,
      position: 0,
      team_a_reg_id: "s1",
      team_b_reg_id: "s4",
      match_minutes_per_game: 15,
    });
    expect(rows[1]).toMatchObject({
      round: 1,
      position: 1,
      team_a_reg_id: "s2",
      team_b_reg_id: "s3",
    });
    expect(rows[2]).toMatchObject({
      round: 2,
      position: 0,
      team_a_reg_id: null,
      team_b_reg_id: null,
      match_minutes_per_game: 20,
    });
    expect(rows[3]).toMatchObject({ round: 2, position: 1 });
    // Every (round, position) slot is unique.
    const slots = rows.map((r) => `${r.round}:${r.position}`);
    expect(new Set(slots).size).toBe(4);
  });
});

describe("replaceRoundRobinMatches — idempotency (#993)", () => {
  it("a second generate REPLACES, not APPENDS", async () => {
    const { client, store, log } = makeFakeClient();
    const teams = [team("A"), team("B"), team("C"), team("D"), team("E")];

    const first = await replaceRoundRobinMatches(client, rrEvent, teams);
    expect(first.error).toBeNull();
    expect(store).toHaveLength(10);

    const second = await replaceRoundRobinMatches(client, rrEvent, teams);
    expect(second.error).toBeNull();
    // Still 10 — the second run deleted the first set before inserting.
    expect(store).toHaveLength(10);
    expect(store.every((r) => r.stage === "round_robin")).toBe(true);

    // It cleared BOTH round_robin and dependent playoff each time.
    expect(log.deletes).toEqual([
      { event_id: "ev1", stage: "round_robin" },
      { event_id: "ev1", stage: "playoff" },
      { event_id: "ev1", stage: "round_robin" },
      { event_id: "ev1", stage: "playoff" },
    ]);
  });

  it("is safe when no matches exist yet (deletes are no-ops)", async () => {
    const { client, store } = makeFakeClient();
    const teams = [team("A"), team("B")];
    const res = await replaceRoundRobinMatches(client, rrEvent, teams);
    expect(res.error).toBeNull();
    expect(store).toHaveLength(1); // C(2,2) = 1
  });

  it("regenerating a round robin clears stale playoff matches too", async () => {
    const { client, store } = makeFakeClient();
    // Seed a playoff match directly.
    await client
      .from("matches")
      .insert([
        {
          event_id: "ev1",
          stage: "playoff",
          round: 1,
          position: 0,
          status: "pending",
        },
      ]);
    expect(store).toHaveLength(1);
    await replaceRoundRobinMatches(client, rrEvent, [team("A"), team("B")]);
    // The stale playoff row is gone; only the fresh RR match remains.
    expect(store).toHaveLength(1);
    expect(store[0].stage).toBe("round_robin");
  });
});

describe("replacePlayoffMatches — idempotency (#993)", () => {
  it("a second generate REPLACES, not APPENDS, and leaves round robin intact", async () => {
    const { client, store, log } = makeFakeClient();
    // Existing round-robin matches that must survive playoff generation.
    await client.from("matches").insert(
      buildRoundRobinRows(rrEvent, [team("A"), team("B"), team("C"), team("D")]),
    );
    const rrCount = store.length; // C(4,2) = 6
    expect(rrCount).toBe(6);

    const rows: MatchInsert[] = [
      {
        event_id: "ev1",
        stage: "playoff",
        round: 1,
        position: 0,
        team_a_reg_id: "A",
        team_b_reg_id: "B",
        status: "pending",
      },
      {
        event_id: "ev1",
        stage: "playoff",
        round: 1,
        position: 1,
        team_a_reg_id: "C",
        team_b_reg_id: "D",
        status: "pending",
      },
    ];

    await replacePlayoffMatches(client, "ev1", rows);
    expect(store.filter((r) => r.stage === "playoff")).toHaveLength(2);

    await replacePlayoffMatches(client, "ev1", rows);
    // Still 2 playoff matches — replaced, not doubled.
    expect(store.filter((r) => r.stage === "playoff")).toHaveLength(2);
    // Round-robin matches untouched.
    expect(store.filter((r) => r.stage === "round_robin")).toHaveLength(6);
    // Every delete targeted only the playoff stage.
    expect(log.deletes.every((d) => d.stage === "playoff")).toBe(true);
  });
});

describe("clearEventMatches", () => {
  it("removes every match in the event (double-elim reset shape)", async () => {
    const { client, store } = makeFakeClient();
    await client.from("matches").insert([
      { event_id: "ev1", stage: "playoff", round: 1, position: 0, status: "pending" },
      { event_id: "ev1", stage: "playoff", round: 1, position: 1, status: "pending" },
      { event_id: "ev2", stage: "playoff", round: 1, position: 0, status: "pending" },
    ]);
    await clearEventMatches(client, "ev1");
    // Only the other event's match survives.
    expect(store).toHaveLength(1);
    expect(store[0].event_id).toBe("ev2");
  });
});
