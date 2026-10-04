import { describe, expect, it } from "vitest";
import { lastNameSet, relaxedNameMatch, relaxedSetMatch } from "../src/pbcom/matchMap.js";

describe("relaxedNameMatch", () => {
  it("exact, prefix, suffix, and no-match", () => {
    expect(relaxedNameMatch("smith", "smith")).toBe("exact");
    expect(relaxedNameMatch("s", "smith")).toBe("loose"); // PB truncates Smith → S
    expect(relaxedNameMatch("w", "wysolmerski")).toBe("loose");
    expect(relaxedNameMatch("risi", "derisi")).toBe("loose"); // DeRisi → Risi (suffix)
    expect(relaxedNameMatch("photography", "talpinphotography")).toBe("loose");
    expect(relaxedNameMatch("smith", "jones")).toBe(false);
    expect(relaxedNameMatch("", "smith")).toBe(false);
  });
});

describe("relaxedSetMatch (the real PB.com truncation cases)", () => {
  const ln = (names: string[]) => lastNameSet(names);

  it("matches a doubles team when the partner is exact and the other is truncated", () => {
    expect(relaxedSetMatch(ln(["Kessler", "W"]), ln(["Kessler", "Wysolmerski"]))).toBe(true);
    expect(relaxedSetMatch(ln(["S", "Yu"]), ln(["Smith", "Yu"]))).toBe(true);
    expect(relaxedSetMatch(ln(["Risi", "Schwarzmann"]), ln(["DeRisi", "Schwarzmann"]))).toBe(true);
    expect(relaxedSetMatch(ln(["OConnor", "Photography"]), ln(["OConnor", "TalpinPhotography"]))).toBe(true);
  });

  it("requires at least one EXACT name — two loose names alone do not match", () => {
    // "s" + "x" would loosely hit Smith + Xavier, but neither is exact → reject.
    expect(relaxedSetMatch(ln(["S", "X"]), ln(["Smith", "Xavier"]))).toBe(false);
  });

  it("rejects different-size sets and genuinely different teams", () => {
    expect(relaxedSetMatch(ln(["Smith"]), ln(["Smith", "Yu"]))).toBe(false);
    expect(relaxedSetMatch(ln(["Smith", "Yu"]), ln(["Jones", "Doe"]))).toBe(false);
  });

  it("singles require an exact name (a lone truncated initial never resolves)", () => {
    expect(relaxedSetMatch(ln(["Hatley"]), ln(["Hatley"]))).toBe(true);
    expect(relaxedSetMatch(ln(["H"]), ln(["Hatley"]))).toBe(false);
  });

  it("uniqueness is the caller's job: two candidates both matching is a caller fail-closed", () => {
    // Both Smith/Yu and Steward/Yu would loose-match "S/Yu"; the caller must see 2 hits
    // and refuse. Here we just confirm BOTH individually match (so filter() returns 2).
    expect(relaxedSetMatch(ln(["S", "Yu"]), ln(["Smith", "Yu"]))).toBe(true);
    expect(relaxedSetMatch(ln(["S", "Yu"]), ln(["Steward", "Yu"]))).toBe(true);
  });
});
