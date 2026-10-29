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
import { ageAt, checkEligibility, listPhrase, profileGaps } from "./eligibility";

type Event = Database["public"]["Tables"]["events"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];
type EventGender = Database["public"]["Enums"]["event_gender"];
type PlayerGender = Database["public"]["Enums"]["player_gender"];

// No rating or age bounds, so checkEligibility's only live gate is gender.
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

// An open event gated on age alone.
const ageEvent = (minAge: number | null, maxAge: number | null): Event =>
  ({ ...event("open"), min_age: minAge, max_age: maxAge }) as unknown as Event;

const player = (gender: PlayerGender | null): Player =>
  ({
    gender,
    self_rating_doubles: 3.5,
    self_rating_mixed: 3.5,
    self_rating_singles: 3.5,
  }) as unknown as Player;

const playerBorn = (dob: string | null): Player =>
  ({ ...player("X"), dob }) as unknown as Player;

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

// The Loon Race Team tournament, which is what prompted #1169.
const EVENT_DAY = "2026-12-29T14:00:00Z";

describe("checkEligibility age gate (#1169)", () => {
  it("measures age at the tournament's start, not at registration time", () => {
    // Turns 19 on 2026-12-01, so they are 18 for most of the time the bracket
    // is open and 19 on the day. The event-day measurement is the one that
    // matters, and it refuses them.
    const turnsNineteenBeforeTheEvent = playerBorn("2007-12-01");
    expect(ageAt("2007-12-01", EVENT_DAY)).toBe(19);
    const result = checkEligibility(turnsNineteenBeforeTheEvent, ageEvent(null, 18), EVENT_DAY);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("needs age 18 or under");
  });

  it("admits a child inside the bracket's range", () => {
    expect(ageAt("2015-06-01", EVENT_DAY)).toBe(11);
    expect(checkEligibility(playerBorn("2015-06-01"), ageEvent(null, 18), EVENT_DAY)).toEqual({
      eligible: true,
      reasons: [],
    });
    expect(checkEligibility(playerBorn("2015-06-01"), ageEvent(10, 14), EVENT_DAY)).toEqual({
      eligible: true,
      reasons: [],
    });
  });

  it("refuses an adult for a junior bracket and a too-young player for a seniors one", () => {
    const adult = playerBorn("1975-04-01"); // 51 on the day
    expect(checkEligibility(adult, ageEvent(null, 18), EVENT_DAY).reasons).toContain(
      "needs age 18 or under",
    );
    expect(checkEligibility(adult, ageEvent(50, null), EVENT_DAY).eligible).toBe(true);
    expect(checkEligibility(playerBorn("1980-01-01"), ageEvent(50, null), EVENT_DAY).reasons).toContain(
      "needs age 50+",
    );
    // 8 on the day — under the floor of a 10-14 bracket.
    expect(ageAt("2018-06-01", EVENT_DAY)).toBe(8);
    expect(checkEligibility(playerBorn("2018-06-01"), ageEvent(10, 14), EVENT_DAY).reasons).toContain(
      "needs age 10–14",
    );
  });

  it("a missing date of birth blocks an age-restricted event and nothing else", () => {
    // The guard that keeps this from locking out existing players: every
    // player row in production has dob = NULL today, and they all stay
    // eligible for every event that sets no age bound.
    expect(checkEligibility(playerBorn(null), ageEvent(null, null), EVENT_DAY)).toEqual({
      eligible: true,
      reasons: [],
    });
    const result = checkEligibility(playerBorn(null), ageEvent(null, 18), EVENT_DAY);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("needs a date of birth on file");
  });

  it("reads the same UTC calendar date the trigger compares against", () => {
    // A birthday that falls ON the event day: the player turns 12 that day and
    // is 12, not 11. Parsing either value through local time would slide this
    // by a day in a western timezone — which is how the browser's message and
    // the database's rejection would come to disagree.
    expect(ageAt("2014-12-29", EVENT_DAY)).toBe(12);
    expect(ageAt("2014-12-30", EVENT_DAY)).toBe(11);
    // A start_at rendered with an explicit offset rather than Z resolves to
    // the same UTC day.
    expect(ageAt("2014-12-29", "2026-12-29T14:00:00+00:00")).toBe(12);
  });

  it("falls back to today when no tournament date is given", () => {
    const thisYear = new Date().getUTCFullYear();
    expect(ageAt(`${thisYear - 30}-01-01`)).toBeGreaterThanOrEqual(29);
    expect(ageAt(null)).toBeNull();
  });
});

