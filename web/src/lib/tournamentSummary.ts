import type { Database } from "../types/supabase";
import {
  buildTeams,
  computeMedals,
  computeStandings,
  teamByAnyRegId,
  type EventRegistration,
  type Match,
  type Player,
} from "./bracketTeams";

// End-of-tournament summary: the numbers and "who won" that the organizer
// sends the client after the event (issue: tournament summary report).
// Pure — takes the rows the page already fetches and returns a fully
// shaped report so the rendering (and the tests) stay simple.
//
// Honesty notes baked into the shape:
//   * Matches carry no started_at / completed_at. A completed match's
//     updated_at is the moment its score was recorded (the only later
//     write is a score reset, which flips it back to pending), so
//     "finished at" is real. There is no per-match duration — the play
//     window is first score → last score.
//   * Only spot-holding registrations become teams (mirrors the console).
//   * Scores are one pair per match (no per-game log), so "points" means
//     the recorded final score of each match.

type EventRow = Database["public"]["Tables"]["events"]["Row"];

export type SummaryEvent = Pick<
  EventRow,
  | "id"
  | "name"
  | "format"
  | "gender"
  | "bracket_type"
  | "status"
  | "pool_count"
  | "teams_advancing_to_playoff"
  | "playoff_rounds"
  | "min_rating"
  | "max_rating"
  | "min_age"
  | "max_age"
  | "scheduled_start_at"
> & {
  // schedule_order landed in migration 20260911170000; the generated types
  // predate it (same optional treatment as SchedulePage).
  schedule_order?: number | null;
};

export type Podium = {
  place: "gold" | "silver" | "bronze";
  team: string;
};

export type EventResult = {
  id: string;
  name: string;
  formatLine: string;
  teamCount: number;
  playerCount: number;
  matchesPlayed: number;
  matchesTotal: number;
  pointsScored: number;
  podium: Podium[];
  // How the podium was decided: medal matches, round-robin record
  // (no playoff configured), or nothing recorded yet.
  podiumSource: "medal_matches" | "round_robin" | "none";
  // Undefeated in pool play (at least one win, no losses).
  perfectRecords: string[];
  complete: boolean;
};

export type Highlight = {
  key: string;
  label: string;
  value: string;
  detail?: string;
};

export type DaySummary = {
  // YYYY-MM-DD in the formatting time zone.
  date: string;
  matches: number;
  points: number;
  firstFinish: Date;
  lastFinish: Date;
  // Minutes between the first and last recorded score that day.
  spanMinutes: number;
};

export type TournamentSummary = {
  headline: {
    players: number;
    teams: number;
    events: number;
    eventsDecided: number;
    matchesPlayed: number;
    matchesTotal: number;
    pointsScored: number;
    courtsUsed: number;
    days: number;
    // Sum of each day's first-score → last-score span.
    playMinutes: number;
    medalsAwarded: number;
    multiEventPlayers: number;
  };
  events: EventResult[];
  highlights: Highlight[];
  days: DaySummary[];
  // The moment the last score of the tournament was recorded.
  lastResultAt: Date | null;
};

// What the report masthead needs about the tournament itself.
export type ReportHeader = {
  tournamentName: string;
  orgName: string;
  startsAt: string;
  endsAt: string;
  venueName: string | null;
  venueAddress: string | null;
};

export type SummaryInput = {
  events: SummaryEvent[];
  regs: EventRegistration[];
  players: Player[];
  matches: Match[];
  // Time zone used to bucket finishes into days; defaults to the browser's.
  timeZone?: string;
};

const GENDER_LABEL: Record<SummaryEvent["gender"], string> = {
  men: "Men's",
  women: "Women's",
  mixed: "Mixed",
  open: "Open",
};

const BRACKET_LABEL: Record<SummaryEvent["bracket_type"], string> = {
  round_robin: "round robin",
  single_elim: "single elimination",
  double_elim: "double elimination",
  pool_then_bracket: "pools + bracket",
};

function fmtRating(n: number): string {
  const s = n.toString();
  return s.includes(".") ? s : `${s}.0`;
}

