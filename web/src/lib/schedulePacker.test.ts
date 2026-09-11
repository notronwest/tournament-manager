import { describe, it, expect } from "vitest";
import { packSchedule, parallelGroups, courtsNeededFor } from "./schedulePacker";

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
        { id: "a", order: 1, minutes: 110, courtsNeeded: 4, players: none },
        { id: "b", order: 2, minutes: 110, courtsNeeded: 4, players: none },
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
        { id: "a", order: 1, minutes: 60, courtsNeeded: 4, players: none },
        { id: "b", order: 2, minutes: 120, courtsNeeded: 4, players: none },
        { id: "c", order: 3, minutes: 60, courtsNeeded: 6, players: none },
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
        { id: "a", order: 1, minutes: 60, courtsNeeded: 2, players: new Set(["p1"]) },
        { id: "b", order: 2, minutes: 60, courtsNeeded: 2, players: new Set(["p1", "p2"]) },
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
        { id: "late", order: 2, minutes: 60, courtsNeeded: 8, players: none },
        { id: "first", order: 1, minutes: 60, courtsNeeded: 8, players: none },
      ],
      0,
      0,
      8,
    );
    expect(out.find((p) => p.id === "first")!.startMs).toBe(0);
    expect(out.find((p) => p.id === "late")!.startMs).toBe(H);
  });

  it("caps courts needed at the venue size", () => {
    const out = packSchedule([{ id: "a", order: 1, minutes: 60, courtsNeeded: 20, players: none }], 0, 0, 6);
    expect(out[0].courts).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("parallelGroups", () => {
  it("groups overlapping placements and drops singletons", () => {
    const groups = parallelGroups([
      { id: "a", startMs: 0, endMs: H, courts: [1] },
      { id: "b", startMs: 0, endMs: H, courts: [2] },
      { id: "c", startMs: 2 * H, endMs: 3 * H, courts: [1] },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((p) => p.id).sort()).toEqual(["a", "b"]);
  });
});
