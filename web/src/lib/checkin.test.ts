import { describe, it, expect } from "vitest";
import {
  buildCheckInRoster,
  checkInRegIds,
  eventCheckInGate,
  filterCheckInRoster,
  countsForCheckIn,
  type CheckInReg,
  type CheckInPlayerLite,
  type CheckInEventLite,
} from "./checkin";

const player = (
  id: string,
  first: string,
  last: string,
  email: string | null = null,
  phone: string | null = null,
): CheckInPlayerLite => ({ id, first_name: first, last_name: last, email, phone });

const reg = (
  id: string,
  eventId: string,
  playerId: string,
  status: CheckInReg["status"] = "paid",
  checkedInAt: string | null = null,
): CheckInReg => ({
  id,
  event_id: eventId,
  player_id: playerId,
  status,
  checked_in_at: checkedInAt,
});

const events: CheckInEventLite[] = [
  { id: "mens", name: "Mens 2.75-3.25" },
  { id: "mixed", name: "Mixed 2.75-3.25" },
  { id: "womens", name: "Womens 2.75+" },
];

const T = "2026-09-12T13:00:00.000Z";

describe("countsForCheckIn", () => {
  it("counts spot-holding statuses, excludes free-waitlist and inactive", () => {
    expect(countsForCheckIn("paid")).toBe(true);
    expect(countsForCheckIn("pending_payment")).toBe(true);
    expect(countsForCheckIn("waitlisted_pending_payment")).toBe(true);
    expect(countsForCheckIn("waitlisted")).toBe(false);
    expect(countsForCheckIn("withdrawn")).toBe(false);
    expect(countsForCheckIn("cancelled")).toBe(false);
    expect(countsForCheckIn("refunded")).toBe(false);
  });
});

describe("checkInRegIds — check ALL a player's events at once", () => {
  it("returns every spot-holding reg the player has across the tournament", () => {
    const regs = [
      reg("r1", "mens", "p1"),
      reg("r2", "mixed", "p1"),
      reg("r3", "womens", "p1", "pending_payment"),
    ];
    expect(checkInRegIds(regs).sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("skips waitlisted / withdrawn / cancelled rows", () => {
    const regs = [
      reg("r1", "mens", "p1", "paid"),
      reg("r2", "mixed", "p1", "waitlisted"),
      reg("r3", "womens", "p1", "withdrawn"),
    ];
    expect(checkInRegIds(regs)).toEqual(["r1"]);
  });

  it("returns an empty list when the player holds no spots", () => {
    expect(checkInRegIds([reg("r1", "mens", "p1", "cancelled")])).toEqual([]);
  });
});

describe("buildCheckInRoster", () => {
  const players = [
    player("p1", "Brian", "Cromer"),
    player("p2", "David", "Bailey", "david@x.com"),
    player("p3", "Ryan", "Amaral"),
    player("gone", "Gone", "Away"),
  ];
  const regs = [
    reg("r1", "mens", "p1"),
    reg("r2", "mixed", "p1"), // Cromer is in two events
    reg("r3", "mens", "p2"),
    reg("r4", "mens", "p3"),
    reg("r5", "womens", "gone", "withdrawn"), // excluded entirely
  ];

  it("groups by player, sorts A-Z by last name, and lists their events", () => {
    const roster = buildCheckInRoster(players, regs, events);
    expect(roster.map((e) => e.lastName)).toEqual(["Amaral", "Bailey", "Cromer"]);
    const cromer = roster.find((e) => e.lastName === "Cromer")!;
    expect(cromer.events.map((e) => e.name)).toEqual([
      "Mens 2.75-3.25",
      "Mixed 2.75-3.25",
    ]);
    expect(cromer.regIds.sort()).toEqual(["r1", "r2"]);
  });

  it("marks a player checked in only when ALL their regs are stamped", () => {
    const partial = buildCheckInRoster(
      players,
      [reg("r1", "mens", "p1", "paid", T), reg("r2", "mixed", "p1")],
      events,
    );
    expect(partial.find((e) => e.playerId === "p1")!.checkedIn).toBe(false);

    const full = buildCheckInRoster(
      players,
      [reg("r1", "mens", "p1", "paid", T), reg("r2", "mixed", "p1", "paid", T)],
      events,
    );
    const c = full.find((e) => e.playerId === "p1")!;
    expect(c.checkedIn).toBe(true);
    expect(c.checkedInAt).toBe(T);
  });
});

describe("filterCheckInRoster", () => {
  const roster = buildCheckInRoster(
    [player("p1", "Brian", "Cromer", "brian@x.com", "603-555-1212"), player("p2", "David", "Bailey")],
    [reg("r1", "mens", "p1"), reg("r2", "mens", "p2")],
    events,
  );

  it("returns everyone for an empty query", () => {
    expect(filterCheckInRoster(roster, "  ").length).toBe(2);
  });
  it("matches by name token", () => {
    expect(filterCheckInRoster(roster, "cro").map((e) => e.lastName)).toEqual(["Cromer"]);
  });
  it("matches by email and phone", () => {
    expect(filterCheckInRoster(roster, "brian@x").length).toBe(1);
    expect(filterCheckInRoster(roster, "555").length).toBe(1);
  });
  it("requires every token to match", () => {
    expect(filterCheckInRoster(roster, "brian cromer").length).toBe(1);
    expect(filterCheckInRoster(roster, "brian bailey").length).toBe(0);
  });
});

describe("eventCheckInGate", () => {
  const playerById = new Map([
    ["p1", player("p1", "Brian", "Cromer")],
    ["p2", player("p2", "David", "Bailey")],
    ["p3", player("p3", "Ryan", "Amaral")],
  ]);

  it("passes when every registered player is checked in", () => {
    const gate = eventCheckInGate(
      [reg("r1", "mens", "p1", "paid", T), reg("r2", "mens", "p2", "paid", T)],
      playerById,
    );
    expect(gate).toMatchObject({ total: 2, checkedIn: 2, allCheckedIn: true });
    expect(gate.missing).toEqual([]);
  });

  it("blocks and lists missing players, sorted by name", () => {
    const gate = eventCheckInGate(
      [
        reg("r1", "mens", "p1", "paid", T), // Cromer in
        reg("r2", "mens", "p2"), // Bailey missing
        reg("r3", "mens", "p3"), // Amaral missing
      ],
      playerById,
    );
    expect(gate.allCheckedIn).toBe(false);
    expect(gate.checkedIn).toBe(1);
    expect(gate.total).toBe(3);
    expect(gate.missing.map((m) => m.name)).toEqual(["David Bailey", "Ryan Amaral"]);
  });

  it("ignores non-spot-holding rows (waitlist / withdrawn don't block)", () => {
    const gate = eventCheckInGate(
      [
        reg("r1", "mens", "p1", "paid", T),
        reg("r2", "mens", "p2", "waitlisted"),
        reg("r3", "mens", "p3", "withdrawn"),
      ],
      playerById,
    );
    expect(gate.allCheckedIn).toBe(true);
    expect(gate.total).toBe(1);
  });

  it("an empty event is not 'allCheckedIn' (nothing to start)", () => {
    expect(eventCheckInGate([], playerById).allCheckedIn).toBe(false);
  });
});
