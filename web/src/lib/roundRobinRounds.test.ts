import { describe, it, expect } from "vitest";
import { packRoundRobinRounds } from "./roundRobinRounds";

const m = (position: number, a: string, b: string) => ({ position, team_a_reg_id: a, team_b_reg_id: b });

describe("packRoundRobinRounds", () => {
  it("packs a 4-team round robin into 3 rounds with every team once per round", () => {
    // Stored order is the nested i<j loop: AB AC AD BC BD CD.
    const rounds = packRoundRobinRounds([
      m(0, "A", "B"), m(1, "A", "C"), m(2, "A", "D"), m(3, "B", "C"), m(4, "B", "D"), m(5, "C", "D"),
    ]);
    expect(rounds.map((r) => r.map((x) => `${x.team_a_reg_id}${x.team_b_reg_id}`))).toEqual([
      ["AB", "CD"],
      ["AC", "BD"],
      ["AD", "BC"],
    ]);
  });

  it("gives an odd pool a bye each round", () => {
    const rounds = packRoundRobinRounds([m(0, "A", "B"), m(1, "A", "C"), m(2, "B", "C")]);
    expect(rounds.map((r) => r.length)).toEqual([1, 1, 1]);
  });

  it("orders by position regardless of input order and tolerates empty slots", () => {
    const rounds = packRoundRobinRounds([m(1, "A", "C"), m(0, "A", "B"), { position: 2, team_a_reg_id: null, team_b_reg_id: "B" }]);
    expect(rounds[0].map((x) => x.position)).toEqual([0]);
    expect(rounds[1].map((x) => x.position)).toEqual([1, 2]);
  });

  it("returns no rounds for no matches", () => {
    expect(packRoundRobinRounds([])).toEqual([]);
  });
});