// "Mixed doubles · 3.5–4.0 · 50+ · 2 pools + bracket"
export function eventFormatLine(e: SummaryEvent): string {
  const parts: string[] = [`${GENDER_LABEL[e.gender]} ${e.format}`];
  if (e.min_rating != null && e.max_rating != null) {
    parts.push(`${fmtRating(e.min_rating)}–${fmtRating(e.max_rating)}`);
  } else if (e.min_rating != null) {
    parts.push(`${fmtRating(e.min_rating)}+`);
  } else if (e.max_rating != null) {
    parts.push(`up to ${fmtRating(e.max_rating)}`);
  }
  if (e.min_age != null && e.max_age != null) {
    parts.push(`ages ${e.min_age}–${e.max_age}`);
  } else if (e.min_age != null) {
    parts.push(`${e.min_age}+`);
  } else if (e.max_age != null) {
    parts.push(`under ${e.max_age + 1}`);
  }
  const bracket =
    e.bracket_type === "pool_then_bracket" && e.pool_count > 1
      ? `${e.pool_count} pools + bracket`
      : BRACKET_LABEL[e.bracket_type];
  parts.push(bracket);
  return parts.join(" · ");
}

function isScored(m: Match): m is Match & {
  team_a_score: number;
  team_b_score: number;
  team_a_reg_id: string;
  team_b_reg_id: string;
} {
  return (
    m.status === "completed" &&
    m.team_a_score != null &&
    m.team_b_score != null &&
    m.team_a_reg_id != null &&
    m.team_b_reg_id != null
  );
}

