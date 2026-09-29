import { describe, it, expect } from "vitest";
import {
  seedTeams,
  effectivePlayerRating,
  teamStrength,
  divisionFromEvent,
  divisionRatingFloor,
  DEFAULT_RATING_FLOOR,
  type SeedableTeam,
  type SeedDivision,
  type PlayerRatings,
} from "./seedTeams";

// All fixtures are SYNTHETIC — no real member names, emails, or DUPR ids.
const DOUBLES: SeedDivision = { format: "doubles", mixed: false, ratingFloor: 3.5 };
const MIXED: SeedDivision = { format: "doubles", mixed: true, ratingFloor: 3.5 };
const SINGLES: SeedDivision = { format: "singles", mixed: false, ratingFloor: 3.5 };

const player = (r: Partial<PlayerRatings>): PlayerRatings => r;

// Build a doubles team from a captain reg id + two players.
const pair = (
  id: string,
  cap: Partial<PlayerRatings>,
  part: Partial<PlayerRatings>,
): SeedableTeam => ({
  captainRegId: id,
  partnerRegId: `${id}-p`,
  captain: player(cap),
  partner: player(part),
});

const solo = (id: string, cap: Partial<PlayerRatings>): SeedableTeam => ({
  captainRegId: id,
  partnerRegId: null,
  captain: player(cap),
  partner: null,
});

describe("effectivePlayerRating — fallback chain", () => {
  it("doubles: prefers dupr_rating_doubles", () => {
    expect(
      effectivePlayerRating(
        { dupr_rating_doubles: 4.2, dupr_rating_singles: 4.9, self_rating_doubles: 3.0 },
        DOUBLES,
      ),
    ).toBe(4.2);
  });

  it("doubles: falls back to dupr_rating_singles when doubles DUPR missing", () => {
    expect(
      effectivePlayerRating(
        { dupr_rating_doubles: null, dupr_rating_singles: 4.1, self_rating_doubles: 3.0 },
        DOUBLES,
      ),
    ).toBe(4.1);
  });

  it("doubles: falls back to self_rating_doubles when no DUPR", () => {
    expect(
      effectivePlayerRating({ self_rating_doubles: 3.75 }, DOUBLES),
    ).toBe(3.75);
  });

  it("mixed division: self fallback uses self_rating_mixed, not self_rating_doubles", () => {
    expect(
      effectivePlayerRating(
        { self_rating_mixed: 4.0, self_rating_doubles: 3.0 },
        MIXED,
      ),
    ).toBe(4.0);
  });

  it("doubles: falls back to the division floor when nothing usable", () => {
    expect(effectivePlayerRating({}, DOUBLES)).toBe(3.5);
    // A stray 0 is not usable — PB.com reports 0 for "no rating".
    expect(
      effectivePlayerRating({ dupr_rating_doubles: 0, dupr_rating_singles: 0 }, DOUBLES),
    ).toBe(3.5);
  });

  it("singles: singles-first chain (singles DUPR → doubles DUPR → self singles → floor)", () => {
    expect(
      effectivePlayerRating({ dupr_rating_singles: 4.3, dupr_rating_doubles: 4.9 }, SINGLES),
    ).toBe(4.3);
    expect(
      effectivePlayerRating({ dupr_rating_doubles: 4.9 }, SINGLES),
    ).toBe(4.9);
    expect(effectivePlayerRating({ self_rating_singles: 3.9 }, SINGLES)).toBe(3.9);
    expect(effectivePlayerRating({}, SINGLES)).toBe(3.5);
  });
});

describe("teamStrength", () => {
  it("doubles sums both partners' effective rating", () => {
    expect(
      teamStrength(pair("t", { dupr_rating_doubles: 4.0 }, { dupr_rating_doubles: 3.8 }), DOUBLES),
    ).toBeCloseTo(7.8);
  });

  it("doubles with a partner missing doubles-DUPR uses that partner's fallback", () => {
    // captain 4.0 doubles DUPR; partner has only a singles DUPR of 4.5.
    expect(
      teamStrength(
        pair("t", { dupr_rating_doubles: 4.0 }, { dupr_rating_singles: 4.5 }),
        DOUBLES,
      ),
    ).toBeCloseTo(8.5);
  });

  it("unpaired doubles reg is captain + floor", () => {
    expect(teamStrength(solo("t", { dupr_rating_doubles: 4.0 }), DOUBLES)).toBeCloseTo(7.5);
  });

  it("singles strength is the single player's effective rating", () => {
    expect(teamStrength(solo("t", { dupr_rating_singles: 4.2 }), SINGLES)).toBe(4.2);
  });
});

