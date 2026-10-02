import { describe, expect, it } from "vitest";
import {
  computeSeedMoves,
  findMatchRow,
  lastNameSet,
  lastNameSetKey,
  matchTeamsKey,
  normalizeName,
  SeedOrderError,
  type PbMatchRow,
} from "../src/pbcom/matchMap.js";
import { splitLastNames } from "../src/pbcom/driver.js";

describe("normalizeName", () => {
  it("lowercases, strips diacritics, spaces and punctuation", () => {
    expect(normalizeName("O'Brien")).toBe("obrien");
    expect(normalizeName("Van Dyke")).toBe("vandyke");
    expect(normalizeName("José")).toBe("jose");
    expect(normalizeName("  St. Clair ")).toBe("stclair");
  });
});

describe("lastNameSet / key", () => {
  it("is order-independent and de-duplicated", () => {
    expect(lastNameSet(["Jones", "Smith"])).toEqual(["jones", "smith"]);
    expect(lastNameSetKey(["Smith", "Jones"])).toBe(lastNameSetKey(["Jones", "Smith"]));
  });
  it("matchTeamsKey collapses A-vs-B and B-vs-A", () => {
    expect(matchTeamsKey(["Smith"], ["Jones"])).toBe(matchTeamsKey(["Jones"], ["Smith"]));
  });
});

describe("findMatchRow (flow C — the crux)", () => {
  const rows: PbMatchRow[] = [
    { ref: "row:0", teamOneLastNames: ["Smith", "Jones"], teamTwoLastNames: ["Burke", "Booth"] },
    { ref: "row:1", teamOneLastNames: ["Adler", "Ash"], teamTwoLastNames: ["Cole", "Cruz"] },
  ];

  it("matches by unordered last-name sets and returns orientation", () => {
    const r = findMatchRow(["Jones", "Smith"], ["Booth", "Burke"], rows);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.match.row.ref).toBe("row:0");
      expect(r.match.aIsTeamOne).toBe(true); // team A (Smith/Jones) is PB team-one
    }
  });

  it("detects the reversed orientation (A is PB team-two)", () => {
    const r = findMatchRow(["Booth", "Burke"], ["Jones", "Smith"], rows);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.match.aIsTeamOne).toBe(false);
  });

  it("normalizes names before matching (case / punctuation / accents)", () => {
    const accented: PbMatchRow[] = [
      { ref: "row:0", teamOneLastNames: ["O'Brien"], teamTwoLastNames: ["José"] },
    ];
    const r = findMatchRow(["obrien"], ["jose"], accented);
    expect(r.ok).toBe(true);
  });

  it("returns not_found when no row matches", () => {
    const r = findMatchRow(["Nobody"], ["Here"], rows);
    expect(r).toEqual({ ok: false, reason: "not_found", candidates: 0 });
  });

  it("returns ambiguous when two rows share the same pair of last-name sets", () => {
    const dup: PbMatchRow[] = [
      { ref: "row:0", teamOneLastNames: ["Smith"], teamTwoLastNames: ["Jones"] },
      { ref: "row:1", teamOneLastNames: ["Jones"], teamTwoLastNames: ["Smith"] },
    ];
    const r = findMatchRow(["Smith"], ["Jones"], dup);
    expect(r).toEqual({ ok: false, reason: "ambiguous", candidates: 2 });
  });
});

