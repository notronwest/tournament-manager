import { describe, it, expect } from "vitest";
import { packSchedule, parallelGroups, courtsNeededFor, poolCourtsNeeded, medalCourtsNeeded, type PackItem } from "./schedulePacker";

const one = (id: string, order: number, minutes: number, courtsNeeded: number, players: ReadonlySet<string> = none): PackItem => ({
  id,
  order,
  players,
  segments: [{ kind: "pool", minutes, courtsNeeded }],
});

const H = 60 * 60_000;
const none = new Set<string>();

describe("courtsNeededFor", () => {
  it("2 pools of 5 keep 4 courts busy; 8 teams in one pool keep 4; 7 teams keep 3", () => {
    expect(courtsNeededFor(9, 2, 6)).toBe(4);
    expect(courtsNeededFor(10, 2, 6)).toBe(4);
    expect(courtsNeededFor(8, 1, 6)).toBe(4);
    expect(courtsNeededFor(7, 1, 4)).toBe(3);
    expect(courtsNeededFor(11, 2, 6)).toBe(6);
  });
  it("never below 1 and medal round can't push it above pool need for normal brackets", () => {
    expect(courtsNeededFor(0, 1, 0)).toBe(1);
    expect(courtsNeededFor(4, 1, 4)).toBe(2);
  });
});

describe("packSchedule", () => {
  it("runs two 4-court events side by side on 8 courts, with disjoint court slices", () => {
    const out = packSchedule(
      [
        one("a", 1, 110, 4, none),
        one("b", 2, 110, 4, none),
      ],
      0,
      15 * 60_000,
      8,
    );
    expect(out[0].startMs).toBe(0);
    expect(out[1].startMs).toBe(0);
    expect(out[0].courts).toEqual([1, 2, 3, 4]);
    expect(out[1].courts).toEqual([5, 6, 7, 8]);
  });

  it("queues an event that doesn't fit, after the earliest end plus the buffer", () => {
    const out = packSchedule(
      [
        one("a", 1, 60, 4, none),
        one("b", 2, 120, 4, none),
        one("c", 3, 60, 6, none),
      ],
      0,
      15 * 60_000,
      8,
    );
    const c = out.find((p) => p.id === "c")!;
    // a ends at 60; b runs to 120. c needs 6 courts → only fits after b: 120 + 15.
    expect(c.startMs).toBe(135 * 60_000);
  });

  it("keeps a shared player out of two overlapping events", () => {
    const out = packSchedule(
      [
        one("a", 1, 60, 2, new Set(["p1"])),
        one("b", 2, 60, 2, new Set(["p1", "p2"])),
      ],
      0,
      0,
      8,
    );
    expect(out[1].startMs).toBe(H);
  });

  it("respects the chosen order, not array order", () => {
    const out = packSchedule(
      [
        one("late", 2, 60, 8, none),
        one("first", 1, 60, 8, none),
      ],
      0,
      0,
      8,
    );
    expect(out.find((p) => p.id === "first")!.startMs).toBe(0);
    expect(out.find((p) => p.id === "late")!.startMs).toBe(H);
  });

  it("caps courts needed at the venue size", () => {
    const out = packSchedule([one("a", 1, 60, 20, none)], 0, 0, 6);
    expect(out[0].courts).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("packSchedule — hold reasons", () => {
  it("names the event and shared-player count that held an event back", () => {
    const out = packSchedule(
      [
        one("womens", 1, 125, 3, new Set(["sue"])),
        one("mixed", 2, 80, 4, new Set(["sue", "tom"])),
        one("mens", 3, 110, 4, new Set(["tom2"])),
      ],
      0,
      15 * 60_000,
      8,
    );
    const mixed = out.find((p) => p.id === "mixed")!;
    expect(mixed.startMs).toBe(140 * 60_000);
    expect(mixed.heldBy?.playerClashes).toEqual([{ id: "womens", shared: 1 }]);
    expect(mixed.heldBy?.courtsShort).toBe(0);
    const mens = out.find((p) => p.id === "mens")!;
    expect(mens.startMs).toBe(0);
    expect(mens.heldBy).toBeNull();
  });

  it("reports courts short when that is what blocked the earlier slot", () => {
    const out = packSchedule(
      [
        one("a", 1, 60, 6, none),
        one("b", 2, 60, 4, none),
      ],
      0,
      0,
      8,
    );
    expect(out[1].heldBy?.courtsShort).toBe(2);
    expect(out[1].heldBy?.playerClashes).toEqual([]);
  });
});

describe("packSchedule — medal round as its own phase", () => {
  it("lets the next event start on courts pool play released while the bracket runs", () => {
    const out = packSchedule(
      [
        { id: "womens", order: 1, players: none, segments: [{ kind: "pool", minutes: 105, courtsNeeded: 3 }, { kind: "medal", minutes: 20, courtsNeeded: 2 }] },
        { id: "mens", order: 2, players: none, segments: [{ kind: "pool", minutes: 75, courtsNeeded: 6 }, { kind: "medal", minutes: 20, courtsNeeded: 2 }] },
      ],
      0,
      0,
      8,
    );
    const w = out[0]; const m = out[1];
    expect(w.segments[0].courts).toEqual([1, 2, 3]);
    expect(w.segments[1].courts).toEqual([1, 2]); // medal on the lowest pool courts
    // mens needs 6: at t=0 only 5 free; at 105 pool play frees court 3 → 6 free (3–8)
    expect(m.startMs).toBe(105 * 60_000);
    expect(m.segments[0].courts).toEqual([3, 4, 5, 6, 7, 8]);
  });
});

describe("pool/medal court needs", () => {
  it("splits the need by phase", () => {
    expect(poolCourtsNeeded(7, 1)).toBe(3);
    expect(medalCourtsNeeded(4)).toBe(2);
    expect(medalCourtsNeeded(0)).toBe(0);
    expect(courtsNeededFor(7, 1, 4)).toBe(3);
  });
});

describe("parallelGroups", () => {
  it("groups overlapping placements and drops singletons", () => {
    const groups = parallelGroups([
      { id: "a", startMs: 0, endMs: H, courts: [1], heldBy: null, segments: [] },
      { id: "b", startMs: 0, endMs: H, courts: [2], heldBy: null, segments: [] },
      { id: "c", startMs: 2 * H, endMs: 3 * H, courts: [1], heldBy: null, segments: [] },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((p) => p.id).sort()).toEqual(["a", "b"]);
  });
});
