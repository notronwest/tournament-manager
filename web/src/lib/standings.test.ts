import { describe, it, expect } from "vitest";
import { computeStandings } from "./standings";
import type { Team } from "../pages/admin/EventConsolePage";
import type { Database } from "../types/supabase";

type Match = Database["public"]["Tables"]["matches"]["Row"];

const team = (captainRegId: string): Team => ({
  captainRegId,
  partnerRegId: null,
  captain: {} as never,
  partner: null,
  label: captainRegId,
  registeredAt: "2026-01-01",
  poolIndex: null,
  seed: null,
});

// A completed match between two teams. The winner is whoever scored more;
// scores drive point differential / points-for, which are the fallback
// tiebreakers behind head-to-head.
let matchSeq = 0;
const match = (
  a: string,
  aScore: number,
  b: string,
  bScore: number,
): Match =>
  ({
    id: `m${matchSeq++}`,
    status: "completed",
    team_a_reg_id: a,
    team_b_reg_id: b,
    team_a_score: aScore,
    team_b_score: bScore,
    winner_reg_id: aScore > bScore ? a : b,
  }) as unknown as Match;

const order = (teams: Team[], matches: Match[]) =>
  computeStandings(teams, matches).map((s) => s.team.captainRegId);

describe("computeStandings tiebreak: head-to-head over differential", () => {
  it("2-way tie: the head-to-head winner ranks above the higher-diff loser", () => {
    // A and B both finish 2-1. A beat B head-to-head, but B ran up a much
    // bigger point differential against the weaker teams. Head-to-head must
    // win, so A ranks above B even though B's diff is far higher.
    const teams = ["A", "B", "C", "D"].map(team);
    const matches = [
      match("A", 11, "B", 9), // A beats B (the head-to-head)
      match("A", 11, "C", 9), // A beats C
      match("D", 11, "A", 9), // A's only loss
      match("B", 11, "C", 0), // B blows out C
      match("B", 11, "D", 0), // B blows out D
      match("C", 11, "D", 5), // C beats D
    ];

    const standings = computeStandings(teams, matches);
    const a = standings.find((s) => s.team.captainRegId === "A")!;
    const b = standings.find((s) => s.team.captainRegId === "B")!;
    // Sanity: they really are tied on record and B really does have the
    // better differential (so the old diff-first sort would flip them).
    expect(a.wins).toBe(2);
    expect(b.wins).toBe(2);
    expect(b.diff).toBeGreaterThan(a.diff);

    expect(order(teams, matches)).toEqual(["A", "B", "C", "D"]);
  });

  it("3-way tie: resolved by the mini round-robin among the tied teams", () => {
    // R, L, W all finish with 2 wins. Head-to-head among just the three:
    // R beat both (2-0), L split (1-1), W lost both (0-2) — so the order is
    // R, L, W. W has the BEST overall differential (two 11-0 blowouts of the
    // filler teams), which is exactly the trap: a diff-first sort would seed
    // W first, but head-to-head puts W last.
    const teams = ["R", "L", "W", "X", "Y"].map(team);
    const matches = [
      match("R", 11, "L", 9), // R beats L  (intra-group)
      match("R", 11, "W", 9), // R beats W  (intra-group)
      match("L", 11, "W", 9), // L beats W  (intra-group)
      match("L", 11, "X", 9), // L's 2nd win (filler)
      match("W", 11, "X", 0), // W's blowout win (filler)
      match("W", 11, "Y", 0), // W's blowout win (filler)
    ];

    const standings = computeStandings(teams, matches);
    const [r, l, w] = ["R", "L", "W"].map(
      (id) => standings.find((s) => s.team.captainRegId === id)!,
    );
    expect([r.wins, l.wins, w.wins]).toEqual([2, 2, 2]);
    // The trap: W has the best differential of the three.
    expect(w.diff).toBeGreaterThan(r.diff);
    expect(w.diff).toBeGreaterThan(l.diff);

    expect(order(teams, matches).slice(0, 3)).toEqual(["R", "L", "W"]);
  });

  it("circular 3-way tie: falls through to differential", () => {
    // P beat Q, Q beat S, S beat P — a rock-paper-scissors cycle. Each is
    // 1-1 head-to-head within the group, so head-to-head can't separate them
    // and the tiebreak falls through to point differential: S (+11) > Q (+8)
    // > P (+2).
    const teams = ["P", "Q", "S", "X"].map(team);
    const matches = [
      match("P", 11, "Q", 9), // P beats Q
      match("Q", 11, "S", 9), // Q beats S
      match("S", 11, "P", 9), // S beats P  (closes the cycle)
      match("P", 11, "X", 9), // P +2 filler
      match("Q", 11, "X", 3), // Q +8 filler
      match("S", 11, "X", 0), // S +11 filler
    ];

    const standings = computeStandings(teams, matches);
    const [p, q, s] = ["P", "Q", "S"].map(
      (id) => standings.find((st) => st.team.captainRegId === id)!,
    );
    expect([p.wins, q.wins, s.wins]).toEqual([2, 2, 2]);
    // Diff order is S > Q > P, and it is NOT the insertion order (P,Q,S),
    // proving head-to-head deadlocked and the sort fell through to diff.
    expect(s.diff).toBeGreaterThan(q.diff);
    expect(q.diff).toBeGreaterThan(p.diff);

    expect(order(teams, matches).slice(0, 3)).toEqual(["S", "Q", "P"]);
  });
});