// #1183 — the advice a refusal gives a guardian. The rule the design gate
// cares about: never name a field whose filling the same gate would refuse
// anyway (checklist 17).
describe("profileGaps", () => {
  const skillEvent = (min: number | null, max: number | null): Event =>
    ({ ...event("open"), min_rating: min, max_rating: max }) as unknown as Event;
  const bare = (over: Partial<Player> = {}): Player =>
    ({
      gender: null,
      dob: "2015-06-01",
      self_rating_doubles: null,
      self_rating_mixed: null,
      self_rating_singles: null,
      ...over,
    }) as unknown as Player;

  it("names a missing rating, and says filling it is enough", () => {
    const g = profileGaps(bare(), skillEvent(3, 4));
    expect(g.fields).toEqual(["a rating"]);
    expect(g.coversEverything).toBe(true);
  });

  it("stays silent about a rating that is merely out of range", () => {
    // The fix is a different bracket. Telling this player to edit the number
    // until it fits is advice the same gate refuses on the next bracket.
    const g = profileGaps(bare({ self_rating_doubles: 4.5 }), skillEvent(3, 3.5));
    expect(g.fields).toEqual([]);
    expect(g.coversEverything).toBe(false);
  });

  it("names a missing gender for a single-gender bracket only", () => {
    expect(profileGaps(bare(), event("women")).fields).toEqual(["a gender"]);
    expect(profileGaps(bare(), event("mixed")).fields).toEqual([]);
    expect(profileGaps(bare(), event("open")).fields).toEqual([]);
  });

  it("stays silent about a gender set to the other one", () => {
    const g = profileGaps(bare({ gender: "F" }), event("men"));
    expect(g.fields).toEqual([]);
    expect(g.coversEverything).toBe(false);
  });

  it("names a missing date of birth only where an age bound reads it", () => {
    expect(profileGaps(bare({ dob: null }), ageEvent(null, 18)).fields).toEqual([
      "a date of birth",
    ]);
    expect(profileGaps(bare({ dob: null }), event("open")).fields).toEqual([]);
  });

  it("refuses to promise a fix when something unfixable is also wrong", () => {
    // An adult on a 40+ bracket with no rating: filling the rating in would
    // leave them refused on age, so the advice must not say so.
    const adult = bare({ dob: "1995-06-01" });
    const g = profileGaps(adult, { ...ageEvent(40, null), min_rating: 3, max_rating: 4 } as Event);
    expect(g.fields).toEqual(["a rating"]);
    expect(g.coversEverything).toBe(false);
  });

  it("gathers every blank at once", () => {
    const g = profileGaps(bare({ dob: null }), {
      ...event("women"),
      min_rating: 3,
      max_rating: 4,
      min_age: null,
      max_age: 18,
    } as Event);
    expect(g.fields).toEqual(["a rating", "a gender", "a date of birth"]);
    expect(g.coversEverything).toBe(true);
    expect(listPhrase(g.fields)).toBe("a rating, a gender and a date of birth");
  });
});

describe("listPhrase", () => {
  it("reads one, two and three items as a sentence", () => {
    expect(listPhrase([])).toBe("");
    expect(listPhrase(["a rating"])).toBe("a rating");
    expect(listPhrase(["a rating", "a gender"])).toBe("a rating and a gender");
  });
});
