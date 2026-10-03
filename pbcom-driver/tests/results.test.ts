import { describe, expect, it } from "vitest";
import {
  discoverDivisions,
  fetchDivisionMatches,
  isRoundRobin,
  lastNameOf,
  parseMatch,
  parseMatches,
  teamLastNamesFrom,
  type FetchLike,
} from "../src/pbcom/results.js";

// A completed single-game doubles match exactly as the public getMatchInfos returns it
// (verified live 2026-10-03). Trailing spaces in names are intentional (PB.com pads them).
const COMPLETED = {
  matchUuid: "m-1",
  teamOnePlayerOneName: "Rebekah Moody ",
  teamOnePlayerTwoName: "Heather Pelow ",
  teamTwoPlayerOneName: "Aimee Ross ",
  teamTwoPlayerTwoName: "Kalie Cummings ",
  matchStatus: 4,
  winner: 2,
  inBracketType: "RR",
  teamOneGameOneScore: 9,
  teamTwoGameOneScore: 11,
  teamOneGameTwoScore: 0,
  teamTwoGameTwoScore: 0,
};

describe("lastNameOf / teamLastNamesFrom", () => {
  it("takes the final token, normalized, trimming PB.com's trailing space", () => {
    expect(lastNameOf("Rebekah Moody ")).toBe("moody");
    // Hyphenated compound surnames survive as one token and still match B&E.
    expect(lastNameOf("Anne Smith-Jones")).toBe("smithjones");
    // A SPACE-separated compound surname takes only the final token (a known
    // limitation): it won't match a B&E "Van Dyke" and so falls to the fail-closed
    // unmatched/alert path — never a wrong write.
    expect(lastNameOf("Mary Jo Van Dyke")).toBe("dyke");
    expect(lastNameOf("")).toBe("");
    expect(lastNameOf(null)).toBe("");
  });
  it("builds an order-free last-name set; singles drops the empty partner", () => {
    expect(teamLastNamesFrom("Aimee Ross ", "Kalie Cummings ")).toEqual(["cummings", "ross"]);
    expect(teamLastNamesFrom("Huey Shih", null)).toEqual(["shih"]);
  });
});

describe("parseMatch", () => {
  it("parses a completed single-game match: teams, winner, single score, no multi-game", () => {
    const m = parseMatch(COMPLETED);
    expect(m.completed).toBe(true);
    expect(m.winner).toBe(2);
    expect(m.teamOneLastNames).toEqual(["moody", "pelow"]);
    expect(m.teamTwoLastNames).toEqual(["cummings", "ross"]);
    expect(m.teamOneScore).toBe(9);
    expect(m.teamTwoScore).toBe(11);
    expect(m.multiGame).toBe(false);
    expect(isRoundRobin(m)).toBe(true);
  });

  it("treats matchStatus 1 (and no completed ts, 0-0) as not completed", () => {
    const m = parseMatch({ ...COMPLETED, matchStatus: 1, winner: 0, teamOneGameOneScore: 0, teamTwoGameOneScore: 0 });
    expect(m.completed).toBe(false);
    expect(m.winner).toBeNull();
    expect(m.teamOneScore).toBeNull();
  });

  it("flags a best-of-N (two games scored) as multiGame; score comes from the first played game", () => {
    const m = parseMatch({
      ...COMPLETED,
      teamOneGameOneScore: 11,
      teamTwoGameOneScore: 7,
      teamOneGameTwoScore: 9,
      teamTwoGameTwoScore: 11,
    });
    expect(m.multiGame).toBe(true);
    expect(m.teamOneScore).toBe(11); // first played game
  });

  it("completes via matchCompleted timestamp even if matchStatus is absent", () => {
    const m = parseMatch({ ...COMPLETED, matchStatus: undefined, matchCompleted: "2026-10-03T12:33:51Z" } as never);
    expect(m.completed).toBe(true);
  });
});

describe("discoverDivisions (grid over format/group/date, deduped)", () => {
  it("collects unique divisions and records the date each was found on", async () => {
    // Fake: Womens 3.0 appears on formatId=1,group=2,date=D2; Mens Singles on formatId=2,group=1,date=D1.
    const fetchFn: FetchLike = async (url: string) => {
      const u = new URL(url);
      const f = u.searchParams.get("formatId");
      const g = u.searchParams.get("playerGroupId");
      const d = u.searchParams.get("date");
      let data: Array<{ uuid: string; title: string }> = [];
      if (f === "1" && g === "2" && d === "2026-10-03") data = [{ uuid: "w30", title: "Womens Doubles Skill: (3.0 To 3.49)" }];
      if (f === "2" && g === "1" && d === "2026-10-02") data = [{ uuid: "ms", title: "Mens Singles Skill: (3.0-3.99)" }];
      return { ok: true, status: 200, json: async () => ({ data, statusCode: 200 }) };
    };
    const divs = await discoverDivisions("https://pub", "eid-1", ["2026-10-02", "2026-10-03"], fetchFn);
    expect(divs).toHaveLength(2);
    const w = divs.find((x) => x.uuid === "w30")!;
    expect(w.date).toBe("2026-10-03");
    expect(w.title).toMatch(/Womens Doubles/);
  });

  it("skips non-200 cells without throwing", async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 400, json: async () => ({}) });
    const divs = await discoverDivisions("https://pub", "eid-1", ["2026-10-03"], fetchFn);
    expect(divs).toEqual([]);
  });
});

describe("fetchDivisionMatches", () => {
  it("fetches + parses the getMatchInfos data array", async () => {
    const fetchFn: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [COMPLETED], statusCode: 200 }),
    });
    const ms = await fetchDivisionMatches("https://pub", { uuid: "w30", title: "x", date: "2026-10-03" }, fetchFn);
    expect(ms).toHaveLength(1);
    expect(ms[0]!.completed).toBe(true);
  });

  it("returns [] on a non-200", async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const ms = await fetchDivisionMatches("https://pub", { uuid: "x", title: "x", date: "d" }, fetchFn);
    expect(ms).toEqual([]);
  });
});

describe("parseMatches", () => {
  it("maps every row", () => {
    expect(parseMatches([COMPLETED, { ...COMPLETED, matchUuid: "m-2" }])).toHaveLength(2);
  });
});
