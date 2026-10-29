// The family-row summary line for #1183. A guardian reads this line to know
// whether their child can enter a bracket at all, so the two things it must
// never do are stay silent about a missing rating and nag about a gender
// almost no bracket reads.
import { describe, expect, it } from "vitest";
import type { Database } from "../types/supabase";
import { ratingValuesOf, selfRatingSummary } from "./selfRatings";

type Player = Database["public"]["Tables"]["players"]["Row"];
type PlayerGender = Database["public"]["Enums"]["player_gender"];

const child = (over: Partial<Player> = {}): Player =>
  ({
    gender: null,
    self_rating_doubles: null,
    self_rating_mixed: null,
    self_rating_singles: null,
    ...over,
  }) as unknown as Player;

describe("selfRatingSummary", () => {
  it("names a missing rating, because most brackets refuse without one", () => {
    expect(selfRatingSummary(child())).toBe("No rating yet");
  });

  it("says nothing about a missing gender", () => {
    // Gender is optional by design — only a men's or women's bracket reads
    // it. A parent whose child plays mixed should never be told to answer.
    expect(selfRatingSummary(child())).not.toMatch(/gender/i);
    expect(selfRatingSummary(child({ self_rating_doubles: 3.5 }))).toBe("Doubles 3.5");
  });

  it("lists every rating on file, in a fixed order", () => {
    const p = child({
      self_rating_singles: 4,
      self_rating_doubles: 3.5,
      self_rating_mixed: 3,
    });
    expect(selfRatingSummary(p)).toBe("Doubles 3.5 · Mixed doubles 3.0 · Singles 4.0");
  });

  it("reads a stored gender back in the words the picker offered", () => {
    const g = (gender: PlayerGender) => selfRatingSummary(child({ gender }));
    expect(g("M")).toBe("No rating yet · Male");
    expect(g("F")).toBe("No rating yet · Female");
    expect(g("X")).toBe("No rating yet · Other");
  });

  it("prints a numeric(4,2) rating the way a chip does", () => {
    // The column hands back 3.5, not 3.50; a rating of exactly 3 still reads
    // with its decimal so the chips line up.
    expect(selfRatingSummary(child({ self_rating_doubles: 3.5 }))).toBe("Doubles 3.5");
    expect(selfRatingSummary(child({ self_rating_doubles: 3 }))).toBe("Doubles 3.0");
  });
});

describe("ratingValuesOf", () => {
  it("reads the three columns into the shape the pickers take", () => {
    const p = child({
      self_rating_doubles: 3.5,
      self_rating_mixed: null,
      self_rating_singles: 4.5,
    });
    expect(ratingValuesOf(p)).toEqual({ doubles: 3.5, mixed: null, singles: 4.5 });
  });
});
