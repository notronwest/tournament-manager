/**
 * REVERSE direction (PB.com → B&E): read match scores from PickleballBrackets.com's
 * PUBLIC results API. No login, no browser — plain HTTPS GETs against
 * pickleballtournaments.com (the public portal; the director backend is a different
 * host). This is the robustness win over the forward push: the OTP-session problem
 * does not exist on the read path.
 *
 * Verified contract (2026-10-03, live against the Leaf Peeper tournament):
 *   • divisions: GET /tournaments/api/getTournamentEventsShort
 *                  ?tournamentId=<eid>&formatId=<F>&playerGroupId=<G>&bracketLevelId=0&date=<YYYY-MM-DD>
 *                → { data: [{ uuid, title }], statusCode }
 *                (only STARTED divisions appear, on their scheduled date — exactly
 *                 the set we want. formatId 1=doubles 2=singles; playerGroupId
 *                 1=mens 2=womens 3=mixed 4=coed.)
 *   • matches:   GET /tournaments/api/getMatchInfos?eventId=<divisionUuid>&date=<YYYY-MM-DD>
 *                → { data: [match], statusCode }  (the date param is REQUIRED)
 *                each match: matchUuid, teamOne/TwoPlayerOne/TwoName (full names),
 *                matchStatus (4=completed, 1=upcoming), winner (1|2),
 *                teamOne/TwoGameOne..FiveScore, inBracketType ("RR" / bracket).
 *
 * The HTTP here is thin; the PARSE (raw row → PbPublicMatch, last-name extraction,
 * score/winner/multi-game derivation) is PURE and unit-tested in tests/results.test.ts.
 */
import { lastNameSet, normalizeName } from "./matchMap.js";

/** The public portal base (NOT pickleballbrackets.com — that's the director backend). */
export const DEFAULT_PUBLIC_BASE_URL = "https://pickleballtournaments.com";

/**
 * Headers the production fetch wrapper must send: the public API bot-blocks requests
 * without a browser-like User-Agent (a bare fetch gets 403; a browser UA gets 200 —
 * verified 2026-10-03). The CLI bakes these into its fetchFn; tests inject their own.
 */
export const PUBLIC_FETCH_HEADERS: Record<string, string> = {
  accept: "application/json",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  referer: "https://pickleballtournaments.com/",
};

/** PB.com's completed match-status code. */
export const PB_STATUS_COMPLETED = 4;

/** formatId / playerGroupId axes to enumerate for division discovery. */
export const PB_FORMAT_IDS = [1, 2] as const; // 1 = doubles, 2 = singles
export const PB_PLAYER_GROUP_IDS = [1, 2, 3, 4] as const; // mens, womens, mixed, coed

// ── the public API shapes (only the fields we read) ──────────────────────────────

interface RawEnvelope<T> {
  data: T | null;
  statusCode?: number;
}

interface RawDivision {
  uuid: string;
  title: string;
}

interface RawMatch {
  matchUuid: string;
  teamOnePlayerOneName?: string | null;
  teamOnePlayerTwoName?: string | null;
  teamTwoPlayerOneName?: string | null;
  teamTwoPlayerTwoName?: string | null;
  matchStatus?: number | null;
  winner?: number | null;
  matchCompleted?: string | null;
  inBracketType?: string | null;
  teamOneGameOneScore?: number | null;
  teamOneGameTwoScore?: number | null;
  teamOneGameThreeScore?: number | null;
  teamOneGameFourScore?: number | null;
  teamOneGameFiveScore?: number | null;
  teamTwoGameOneScore?: number | null;
  teamTwoGameTwoScore?: number | null;
  teamTwoGameThreeScore?: number | null;
  teamTwoGameFourScore?: number | null;
  teamTwoGameFiveScore?: number | null;
}

// ── our normalized shapes ─────────────────────────────────────────────────────────

/** One started PB.com division: its public uuid + title + the date it plays. */
export interface PbDivision {
  uuid: string;
  title: string;
  /** The date to pass to getMatchInfos (the division's scheduled day). */
  date: string;
}

/**
 * One parsed PB.com match from the public results API. Teams are the normalized,
 * order-free last-name sets (so matchMap.findMatchRow can locate the B&E match);
 * the score/winner are resolved for a single-game match. `multiGame` flags a
 * best-of-N result v1 cannot map onto B&E's single team_a_score/team_b_score.
 */
export interface PbPublicMatch {
  matchUuid: string;
  teamOneLastNames: string[];
  teamTwoLastNames: string[];
  /** true when PB.com reports the match finished (matchStatus 4 / matchCompleted set). */
  completed: boolean;
  /** 1 = team one won, 2 = team two won, null = undecided. */
  winner: 1 | 2 | null;
  /** Single-game points for team one / two (null when not a single decided game). */
  teamOneScore: number | null;
  teamTwoScore: number | null;
  /** true when more than one game was played (best-of-N) — v1 cannot map it to B&E. */
  multiGame: boolean;
  /** PB.com bracket type for the match: "RR" for pool play, else a bracket round. */
  inBracketType: string;
}

// ── pure parsing ──────────────────────────────────────────────────────────────────

