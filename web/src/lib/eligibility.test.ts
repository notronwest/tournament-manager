// Gender-gate test for #1170. `event_gender` has four values — men | women |
// mixed | open — and the gate previously excused only `mixed`, so an `open`
// event fell through to the women's branch and told every player who was not
// female "Not eligible: women's event". All three brackets of the Loon Race
// Team tournament are `open`, so this was a full stop on registration.
//
// The two halves that matter: open and mixed gate on gender for no one, and
// men's/women's still refuse everybody else. The rating gate is covered here
// only enough to prove the gender branch is being read in isolation.
import { describe, expect, it } from "vitest";
import type { Database } from "../types/supabase";
import { checkEligibility } from "./eligibility";

type Event = Database["public"]["Tables"]["events"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];
type EventGender = Database["public"]["Enums"]["event_gender"];
type PlayerGender = Database["public"]["Enums"]["player_gender"];

// No rating bounds, so checkEligibility's only live gate is gender.
const event = (gender: EventGender): Event =>
  ({
    gender,
    format: "doubles",
    min_rating: null,
    max_rating: null,
    min_age: null,
    max_age: null,
    rating_source: null,
  }) as unknown as Event;

const player = (gender: PlayerGender | null): Player =>
  ({
    gender,
    self_rating_doubles: 3.5,
    self_rating_mixed: 3.5,
    self_rating_singles: 3.5,
  }) as unknown as Player;

const GENDERS: (PlayerGender | null)[] = ["M", "F", "X", null];

describe("checkEligibility gender gate (#1170)", () => {
  it("an open event is open to every player gender, including X and unset", () => {
    for (const g of GENDERS) {
      const result = checkEligibility(player(g), event("open"));
      expect(result, `open event rejected gender ${String(g)}`).toEqual({
        eligible: true,
        reasons: [],
      });
    }
  });

  it("a mixed event stays open to every player gender", () => {
    for (const g of GENDERS) {
      expect(checkEligibility(player(g), event("mixed")), `mixed rejected ${String(g)}`).toEqual({
        eligible: true,
        reasons: [],
      });
    }
  });

  it("a men's event admits M and refuses F, X and unset", () => {
    expect(checkEligibility(player("M"), event("men")).eligible).toBe(true);
    for (const g of ["F", "X", null] as (PlayerGender | null)[]) {
      const result = checkEligibility(player(g), event("men"));
      expect(result.eligible, `men's event admitted ${String(g)}`).toBe(false);
      expect(result.reasons).toContain("men's event");
    }
  });

  it("a women's event admits F and refuses M, X and unset", () => {
    expect(checkEligibility(player("F"), event("women")).eligible).toBe(true);
    for (const g of ["M", "X", null] as (PlayerGender | null)[]) {
      const result = checkEligibility(player(g), event("women"));
      expect(result.eligible, `women's event admitted ${String(g)}`).toBe(false);
      expect(result.reasons).toContain("women's event");
    }
  });

  it("the reason an open event used to give was the women's one", () => {
    // Guards the exact regression: before the fix a male player on an open
    // event came back { eligible: false, reasons: ["women's event"] }.
    expect(checkEligibility(player("M"), event("open")).reasons).not.toContain("women's event");
  });
});
