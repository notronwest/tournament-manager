import { describe, expect, it } from "vitest";
import { parsePbBuffer, parseAttendees, divisionKey, type PbAttendee, type ParsedAttendees } from "./pbImport";
import { buildPlan, planTotals, parseDupr, playerKeyOf } from "./pbReconcile";
import csvText from "./__fixtures__/pb-attendees-sample.csv?raw";

const parsedReal = parseAttendees(parsePbBuffer(new TextEncoder().encode(csvText)));

// ── helpers to build synthetic attendees for cases not in the 2-row sample ──
function attendee(over: Partial<PbAttendee>): PbAttendee {
  return {
    attendeeHeaderId: over.attendeeHeaderId ?? "h",
    lastName: over.lastName ?? "Doe",
    firstName: over.firstName ?? "Jo",
    gender: over.gender ?? "",
    email: over.email ?? "",
    phone: over.phone ?? "",
    age: over.age ?? "",
    duprId: over.duprId ?? "",
    ratingDuprDbl: over.ratingDuprDbl ?? "",
    ratingDuprS: over.ratingDuprS ?? "",
    serviceFeeTotal: over.serviceFeeTotal ?? "0",
    entries: over.entries ?? [],
  };
}
function wrap(attendees: PbAttendee[]): ParsedAttendees {
  return { attendees, skippedRows: 0 };
}
const doublesMeta = { raw: "", gender: "men" as const, format: "doubles" as const, bracketType: "skill" as const, low: 3.0, high: 3.49 };

describe("buildPlan — real PB.com export, fresh tournament", () => {
  const plan = buildPlan(parsedReal, { divisionKeys: [], entries: [] });

  it("plans the two players, two divisions and two entries to add", () => {
    const t = planTotals(plan);
    expect(t.players).toBe(2);
    expect(t.divisionsNew).toBe(2);
    expect(t.add).toBe(2);
    expect(t.unchanged).toBe(0);
    expect(t.drop).toBe(0);
    expect(t.pairs).toBe(0); // no TeamID in the sample → unpaired doubles
  });

  it("carries DUPR onto the plan players (0 → null)", () => {
    const alex = plan.players.find((p) => p.firstName === "Alex")!;
    expect(alex.duprId).toBe("DUPRAA1");
    expect(alex.duprDoubles).not.toBeNull();
    expect(alex.duprSingles).toBeNull(); // Alex's singles DUPR was 0
    const jordan = plan.players.find((p) => p.firstName === "Jordan")!;
    expect(jordan.duprSingles).toBeCloseTo(4.16, 2);
  });
});

describe("buildPlan — idempotent re-import", () => {
  it("a second import of the same file adds nothing and drops nothing", () => {
    const first = buildPlan(parsedReal, { divisionKeys: [], entries: [] });
    // Simulate the state after the first import: divisions created, each entry
    // now present under its ActivityID.
    const existing = {
      divisionKeys: first.divisionsToCreate.map((d) => d.key),
      entries: first.toAdd.map((e) => ({
        activityId: e.activityId,
        divisionKey: e.divisionKey,
        playerKey: e.playerKey,
      })),
    };
    const second = buildPlan(parsedReal, existing);
    const t = planTotals(second);
    expect(t.add).toBe(0);
    expect(t.unchanged).toBe(2);
    expect(t.divisionsNew).toBe(0);
    expect(t.drop).toBe(0);
  });
});

describe("buildPlan — doubles pairing by TeamID", () => {
  it("pairs two entries that share a TeamID in the same division", () => {
    const div = "Mens Doubles Skill: (3.0 To 3.49)";
    const a = attendee({
      firstName: "Amy", lastName: "A", email: "amy@x.com", attendeeHeaderId: "a",
      entries: [{ activityId: "act-a", teamId: "T1", divisionLabel: div, division: doublesMeta, eventColumnIndex: 1 }],
    });
    const b = attendee({
      firstName: "Bea", lastName: "B", email: "bea@x.com", attendeeHeaderId: "b",
      entries: [{ activityId: "act-b", teamId: "T1", divisionLabel: div, division: doublesMeta, eventColumnIndex: 1 }],
    });
    const plan = buildPlan(wrap([a, b]), { divisionKeys: [], entries: [] });
    expect(plan.pairs.length).toBe(1);
    const keys = [plan.pairs[0].aKey, plan.pairs[0].bKey].sort();
    expect(keys).toEqual([playerKeyOf("amy@x.com", "", ""), playerKeyOf("bea@x.com", "", "")].sort());
    expect(plan.pairs[0].divisionKey).toBe(divisionKey(div));
  });

  it("does not pair a solo entry with a blank TeamID", () => {
    const a = attendee({
      firstName: "Solo", email: "solo@x.com",
      entries: [{ activityId: "act-s", teamId: "", divisionLabel: "Mens Doubles Skill: (3.0 To 3.49)", division: doublesMeta, eventColumnIndex: 1 }],
    });
    const plan = buildPlan(wrap([a]), { divisionKeys: [], entries: [] });
    expect(plan.pairs.length).toBe(0);
  });
});

describe("buildPlan — drops flagged, never invented", () => {
  it("flags an existing pbcom entry whose ActivityID is gone from the file", () => {
    const a = attendee({
      firstName: "Keep", email: "keep@x.com",
      entries: [{ activityId: "act-keep", teamId: "", divisionLabel: "Mens Doubles Skill: (3.0 To 3.49)", division: doublesMeta, eventColumnIndex: 1 }],
    });
    const existing = {
      divisionKeys: [divisionKey("Mens Doubles Skill: (3.0 To 3.49)")],
      entries: [
        { activityId: "act-keep", divisionKey: divisionKey("Mens Doubles Skill: (3.0 To 3.49)"), playerKey: playerKeyOf("keep@x.com", "", "") },
        { activityId: "act-gone", divisionKey: divisionKey("Mens Doubles Skill: (3.0 To 3.49)"), playerKey: "player:xyz" },
      ],
    };
    const plan = buildPlan(wrap([a]), existing);
    expect(plan.toAdd.length).toBe(0);
    expect(plan.unchanged.length).toBe(1);
    expect(plan.toDrop.map((d) => d.activityId)).toEqual(["act-gone"]);
  });
});

describe("parseDupr", () => {
  it("treats 0 / blank / junk as null and keeps real ratings", () => {
    expect(parseDupr("0")).toBeNull();
    expect(parseDupr("")).toBeNull();
    expect(parseDupr("n/a")).toBeNull();
    expect(parseDupr("4.16")).toBeCloseTo(4.16, 2);
  });
});
