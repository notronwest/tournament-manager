import { describe, it, expect } from "vitest";
import {
  dayFloors,
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

describe("dayFloors", () => {
  const D = 24 * H; // one day
  it("unpinned events all floor to the anchor", () => {
    const f = dayFloors(
      [
        { id: "a", pinnedStartMs: null },
        { id: "b", pinnedStartMs: null },
      ],
      0,
    );
    expect(f.get("a")).toBe(0);
    expect(f.get("b")).toBe(0);
  });
  it("a pin on a later day floors it and everything after it in run order to that day", () => {
    const f = dayFloors(
      [
        { id: "friSingles", pinnedStartMs: 15 * H }, // Fri 3pm (day 1)
        { id: "satFirst", pinnedStartMs: D + 9 * H }, // Sat 9am (day 2)
        { id: "satSecond", pinnedStartMs: null },
      ],
      8 * H, // tournament starts Fri 8am
    );
    expect(f.get("friSingles")).toBe(15 * H); // its own pin
    expect(f.get("satFirst")).toBe(D + 9 * H); // Sat
    expect(f.get("satSecond")).toBe(D + 9 * H); // follows onto Sat, not pulled back to Fri
  });
  it("the floor only moves forward — an earlier wall-clock pin after a later one doesn't lower it", () => {
    const f = dayFloors(
      [
        { id: "late", pinnedStartMs: D }, // day 2
        { id: "earlyPin", pinnedStartMs: 10 * H }, // day 1 (out of order input)
      ],
      0,
    );
    expect(f.get("late")).toBe(D);
    // its own pin raises its floor to itself, but the running floor stays at D
    expect(f.get("earlyPin")).toBe(D);
  });
  it("end to end: floors feed the packer so pins keep two days instead of collapsing to one (the bug)", () => {
    const anchor = 8 * H;
    const rows = [
      { id: "fri", pinnedStartMs: 15 * H },
      { id: "sat", pinnedStartMs: 24 * H + 9 * H },
      { id: "satB", pinnedStartMs: null },
    ];
    const floors = dayFloors(rows, anchor);
    const out = packSchedule(
      rows.map((r, i) => ({
        id: r.id,
        order: i,
        players: none,
        minStartMs: floors.get(r.id),
        segments: [{ kind: "pool" as const, minutes: 60, courtsNeeded: 2 }],
      })),
      anchor,
      0,
      8,
    );
    const byId = Object.fromEntries(out.map((p) => [p.id, p.startMs]));
    expect(byId["fri"]).toBe(15 * H); // day 1
    expect(byId["sat"]).toBe(24 * H + 9 * H); // day 2
    expect(byId["satB"]).toBeGreaterThanOrEqual(24 * H + 9 * H); // stays on day 2
  });

  it("an un-pinned event re-flows to the pinned day and IGNORES its own stale start (the 8:35pm bug)", () => {
    // The SchedulePage composition: pinned events are FIXED; un-pinned events are
    // packed with floors derived from pins ONLY (pinnedStartMs null for un-pinned),
    // so a stale bad start on an un-pinned event never floors it.
    const anchor = 0; // Fri 00:00
    const SAT8 = 32 * H; // Sat 8:00am
    const womensEnd = SAT8 + 125 * 60_000; // 2h05
    const fixed = [
      {
        id: "womens30",
        startMs: SAT8,
        endMs: womensEnd,
        courts: [1, 2, 3],
        heldBy: null,
        segments: [{ kind: "pool" as const, startMs: SAT8, endMs: womensEnd, courts: [1, 2, 3] }],
      },
    ];
    // Womens 3.0 pinned Sat 8am; Mens 3.0 un-pinned (its real DB start was a stale
    // Sat 8:35pm — NOT passed here, because dayFloors only reads pinned starts).
    const floors = dayFloors(
      [
        { id: "womens30", pinnedStartMs: SAT8 },
        { id: "mens30", pinnedStartMs: null },
      ],
      anchor,
    );
    const out = packSchedule(
      [
        {
          id: "mens30",
          order: 1,
          players: none,
          minStartMs: floors.get("mens30"),
          segments: [{ kind: "pool" as const, minutes: 135, courtsNeeded: 1 }],
        },
      ],
      anchor,
      0,
      4,
      fixed,
      new Map([["womens30", none]]),
    );
    expect(out[0].startMs).toBe(SAT8); // re-flowed onto Sat 8am, not frozen at 8:35pm
    expect(out[0].courts).toEqual([4]); // the one court Womens 3.0 left free
  });
});