// YYYY-MM-DD for `d` in `timeZone` (en-CA gives ISO-ordered parts).
function dayKey(d: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function joinNames(names: string[], max = 3): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

export function buildTournamentSummary(input: SummaryInput): TournamentSummary {
  const { events, regs, players, matches, timeZone } = input;

  const regsByEvent = new Map<string, EventRegistration[]>();
  for (const r of regs) {
    const arr = regsByEvent.get(r.event_id) ?? [];
    arr.push(r);
    regsByEvent.set(r.event_id, arr);
  }
  const matchesByEvent = new Map<string, Match[]>();
  for (const m of matches) {
    const arr = matchesByEvent.get(m.event_id) ?? [];
    arr.push(m);
    matchesByEvent.set(m.event_id, arr);
  }

  const sortedEvents = [...events].sort(
    (a, b) =>
      (a.schedule_order ?? Number.MAX_SAFE_INTEGER) -
        (b.schedule_order ?? Number.MAX_SAFE_INTEGER) ||
      (a.scheduled_start_at ?? "").localeCompare(b.scheduled_start_at ?? "") ||
      a.name.localeCompare(b.name),
  );

  const allPlayers = new Set<string>();
  const eventsPerPlayer = new Map<string, number>();
  const matchesPerPlayer = new Map<string, number>();
  const playerName = new Map(
    players.map((p) => [p.id, `${p.first_name} ${p.last_name}`.trim()]),
  );

  let totalTeams = 0;
  let matchesPlayed = 0;
  let matchesTotal = 0;
  let pointsScored = 0;
  let medalsAwarded = 0;
  const courts = new Set<string>();
  const finishes: { at: Date; points: number }[] = [];

  // Fun-fact accumulators.
  let highestScoring: { total: number; line: string; event: string } | null = null;
  let biggestWin: { margin: number; line: string; event: string } | null = null;
  let closest: { margin: number; total: number; line: string; event: string } | null = null;
  let nailBiters = 0; // decided by 2 or fewer
  let shutouts = 0;
  let dominant: { diff: number; team: string; event: string; wins: number; losses: number } | null = null;
  const courtCounts = new Map<string, number>();

  const eventResults: EventResult[] = sortedEvents.map((e) => {
    const evRegs = regsByEvent.get(e.id) ?? [];
    const teams = buildTeams(evRegs, players);
    const byReg = teamByAnyRegId(teams);
    const evMatches = matchesByEvent.get(e.id) ?? [];
    const rr = evMatches.filter((m) => m.stage === "round_robin");
    const playoff = evMatches.filter((m) => m.stage === "playoff");

    const teamLabel = (regId: string | null): string =>
      (regId && byReg.get(regId)?.label) || "Unknown team";

    for (const r of evRegs) {
      allPlayers.add(r.player_id);
      eventsPerPlayer.set(r.player_id, (eventsPerPlayer.get(r.player_id) ?? 0) + 1);
    }
    totalTeams += teams.length;
    matchesTotal += evMatches.length;

    let evPoints = 0;
    let evPlayed = 0;
    for (const m of evMatches) {
      if (!isScored(m)) continue;
      evPlayed++;
      const total = m.team_a_score + m.team_b_score;
      evPoints += total;
      if (m.court) {
        courts.add(m.court);
        courtCounts.set(m.court, (courtCounts.get(m.court) ?? 0) + 1);
      }
      finishes.push({ at: new Date(m.updated_at), points: total });

      const hi = Math.max(m.team_a_score, m.team_b_score);
      const lo = Math.min(m.team_a_score, m.team_b_score);
      const margin = hi - lo;
      const winnerLabel =
        m.team_a_score >= m.team_b_score
          ? teamLabel(m.team_a_reg_id)
          : teamLabel(m.team_b_reg_id);
      const loserLabel =
        m.team_a_score >= m.team_b_score
          ? teamLabel(m.team_b_reg_id)
          : teamLabel(m.team_a_reg_id);
      const line = `${winnerLabel} def. ${loserLabel} ${hi}–${lo}`;

      if (!highestScoring || total > highestScoring.total) {
        highestScoring = { total, line, event: e.name };
      }
      if (!biggestWin || margin > biggestWin.margin) {
        biggestWin = { margin, line, event: e.name };
      }
      if (
        !closest ||
        margin < closest.margin ||
        (margin === closest.margin && total > closest.total)
      ) {
        closest = { margin, total, line, event: e.name };
      }
      if (margin <= 2) nailBiters++;
      if (lo === 0) shutouts++;

      for (const regId of [m.team_a_reg_id, m.team_b_reg_id]) {
        const t = byReg.get(regId);
        if (!t) continue;
        for (const p of [t.captain, t.partner]) {
          if (!p) continue;
          matchesPerPlayer.set(p.id, (matchesPerPlayer.get(p.id) ?? 0) + 1);
        }
      }
    }
    matchesPlayed += evPlayed;
    pointsScored += evPoints;

    const standings = computeStandings(teams, rr);
    const perfectRecords = standings
      .filter((s) => s.wins > 0 && s.losses === 0)
      .map((s) => s.team.label);
    for (const s of standings) {
      if (s.wins + s.losses === 0) continue;
      if (!dominant || s.diff > dominant.diff) {
        dominant = { diff: s.diff, team: s.team.label, event: e.name, wins: s.wins, losses: s.losses };
      }
    }

    let podium: Podium[] = [];
    let podiumSource: EventResult["podiumSource"] = "none";
    const medals = computeMedals(e, playoff, byReg);
    if (medals.length > 0) {
      podium = medals.map((m) => ({ place: m.place, team: m.team.label }));
      podiumSource = "medal_matches";
    } else if (
      e.teams_advancing_to_playoff <= 0 &&
      rr.length > 0 &&
      rr.every((m) => m.status === "completed")
    ) {
      // Round-robin only: the standings are the result.
      const places: Podium["place"][] = ["gold", "silver", "bronze"];
      podium = standings
        .slice(0, 3)
        .map((s, i) => ({ place: places[i], team: s.team.label }));
      podiumSource = "round_robin";
    }
    medalsAwarded += podium.length;

    const complete =
      e.status === "complete" ||
      e.status === "verified" ||
      (evMatches.length > 0 && evMatches.every((m) => m.status === "completed"));

    return {
      id: e.id,
      name: e.name,
      formatLine: eventFormatLine(e),
      teamCount: teams.length,
      playerCount: new Set(evRegs.map((r) => r.player_id)).size,
      matchesPlayed: evPlayed,
      matchesTotal: evMatches.length,
      pointsScored: evPoints,
      podium,
      podiumSource,
      perfectRecords,
      complete,
    };
  });

  // Days of play from recorded finishes.
  const byDay = new Map<string, DaySummary>();
  for (const f of finishes) {
    if (Number.isNaN(f.at.getTime())) continue;
    const key = dayKey(f.at, timeZone);
    const d = byDay.get(key);
    if (!d) {
      byDay.set(key, {
        date: key,
        matches: 1,
        points: f.points,
        firstFinish: f.at,
        lastFinish: f.at,
        spanMinutes: 0,
      });
    } else {
      d.matches++;
      d.points += f.points;
      if (f.at < d.firstFinish) d.firstFinish = f.at;
      if (f.at > d.lastFinish) d.lastFinish = f.at;
    }
  }
  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of days) {
    d.spanMinutes = Math.round((d.lastFinish.getTime() - d.firstFinish.getTime()) / 60000);
  }
  const playMinutes = days.reduce((sum, d) => sum + d.spanMinutes, 0);
  const lastResultAt = days.length ? days[days.length - 1].lastFinish : null;

  const multiEventPlayers = [...eventsPerPlayer.values()].filter((n) => n > 1).length;

  // ── Highlights ─────────────────────────────────────────────────────
  const highlights: Highlight[] = [];
  if (matchesPlayed > 0) {
    highlights.push({
      key: "avg-points",
      label: "Average points per match",
      value: (pointsScored / matchesPlayed).toFixed(1),
      detail: `${pointsScored.toLocaleString()} points across ${plural(matchesPlayed, "match", "matches")}`,
    });
  }
  if (highestScoring) {
    const h: { total: number; line: string; event: string } = highestScoring;
    highlights.push({
      key: "highest-scoring",
      label: "Highest-scoring match",
      value: `${h.total} points`,
      detail: `${h.line} · ${h.event}`,
    });
  }
  if (closest) {
    const c: { margin: number; total: number; line: string; event: string } = closest;
    highlights.push({
      key: "closest",
      label: "Closest finish",
      value: `Decided by ${plural(c.margin, "point")}`,
      detail: `${c.line} · ${c.event}`,
    });
  }
  if (nailBiters > 0) {
    highlights.push({
      key: "nail-biters",
      label: "Nail-biters",
      value: plural(nailBiters, "match", "matches"),
      detail: `${Math.round((nailBiters / matchesPlayed) * 100)}% of matches were decided by 2 points or fewer`,
    });
  }
  if (biggestWin) {
    const b: { margin: number; line: string; event: string } = biggestWin;
    highlights.push({
      key: "biggest-win",
      label: "Most lopsided match",
      value: `Won by ${plural(b.margin, "point")}`,
      detail: `${b.line} · ${b.event}`,
    });
  }
  if (shutouts > 0) {
    highlights.push({
      key: "shutouts",
      label: "Shutouts",
      value: plural(shutouts, "match", "matches"),
      detail: "The losing side never got on the board",
    });
  }
  if (dominant) {
    const d: { diff: number; team: string; event: string; wins: number; losses: number } = dominant;
    highlights.push({
      key: "dominant",
      label: "Most dominant pool run",
      value: d.team,
      detail: `${d.wins}–${d.losses} in pool play, +${d.diff} point differential · ${d.event}`,
    });
  }
  const perfect = eventResults.flatMap((r) =>
    r.perfectRecords.map((t) => `${t} (${r.name})`),
  );
  if (perfect.length > 0) {
    highlights.push({
      key: "perfect",
      label: "Undefeated in pool play",
      value: plural(perfect.length, "team"),
      detail: joinNames(perfect),
    });
  }
  if (matchesPerPlayer.size > 0) {
    const max = Math.max(...matchesPerPlayer.values());
    const iron = [...matchesPerPlayer.entries()]
      .filter(([, n]) => n === max)
      .map(([id]) => playerName.get(id) ?? "Unknown player");
    highlights.push({
      key: "iron",
      label: "Most matches played",
      value: plural(max, "match", "matches"),
      detail: joinNames(iron),
    });
  }
  if (multiEventPlayers > 0) {
    highlights.push({
      key: "multi-event",
      label: "Played more than one event",
      value: plural(multiEventPlayers, "player"),
      detail: `${Math.round((multiEventPlayers / allPlayers.size) * 100)}% of the field came back for a second bracket`,
    });
  }
  if (courtCounts.size > 0) {
    const max = Math.max(...courtCounts.values());
    const busiest = [...courtCounts.entries()]
      .filter(([, n]) => n === max)
      .map(([c]) => c);
    highlights.push({
      key: "busiest-court",
      label: "Busiest court",
      value: busiest.join(", "),
      detail: `${plural(max, "match", "matches")} finished there`,
    });
  }
  if (days.length > 1) {
    const longest = days.reduce((a, b) => (b.spanMinutes > a.spanMinutes ? b : a));
    highlights.push({
      key: "longest-day",
      label: "Longest day",
      value: fmtMinutes(longest.spanMinutes),
      detail: `${fmtDay(longest.date)} — ${plural(longest.matches, "match", "matches")}, first score to last`,
    });
  }

  return {
    headline: {
      players: allPlayers.size,
      teams: totalTeams,
      events: events.length,
      eventsDecided: eventResults.filter((r) => r.podium.length > 0).length,
      matchesPlayed,
      matchesTotal,
      pointsScored,
      courtsUsed: courts.size,
      days: days.length,
      playMinutes,
      medalsAwarded,
      multiEventPlayers,
    },
    events: eventResults,
    highlights,
    days,
    lastResultAt,
  };
}

