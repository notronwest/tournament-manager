import { describe, it, expect } from "vitest";
import { assignSuggestions } from "./courtSuggestions";

const m = (id: string, a: string, b: string) => ({ id, team_a_reg_id: a, team_b_reg_id: b });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("assignSuggestions", () => {
  it("fills all three courts where greedy would leave the third empty", () => {
    // Greedy takes AB then CE, and neither CD nor EF fits after that.
    const ranked = [m("AB", "A", "B"), m("CE", "C", "E"), m("CD", "C", "D"), m("EF", "E", "F")];
    expect(ids(assignSuggestions(ranked, 3))).toEqual(["AB", "CD", "EF"]);
  });

  it("matches greedy exactly when greedy already fills every court", () => {
    const ranked = [m("AB", "A", "B"), m("CD", "C", "D"), m("AC", "A", "C"), m("EF", "E", "F")];
    expect(ids(assignSuggestions(ranked, 3))).toEqual(["AB", "CD", "EF"]);
    expect(ids(assignSuggestions(ranked, 2))).toEqual(["AB", "CD"]);
  });

  it("will give court 1 a lower-ranked game when that is the only way to fill the courts", () => {
    // Only AC + BD can fill two courts; AB (the fairest game) blocks both.
    const ranked = [m("AB", "A", "B"), m("AC", "A", "C"), m("BD", "B", "D")];
    expect(ids(assignSuggestions(ranked, 2))).toEqual(["AC", "BD"]);
  });

  it("returns the best partial fill when the courts can't all be filled", () => {
    const ranked = [m("AB", "A", "B"), m("AC", "A", "C"), m("BC", "B", "C")];
    expect(ids(assignSuggestions(ranked, 3))).toEqual(["AB"]);
  });

  it("never suggests one team on two courts and skips half-populated matches", () => {
    const ranked = [
      { id: "tbd", team_a_reg_id: "A", team_b_reg_id: null },
      m("AB", "A", "B"),
      m("AC", "A", "C"),
      m("DE", "D", "E"),
    ];
    const out = assignSuggestions(ranked, 4);
    expect(ids(out)).toEqual(["AB", "DE"]);
  });

  it("handles no courts or no candidates", () => {
    expect(assignSuggestions([m("AB", "A", "B")], 0)).toEqual([]);
    expect(assignSuggestions([], 3)).toEqual([]);
  });

  it("stays fast on a big queue", () => {
    // 20 teams, every pairing (190 candidates), 8 courts — a bigger field
    // than any real event; must finish instantly and fill all 8.
    const teams = Array.from({ length: 20 }, (_, i) => `T${i}`);
    const ranked: ReturnType<typeof m>[] = [];
    for (let i = 0; i < teams.length; i++)
      for (let j = i + 1; j < teams.length; j++) ranked.push(m(`${i}-${j}`, teams[i], teams[j]));
    const t0 = performance.now();
    const out = assignSuggestions(ranked, 8);
    expect(out).toHaveLength(8);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
