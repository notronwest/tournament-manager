import { describe, it, expect } from "vitest";
import {
  eventPlacementFacts,
  toFixedPlacement,
  toPackItem,
  type PlaceableEvent,
} from "./eventPlacement";
import { packSchedule } from "./schedulePacker";

const H = 60 * 60_000;
const none = new Set<string>();

// A round-robin events row with sensible defaults; each test bends a field.
function ev(overrides: Partial<PlaceableEvent> = {}): PlaceableEvent {
  return {
    id: "e",
    max_teams: 8,
    bracket_type: "round_robin",
    pool_count: 1,
    play_each_team_times: 1,
    pool_minutes_per_game: 15,
    teams_advancing_to_playoff: 0,
    playoff_rounds: 1,
    medal_match_format: "single_game",
    medal_minutes_per_game: 20,
    semifinal_match_format: "single_game",
    semifinal_minutes_per_game: 15,
    ...overrides,
  };
}

describe("eventPlacementFacts", () => {
  it("caps court needs at the venue and uses assigned courts for the estimate", () => {
    const f = eventPlacementFacts({
      event: ev({ pool_count: 1 }),
      teamCount: 8, // one pool of 8 → floor(8/2) = 4 courts busy
      courtNumbers: [1, 2, 3, 4],
      venueCourts: 6,
      players: none,
    });
    expect(f.courtsNeeded).toBe(4);
    expect(f.courts).toBe(4);
    expect(f.poolMinutes).toBeGreaterThan(0);
    expect(f.totalMinutes).toBe(f.poolMinutes + f.medalMinutes);
  });

  it("caps court needs at a smaller venue", () => {
    const f = eventPlacementFacts({
      event: ev(),
      teamCount: 12,
      courtNumbers: [],
      venueCourts: 3,
      players: none,
    });
    expect(f.courtsNeeded).toBe(3);
  });

  it("plans on max_teams before anyone registers", () => {
    const f = eventPlacementFacts({
      event: ev({ max_teams: 10 }),
      teamCount: 0,
      courtNumbers: [],
      venueCourts: 8,
      players: none,
    });
    expect(f.planTeams).toBe(10);
  });
});

// The recommendation contract the wizard steps rely on: THIS event movable,
// same-day siblings fixed, run through the ONE engine (packSchedule).
function recommend(
  self: ReturnType<typeof eventPlacementFacts>,
  siblings: { facts: ReturnType<typeof eventPlacementFacts>; startMs: number }[],
  venueCourts: number,
  anchorMs = 0,
  bufferMs = 0,
) {
  const fixed = siblings.map((s) => toFixedPlacement(s.facts, s.startMs));
  const fixedPlayers = new Map(siblings.map((s) => [s.facts.id, s.facts.players]));
  return packSchedule(
    [toPackItem(self, 0)],
    anchorMs,
    bufferMs,
    venueCourts,
    fixed,
    fixedPlayers,
  )[0];
}

describe("court recommendation avoids a court a sibling holds", () => {
  it("routes this event onto the courts the sibling isn't using", () => {
    // Sibling holds courts 1–4 all morning; this event needs 4 of 8.
    const sibling = eventPlacementFacts({
      event: ev({ id: "sib" }),
      teamCount: 8,
      courtNumbers: [1, 2, 3, 4],
      venueCourts: 8,
      players: none,
    });
    const self = eventPlacementFacts({
      event: ev({ id: "me" }),
      teamCount: 8,
      courtNumbers: [],
      venueCourts: 8,
      players: none,
    });
    const rec = recommend(self, [{ facts: sibling, startMs: 0 }], 8);
    // Starts alongside (0), on the free upper courts 5–8.
    expect(rec.startMs).toBe(0);
    expect(rec.courts).toEqual([5, 6, 7, 8]);
    for (const c of rec.courts) expect([1, 2, 3, 4]).not.toContain(c);
  });
});

describe("start recommendation when the earlier slot is full", () => {
  it("pushes this event later when every court is taken", () => {
    // Two siblings fill all 8 courts for the first ~2 hours.
    const sibA = eventPlacementFacts({
      event: ev({ id: "a" }),
      teamCount: 8,
      courtNumbers: [1, 2, 3, 4],
      venueCourts: 8,
      players: none,
    });
    const sibB = eventPlacementFacts({
      event: ev({ id: "b" }),
      teamCount: 8,
      courtNumbers: [5, 6, 7, 8],
      venueCourts: 8,
      players: none,
    });
    const self = eventPlacementFacts({
      event: ev({ id: "me" }),
      teamCount: 8,
      courtNumbers: [],
      venueCourts: 8,
      players: none,
    });
    const rec = recommend(
      self,
      [
        { facts: sibA, startMs: 0 },
        { facts: sibB, startMs: 0 },
      ],
      8,
    );
    // Can't start at 0 (no courts free); waits for the siblings to end.
    expect(rec.startMs).toBeGreaterThan(0);
    expect(rec.heldBy).not.toBeNull();
    expect(rec.heldBy?.courtsShort).toBeGreaterThan(0);
  });
});

describe("player clash pushes the start", () => {
  it("won't overlap an event that shares a player, even with free courts", () => {
    const sibling = eventPlacementFacts({
      event: ev({ id: "sib" }),
      teamCount: 4,
      courtNumbers: [1, 2],
      venueCourts: 8,
      players: new Set(["sue"]),
    });
    const self = eventPlacementFacts({
      event: ev({ id: "me" }),
      teamCount: 4,
      courtNumbers: [],
      venueCourts: 8,
      players: new Set(["sue", "tom"]),
    });
    const rec = recommend(self, [{ facts: sibling, startMs: 0 }], 8);
    // Plenty of courts, but Sue is in both → this event waits for the sibling.
    expect(rec.startMs).toBeGreaterThanOrEqual(sibling.totalMinutes * 60_000);
    expect(rec.heldBy?.playerClashes.map((c) => c.id)).toContain("sib");
  });

  it("with no shared player it may run alongside on free courts", () => {
    const sibling = eventPlacementFacts({
      event: ev({ id: "sib" }),
      teamCount: 4,
      courtNumbers: [1, 2],
      venueCourts: 8,
      players: new Set(["sue"]),
    });
    const self = eventPlacementFacts({
      event: ev({ id: "me" }),
      teamCount: 4,
      courtNumbers: [],
      venueCourts: 8,
      players: new Set(["tom"]),
    });
    const rec = recommend(self, [{ facts: sibling, startMs: 0 }], 8);
    expect(rec.startMs).toBe(0);
    expect(rec.heldBy).toBeNull();
  });
});

describe("toFixedPlacement", () => {
  it("holds the lowest assigned courts for pool play and spans the total", () => {
    const f = eventPlacementFacts({
      event: ev({ teams_advancing_to_playoff: 0 }),
      teamCount: 8,
      courtNumbers: [3, 4, 5, 6],
      venueCourts: 8,
      players: none,
    });
    const p = toFixedPlacement(f, 2 * H);
    expect(p.startMs).toBe(2 * H);
    expect(p.endMs).toBe(2 * H + f.totalMinutes * 60_000);
    expect(p.courts).toEqual([3, 4, 5, 6]);
    expect(p.segments[0].kind).toBe("pool");
  });
});