export function fmtMinutes(mins: number): string {
  if (mins < 1) return "0 min";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

// "Sat, Jun 6" from a YYYY-MM-DD day key (parsed as a local calendar
// date, not UTC midnight, so it never shifts a day).
export function fmtDay(key: string): string {
  const [y, mo, d] = key.split("-").map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function fmtDateRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const full: Intl.DateTimeFormatOptions = { weekday: "short", month: "long", day: "numeric", year: "numeric" };
  if (s.toDateString() === e.toDateString()) return s.toLocaleDateString(undefined, full);
  const sameMonth = s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth();
  if (sameMonth) {
    // "June 6–7, 2026"
    return `${s.toLocaleDateString(undefined, { month: "long", day: "numeric" })}–${e.getDate()}, ${e.getFullYear()}`;
  }
  return `${s.toLocaleDateString(undefined, { month: "long", day: "numeric" })} – ${e.toLocaleDateString(undefined, full)}`;
}

// Plain-text twin of the report for pasting straight into an email.
export function summaryAsText(header: ReportHeader, s: TournamentSummary, note: string): string {
  const h = s.headline;
  const lines: string[] = [];
  lines.push(`${header.tournamentName} — Tournament summary`);
  lines.push(fmtDateRange(header.startsAt, header.endsAt) + (header.venueName ? ` · ${header.venueName}` : ""));
  lines.push("");
  if (note.trim()) {
    lines.push(note.trim());
    lines.push("");
  }
  lines.push("BY THE NUMBERS");
  lines.push(`• ${h.players} players · ${h.teams} teams · ${h.events} brackets`);
  lines.push(
    `• ${h.matchesPlayed} matches played` + (h.matchesPlayed < h.matchesTotal ? ` (of ${h.matchesTotal} scheduled)` : ""),
  );
  lines.push(`• ${h.pointsScored.toLocaleString()} points scored · ${h.medalsAwarded} medals awarded`);
  if (h.days > 0) {
    lines.push(`• ${h.days} ${h.days === 1 ? "day" : "days"} of play, ${fmtMinutes(h.playMinutes)} first score to last`);
  }
  if (h.courtsUsed > 0) lines.push(`• ${h.courtsUsed} courts used`);
  lines.push("");
  lines.push("BRACKETS & WINNERS");
  for (const e of s.events) {
    lines.push(`${e.name} (${e.formatLine}) — ${e.teamCount} teams`);
    if (e.podium.length === 0) {
      lines.push("  Results not final");
    } else {
      for (const p of e.podium) {
        const label = p.place.charAt(0).toUpperCase() + p.place.slice(1);
        lines.push(`  ${label}: ${p.team}`);
      }
    }
  }
  if (s.highlights.length > 0) {
    lines.push("");
    lines.push("HIGHLIGHTS");
    for (const hl of s.highlights) {
      lines.push(`• ${hl.label}: ${hl.value}` + (hl.detail ? ` — ${hl.detail}` : ""));
    }
  }
  lines.push("");
  lines.push(`Prepared by ${header.orgName} · Bert & Erne`);
  return lines.join("\n");
}
