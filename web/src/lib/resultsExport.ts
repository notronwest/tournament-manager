import type { Medal, Standing } from "../pages/admin/EventConsolePage";

// Shapes an event's already-computed standings + medal podium into a
// printable/exportable results sheet — the "export final results" half of
// the offline field import/export (issue #736). Kept free of React so the
// row-building is testable; the download itself is a plain CSV, matching
// the roster export in lib/rosterExport.ts.

export type ResultsRow = {
  pool: number | null;
  place: number;
  team: string;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  diff: number;
  medal: string | null;
};

const MEDAL_LABEL: Record<Medal["place"], string> = {
  gold: "Gold",
  silver: "Silver",
  bronze: "Bronze",
};

function poolLetter(index: number): string {
  return String.fromCharCode("A".charCodeAt(0) + index - 1);
}

// Standings arrive already sorted within each pool (wins desc, then diff
// desc — see computeStandings in EventConsolePage). Group by pool and
// number each pool's rows 1..N so "place" matches what's on screen.
export function standingsToRows(
  standings: Standing[],
  medals: Medal[],
): ResultsRow[] {
  const medalByTeam = new Map(
    medals.map((m) => [m.team.captainRegId, MEDAL_LABEL[m.place]]),
  );

  const byPool = new Map<number | null, Standing[]>();
  for (const s of standings) {
    const key = s.team.poolIndex;
    const arr = byPool.get(key) ?? [];
    arr.push(s);
    byPool.set(key, arr);
  }
  const poolKeys = [...byPool.keys()].sort((a, b) => {
    if (a == null) return 1;
    if (b == null) return -1;
    return a - b;
  });

  const rows: ResultsRow[] = [];
  for (const pool of poolKeys) {
    (byPool.get(pool) ?? []).forEach((s, i) => {
      rows.push({
        pool,
        place: i + 1,
        team: s.team.label,
        wins: s.wins,
        losses: s.losses,
        pointsFor: s.pf,
        pointsAgainst: s.pa,
        diff: s.diff,
        medal: medalByTeam.get(s.team.captainRegId) ?? null,
      });
    });
  }
  return rows;
}

const CSV_HEADERS = [
  "Pool",
  "Place",
  "Team",
  "Wins",
  "Losses",
  "Points for",
  "Points against",
  "Diff",
  "Medal",
];

function csvCell(value: string): string {
  const s = String(value ?? "");
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function resultsToCsv(rows: ResultsRow[]): string {
  const lines = [CSV_HEADERS.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.pool != null ? poolLetter(r.pool) : "",
        String(r.place),
        r.team,
        String(r.wins),
        String(r.losses),
        String(r.pointsFor),
        String(r.pointsAgainst),
        String(r.diff),
        r.medal ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

export function resultsFilename(
  tournamentName: string,
  eventName: string,
  today: Date,
): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "event";
  const date = today.toISOString().slice(0, 10);
  return `results-${slug(tournamentName)}-${slug(eventName)}-${date}.csv`;
}