/**
 * The last name (final whitespace token) of a PB.com "First [Middle] Last" string.
 * The public API gives one full-name string per player, not a separate last-name
 * field, so we take the final token. Hyphenated compounds ("Smith-Jones") survive as
 * one token and match; a SPACE-separated compound ("Van Dyke") keeps only "Dyke" and
 * will not match a B&E "Van Dyke" — by design that falls to the fail-closed
 * unmatched/alert path, never a wrong write. (WMPC rosters are almost all single-token
 * surnames; see DESIGN.md §reverse for the follow-up if space-compounds become common.)
 */
export function lastNameOf(fullName: string | null | undefined): string {
  if (!fullName) return "";
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  return normalizeName(parts[parts.length - 1]!);
}

/** A team's normalized last-name set from its (up to two) player names. */
export function teamLastNamesFrom(p1?: string | null, p2?: string | null): string[] {
  return lastNameSet([lastNameOf(p1), lastNameOf(p2)].filter(Boolean));
}

/** A single team's per-game scores, in order, as a nullable array. */
function gameScores(raw: RawMatch, team: "One" | "Two"): Array<number | null> {
  const g = (n: string) => (raw as unknown as Record<string, unknown>)[`team${team}Game${n}Score`];
  return ["One", "Two", "Three", "Four", "Five"].map((n) => {
    const v = g(n);
    return typeof v === "number" ? v : null;
  });
}

/** Parse ONE raw public-API match row into our normalized shape. Pure. */
export function parseMatch(raw: RawMatch): PbPublicMatch {
  const t1 = gameScores(raw, "One");
  const t2 = gameScores(raw, "Two");
  // A game was "played" when either side scored (both-0 = not played; PB pads with 0).
  const playedIdx: number[] = [];
  for (let i = 0; i < t1.length; i++) {
    const a = t1[i] ?? 0;
    const b = t2[i] ?? 0;
    if (a > 0 || b > 0) playedIdx.push(i);
  }
  const multiGame = playedIdx.length > 1;
  const first = playedIdx[0];
  const teamOneScore = first != null ? t1[first] ?? null : null;
  const teamTwoScore = first != null ? t2[first] ?? null : null;

  const winnerRaw = raw.winner;
  const winner: 1 | 2 | null = winnerRaw === 1 ? 1 : winnerRaw === 2 ? 2 : null;

  const completed = raw.matchStatus === PB_STATUS_COMPLETED || !!raw.matchCompleted;

  return {
    matchUuid: raw.matchUuid,
    teamOneLastNames: teamLastNamesFrom(raw.teamOnePlayerOneName, raw.teamOnePlayerTwoName),
    teamTwoLastNames: teamLastNamesFrom(raw.teamTwoPlayerOneName, raw.teamTwoPlayerTwoName),
    completed,
    winner,
    teamOneScore,
    teamTwoScore,
    multiGame,
    inBracketType: (raw.inBracketType ?? "").trim(),
  };
}

/** Parse the getMatchInfos `data` array. Pure. */
export function parseMatches(data: RawMatch[]): PbPublicMatch[] {
  return data.map(parseMatch);
}

/** True for a round-robin (pool) match — the v1 sync scope. */
export function isRoundRobin(m: PbPublicMatch): boolean {
  return m.inBracketType.toUpperCase() === "RR";
}

// ── thin I/O (injectable fetch) ──────────────────────────────────────────────────

/** The minimal fetch surface we use; Node 22 global fetch satisfies it, tests inject a fake. */
export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

async function getJson<T>(fetchFn: FetchLike, url: string): Promise<T | null> {
  const res = await fetchFn(url);
  if (!res.ok) return null;
  const body = (await res.json()) as RawEnvelope<T>;
  return body?.data ?? null;
}

/**
 * Discover every STARTED division of a tournament across the format/group grid for
 * the given dates. Deduped by uuid; each division carries the date it was found on
 * (the one getMatchInfos needs). Best-effort per cell — a 4xx/5xx cell is skipped,
 * never fatal.
 */
export async function discoverDivisions(
  baseUrl: string,
  eid: string,
  dates: readonly string[],
  fetchFn: FetchLike,
): Promise<PbDivision[]> {
  const found = new Map<string, PbDivision>();
  for (const f of PB_FORMAT_IDS) {
    for (const g of PB_PLAYER_GROUP_IDS) {
      for (const date of dates) {
        const url =
          `${baseUrl}/tournaments/api/getTournamentEventsShort` +
          `?tournamentId=${encodeURIComponent(eid)}&formatId=${f}` +
          `&playerGroupId=${g}&bracketLevelId=0&date=${encodeURIComponent(date)}`;
        const divs = (await getJson<RawDivision[]>(fetchFn, url)) ?? [];
        for (const d of divs) {
          if (d?.uuid && !found.has(d.uuid)) {
            found.set(d.uuid, { uuid: d.uuid, title: d.title ?? "", date });
          }
        }
      }
    }
  }
  return [...found.values()];
}

/** Fetch + parse one division's matches. Returns [] on a non-200 (best-effort tick). */
export async function fetchDivisionMatches(
  baseUrl: string,
  division: PbDivision,
  fetchFn: FetchLike,
): Promise<PbPublicMatch[]> {
  const url =
    `${baseUrl}/tournaments/api/getMatchInfos` +
    `?eventId=${encodeURIComponent(division.uuid)}&date=${encodeURIComponent(division.date)}`;
  const data = (await getJson<RawMatch[]>(fetchFn, url)) ?? [];
  return parseMatches(data);
}
