import { describe, expect, it } from "vitest";
import {
  parsePbBuffer,
  parseAttendees,
  parseDivisionLabel,
  resolveColumns,
  unmappedColumns,
  divisionKey,
} from "./pbImport";
// A fully anonymized sample in the real PB.com "Export Player w/ Events (Flat File)"
// format (synthetic names, emails, phones, DUPR ids + record UUIDs — the export's
// exact column layout and multi-row-per-attendee shape preserved), loaded verbatim
// via Vite's ?raw so the tests run against the real export structure.
import csvText from "./__fixtures__/pb-attendees-sample.csv?raw";

const parsed = parsePbBuffer(new TextEncoder().encode(csvText));

describe("parsePbBuffer + resolveColumns (real PB.com export)", () => {
  it("reads the header and all data rows", () => {
    expect(parsed.headers[0]).toBe("LastName");
    expect(parsed.headers).toContain("AttendeeHeaderID");
    expect(parsed.headers).toContain("Rating_DUPR_DBL");
    expect(parsed.headers).toContain("Event 1");
    // 2 attendees × (1 header row + 1 event row) = 4 data rows.
    expect(parsed.rows.length).toBe(4);
  });

  it("resolves the known columns by name and detects the Event N columns", () => {
    const cols = resolveColumns(parsed.headers);
    expect(cols.lastName).toBeGreaterThanOrEqual(0);
    expect(cols.activityId).toBeGreaterThanOrEqual(0);
    expect(cols.attendeeHeaderId).toBeGreaterThanOrEqual(0);
    expect(cols.duprId).toBeGreaterThanOrEqual(0);
    expect(cols.ratingDuprDbl).toBeGreaterThanOrEqual(0);
    expect(cols.eventCols.length).toBe(10); // Event 1..Event 10
  });

  it("reports the alternate rating systems as unmapped (only DUPR is imported)", () => {
    const cols = resolveColumns(parsed.headers);
    const unmapped = unmappedColumns(parsed.headers, cols);
    expect(unmapped).toContain("Rating_SELF_DBL");
    expect(unmapped).toContain("Rating_WPR_DBL");
    // DUPR + identity + event columns are NOT unmapped.
    expect(unmapped).not.toContain("Rating_DUPR_DBL");
    expect(unmapped).not.toContain("Event 1");
  });
});

describe("parseDivisionLabel", () => {
  it("parses a skill doubles division", () => {
    const d = parseDivisionLabel("Mens Doubles Skill: (3.0 To 3.49)");
    expect(d).toMatchObject({ gender: "men", format: "doubles", bracketType: "skill", low: 3.0, high: 3.49 });
  });
  it("parses womens / mixed / singles / age variants", () => {
    expect(parseDivisionLabel("Womens Doubles Skill: (3.5 To 3.99)").gender).toBe("women");
    expect(parseDivisionLabel("Mixed Doubles Skill: (4.0 To 4.49)").gender).toBe("mixed");
    expect(parseDivisionLabel("Mens Singles Skill: (3.0 To 3.49)").format).toBe("singles");
    const age = parseDivisionLabel("Mens Doubles Age: (50 To 59)");
    expect(age).toMatchObject({ bracketType: "age", low: 50, high: 59 });
  });
  it("does not confuse 'women' for 'men'", () => {
    expect(parseDivisionLabel("Womens Doubles").gender).toBe("women");
  });
});

describe("parseAttendees (multi-row-per-attendee grouping)", () => {
  const { attendees } = parseAttendees(parsed);

  it("groups the flat rows into one attendee per AttendeeHeaderID", () => {
    expect(attendees.length).toBe(2);
    const alex = attendees.find((a) => a.firstName === "Alex")!;
    const jordan = attendees.find((a) => a.firstName === "Jordan")!;
    expect(alex.lastName).toBe("Rivera");
    expect(jordan.lastName).toBe("Chen");
    expect(alex.attendeeHeaderId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("extracts one entry per filled Event column, with the division + PB ids", () => {
    const alex = parseAttendees(parsed).attendees.find((a) => a.firstName === "Alex")!;
    expect(alex.entries.length).toBe(1);
    const e = alex.entries[0];
    expect(e.divisionLabel).toBe("Mens Doubles Skill: (3.0 To 3.49)");
    expect(e.activityId).toBe("22222222-2222-4222-8222-222222222222");
    expect(e.division.format).toBe("doubles");
    expect(e.division.gender).toBe("men");
    expect(e.eventColumnIndex).toBe(1); // Alex's division sits in "Event 1"
    // No TeamID in this sample → an unpaired (seeking) doubles entry.
    expect(e.teamId).toBe("");
  });

  it("captures DUPR id + ratings, treating 0 as 'not provided'", () => {
    const { attendees: a } = parseAttendees(parsed);
    const alex = a.find((x) => x.firstName === "Alex")!;
    const jordan = a.find((x) => x.firstName === "Jordan")!;
    expect(alex.duprId).toBe("DUPRAA1");
    expect(Number(alex.ratingDuprDbl)).toBeGreaterThan(3);
    expect(Number(alex.ratingDuprS)).toBe(0); // 0 = not provided (normalized to null later)
    expect(jordan.duprId).toBe("DUPRBB2");
    expect(Number(jordan.ratingDuprS)).toBeCloseTo(4.16, 2);
  });

  it("keys divisions by label (the tournament Event-column ordinal is incidental)", () => {
    expect(divisionKey("Mens Doubles Skill: (3.0 To 3.49)")).toBe(
      "mens doubles skill: (3.0 to 3.49)",
    );
  });
});
