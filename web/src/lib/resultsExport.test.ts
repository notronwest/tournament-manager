import { describe, it, expect } from "vitest";
import { standingsToRows, resultsToCsv, resultsFilename } from "./resultsExport";
import type { Medal, Standing } from "../pages/admin/EventConsolePage";

const team = (
  captainRegId: string,
  label: string,
  poolIndex: number | null,
) => ({
  captainRegId,
  partnerRegId: null,
  captain: {} as never,
  partner: null,
  label,
  registeredAt: "2026-01-01",
  poolIndex,
  seed: null,
});

const standing = (
  captainRegId: string,
  label: string,
  poolIndex: number | null,
  wins: number,
  losses: number,
  pf: number,
  pa: number,
): Standing => ({
  team: team(captainRegId, label, poolIndex),
  wins,
  losses,
  pf,
  pa,
  diff: pf - pa,
});

describe("standingsToRows", () => {
  it("numbers places within each pool, not across pools", () => {
    const standings: Standing[] = [
      standing("a", "Team A", 1, 2, 0, 22, 10),
      standing("b", "Team B", 1, 0, 2, 10, 22),
      standing("c", "Team C", 2, 2, 0, 22, 8),
    ];
    const rows = standingsToRows(standings, []);
    expect(rows.map((r) => [r.pool, r.place, r.team])).toEqual([
      [1, 1, "Team A"],
      [1, 2, "Team B"],
      [2, 1, "Team C"],
    ]);
  });

  it("attaches medal labels by captainRegId", () => {
    const standings: Standing[] = [standing("a", "Team A", null, 3, 0, 33, 10)];
    const medals: Medal[] = [
      { team: { label: "Team A", captainRegId: "a" }, place: "gold" },
    ];
    const rows = standingsToRows(standings, medals);
    expect(rows[0].medal).toBe("Gold");
  });

  it("leaves medal null for teams with no podium finish", () => {
    const standings: Standing[] = [standing("a", "Team A", null, 1, 1, 20, 20)];
    expect(standingsToRows(standings, [])[0].medal).toBeNull();
  });
});

describe("resultsToCsv", () => {
  it("renders pool as a letter and includes a header row", () => {
    const rows = standingsToRows(
      [standing("a", "Team A", 1, 2, 0, 22, 10)],
      [],
    );
    const csv = resultsToCsv(rows);
    const lines = csv.split("\r\n");
    expect(lines[0]).toContain("Pool");
    expect(lines[1]).toContain('"A"');
    expect(lines[1]).toContain('"Team A"');
  });
});

describe("resultsFilename", () => {
  it("slugifies tournament + event names and appends the date", () => {
    expect(
      resultsFilename("Summer Slam", "Mixed 3.5+", new Date("2026-09-14T00:00:00Z")),
    ).toBe("results-summer-slam-mixed-3-5-2026-09-14.csv");
  });
});