describe("computeSeedMoves (flow A s4 — Move Up/Down)", () => {
  it("no moves when already in the desired order", () => {
    expect(computeSeedMoves(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
  });

  it("bubbles a team up to the top", () => {
    const moves = computeSeedMoves(["a", "b", "c"], ["c", "a", "b"]);
    expect(moves).toEqual([
      { teamKey: "c", direction: "up" },
      { teamKey: "c", direction: "up" },
    ]);
  });

  it("produces a sequence that actually transforms current → desired", () => {
    const current = ["w", "x", "y", "z"];
    const desired = ["z", "w", "y", "x"];
    const moves = computeSeedMoves(current, desired);
    // Replay the up-moves and confirm the result equals desired.
    const work = [...current];
    for (const m of moves) {
      const j = work.indexOf(m.teamKey);
      expect(j).toBeGreaterThan(0);
      [work[j - 1], work[j]] = [work[j]!, work[j - 1]!];
    }
    expect(work).toEqual(desired);
  });

  it("throws when the team sets differ", () => {
    expect(() => computeSeedMoves(["a", "b"], ["a", "c"])).toThrow(SeedOrderError);
    expect(() => computeSeedMoves(["a"], ["a", "b"])).toThrow(SeedOrderError);
  });
});

describe("splitLastNames (row text → last names)", () => {
  it("handles 'Last / Last' doubles rows", () => {
    expect(splitLastNames("Smith / Jones")).toEqual(["Smith", "Jones"]);
  });
  it("handles 'Last, First & Last, First' rows", () => {
    expect(splitLastNames("Smith, John & Jones, Amy")).toEqual(["Smith", "Jones"]);
  });
  it("handles 'First Last' singles rows", () => {
    expect(splitLastNames("John Smith")).toEqual(["Smith"]);
  });
});

import { firstNameSet, surnameCollisions } from "../src/pbcom/matchMap.js";
import { splitFirstNames } from "../src/pbcom/driver.js";

describe("firstNameSet / splitFirstNames", () => {
  it("normalizes + sorts first names", () => {
    expect(firstNameSet(["John", "amy", "José"])).toEqual(["amy", "john", "jose"]);
  });
  it("extracts first names from both row formats", () => {
    expect(splitFirstNames("Smith, John & Jones, Amy")).toEqual(["John", "Amy"]);
    expect(splitFirstNames("John Smith / Amy Jones")).toEqual(["John", "Amy"]);
  });
});

describe("findMatchRow — first-name tiebreak", () => {
  // Two different "Smith / Jones vs Brown / Davis" games in one division.
  const rows: PbMatchRow[] = [
    {
      ref: "row:0",
      teamOneLastNames: ["Smith", "Jones"],
      teamTwoLastNames: ["Brown", "Davis"],
      teamOneFirstNames: ["John", "Amy"],
      teamTwoFirstNames: ["Bob", "Sue"],
    },
    {
      ref: "row:1",
      teamOneLastNames: ["Smith", "Jones"],
      teamTwoLastNames: ["Brown", "Davis"],
      teamOneFirstNames: ["Mike", "Kate"],
      teamTwoFirstNames: ["Tom", "Lisa"],
    },
  ];

  it("is ambiguous on last names alone (no hint)", () => {
    const r = findMatchRow(["Smith", "Jones"], ["Brown", "Davis"], rows);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ambiguous");
  });

  it("resolves to the right row via first names", () => {
    const r = findMatchRow(["Smith", "Jones"], ["Brown", "Davis"], rows, {
      teamAFirstNames: ["Mike", "Kate"],
      teamBFirstNames: ["Tom", "Lisa"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.match.row.ref).toBe("row:1");
  });

  it("respects orientation (A on team-two side still resolves + flags aIsTeamOne=false)", () => {
    const r = findMatchRow(["Brown", "Davis"], ["Smith", "Jones"], rows, {
      teamAFirstNames: ["Bob", "Sue"],
      teamBFirstNames: ["John", "Amy"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.match.row.ref).toBe("row:0");
      expect(r.match.aIsTeamOne).toBe(false);
    }
  });

  it("stays ambiguous when first names don't single one out", () => {
    const r = findMatchRow(["Smith", "Jones"], ["Brown", "Davis"], rows, {
      teamAFirstNames: ["Nobody", "Here"],
      teamBFirstNames: ["Not", "Found"],
    });
    expect(r.ok).toBe(false);
  });

  it("never promotes a non-last-name match", () => {
    const r = findMatchRow(["Wrong", "Names"], ["No", "Match"], rows, {
      teamAFirstNames: ["John", "Amy"],
      teamBFirstNames: ["Bob", "Sue"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });
});

describe("surnameCollisions", () => {
  it("finds matches sharing a surname pairing", () => {
    const groups = surnameCollisions([
      { matchId: "m1", teamALastNames: ["Smith", "Jones"], teamBLastNames: ["Brown", "Davis"] },
      { matchId: "m2", teamALastNames: ["Brown", "Davis"], teamBLastNames: ["Smith", "Jones"] }, // same pairing, A/B flipped
      { matchId: "m3", teamALastNames: ["Aiken", "Reed"], teamBLastNames: ["Hill", "Vaal"] },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.matchIds.sort()).toEqual(["m1", "m2"]);
  });
  it("ignores byes (a team with no names)", () => {
    expect(surnameCollisions([
      { matchId: "m1", teamALastNames: ["Smith"], teamBLastNames: [] },
      { matchId: "m2", teamALastNames: ["Smith"], teamBLastNames: [] },
    ])).toHaveLength(0);
  });
  it("returns nothing when every match is uniquely named", () => {
    expect(surnameCollisions([
      { matchId: "m1", teamALastNames: ["Smith"], teamBLastNames: ["Brown"] },
      { matchId: "m2", teamALastNames: ["Jones"], teamBLastNames: ["Davis"] },
    ])).toHaveLength(0);
  });
});

import { eventsConsoleUrl, divisionBracketUrl } from "../src/pbcom/driver.js";

describe("director URLs are built against the configured host (not page.url())", () => {
  it("eventsConsoleUrl uses the director base, not wherever the browser sits", () => {
    // The rehearsal caught this: after login the page is on pickleballtournaments.com,
    // so a URL built relative to it 404s. It must use PBCOM_BASE_URL.
    expect(eventsConsoleUrl("https://pickleballbrackets.com", "eid-1")).toBe(
      "https://pickleballbrackets.com/a5_u/pbt/eDB.aspx?eid=eid-1",
    );
    expect(eventsConsoleUrl("https://train.pickleballbrackets.dev", "eid-1")).toBe(
      "https://train.pickleballbrackets.dev/a5_u/pbt/eDB.aspx?eid=eid-1",
    );
  });
  it("falls back to the live director host when base is empty", () => {
    expect(eventsConsoleUrl("", "eid-2")).toBe("https://pickleballbrackets.com/a5_u/pbt/eDB.aspx?eid=eid-2");
  });
  it("divisionBracketUrl (ptsrr) uses the director base too", () => {
    expect(divisionBracketUrl("https://pickleballbrackets.com", "plid-9")).toBe(
      "https://pickleballbrackets.com/a5_u/pbt/ptsrr.aspx?plid=plid-9",
    );
  });
});