describe("seedTeams — ordering", () => {
  it("doubles with full DUPR: strongest combined pair is seed 1", () => {
    const teams = [
      pair("weak", { dupr_rating_doubles: 3.5 }, { dupr_rating_doubles: 3.5 }), // 7.0
      pair("strong", { dupr_rating_doubles: 4.5 }, { dupr_rating_doubles: 4.4 }), // 8.9
      pair("mid", { dupr_rating_doubles: 4.0 }, { dupr_rating_doubles: 4.0 }), // 8.0
    ];
    const seeded = seedTeams(teams, DOUBLES);
    expect(seeded.map((s) => s.captainRegId)).toEqual(["strong", "mid", "weak"]);
    expect(seeded.map((s) => s.seed)).toEqual([1, 2, 3]);
  });

  it("assigns the same seed record to a pair and carries both reg ids", () => {
    const seeded = seedTeams(
      [pair("a", { dupr_rating_doubles: 4.0 }, { dupr_rating_doubles: 4.0 })],
      DOUBLES,
    );
    expect(seeded[0]).toMatchObject({ captainRegId: "a", partnerRegId: "a-p", seed: 1 });
  });

  it("doubles with a partner missing doubles-DUPR still ranks via fallback", () => {
    const teams = [
      // 4.0 + fallback-to-singles 4.6 = 8.6  → should beat the 8.0 pair
      pair("fallback", { dupr_rating_doubles: 4.0 }, { dupr_rating_singles: 4.6 }),
      pair("plain", { dupr_rating_doubles: 4.0 }, { dupr_rating_doubles: 4.0 }), // 8.0
    ];
    const seeded = seedTeams(teams, DOUBLES);
    expect(seeded.map((s) => s.captainRegId)).toEqual(["fallback", "plain"]);
  });

  it("singles orders by effective rating", () => {
    const teams = [
      solo("c", { dupr_rating_singles: 3.6 }),
      solo("a", { dupr_rating_singles: 4.4 }),
      solo("b", { dupr_rating_singles: 4.0 }),
    ];
    expect(seedTeams(teams, SINGLES).map((s) => s.captainRegId)).toEqual(["a", "b", "c"]);
  });

  it("breaks ties deterministically by captainRegId (stable re-runs)", () => {
    const teams = [
      pair("zeta", { dupr_rating_doubles: 4.0 }, { dupr_rating_doubles: 4.0 }),
      pair("alpha", { dupr_rating_doubles: 4.0 }, { dupr_rating_doubles: 4.0 }),
      pair("mike", { dupr_rating_doubles: 4.0 }, { dupr_rating_doubles: 4.0 }),
    ];
    const first = seedTeams(teams, DOUBLES).map((s) => s.captainRegId);
    const again = seedTeams(teams.slice().reverse(), DOUBLES).map((s) => s.captainRegId);
    expect(first).toEqual(["alpha", "mike", "zeta"]);
    expect(again).toEqual(first); // order-independent → idempotent
  });

  it("a totally unrated team falls to the floor and sorts last (the 'bye' shape)", () => {
    const teams = [
      pair("rated", { dupr_rating_doubles: 4.2 }, { dupr_rating_doubles: 4.0 }), // 8.2
      pair("unrated", {}, {}), // floor + floor = 7.0
    ];
    const seeded = seedTeams(teams, DOUBLES);
    expect(seeded.map((s) => s.captainRegId)).toEqual(["rated", "unrated"]);
    expect(seeded[1].strength).toBeCloseTo(DOUBLES.ratingFloor * 2);
  });

  it("N teams get contiguous seeds 1..N", () => {
    const teams = Array.from({ length: 6 }, (_, i) =>
      pair(`t${i}`, { dupr_rating_doubles: 3 + i * 0.2 }, { dupr_rating_doubles: 3 + i * 0.2 }),
    );
    const seeded = seedTeams(teams, DOUBLES);
    expect(seeded.map((s) => s.seed)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("divisionRatingFloor / divisionFromEvent", () => {
  it("prefers the authoritative events.min_rating", () => {
    expect(
      divisionRatingFloor({ format: "doubles", gender: "men", min_rating: 3.5 }),
    ).toBe(3.5);
  });

  it("parses the range low from the source division label when min_rating is null", () => {
    expect(
      divisionRatingFloor({
        format: "doubles",
        gender: "men",
        min_rating: null,
        source_division_label: "Mens Doubles Skill: (3.5 To 3.99)",
      }),
    ).toBe(3.5);
  });

  it("parses a 'N.N And Above' floor", () => {
    expect(
      divisionRatingFloor({
        format: "doubles",
        gender: "men",
        source_division_label: "Mens Doubles 4.0 And Above",
      }),
    ).toBe(4.0);
  });

  it("uses the default floor for 'Any' / unparseable ranges", () => {
    expect(
      divisionRatingFloor({
        format: "doubles",
        gender: "open",
        source_division_label: "Open Doubles (Any)",
      }),
    ).toBe(DEFAULT_RATING_FLOOR);
    expect(divisionRatingFloor({ format: "doubles", gender: "open" })).toBe(
      DEFAULT_RATING_FLOOR,
    );
  });

  it("marks mixed divisions so the self-rating fallback uses self_rating_mixed", () => {
    expect(divisionFromEvent({ format: "doubles", gender: "mixed", min_rating: 3.5 })).toEqual({
      format: "doubles",
      mixed: true,
      ratingFloor: 3.5,
    });
    expect(divisionFromEvent({ format: "doubles", gender: "men", min_rating: 3.5 }).mixed).toBe(
      false,
    );
  });
});
