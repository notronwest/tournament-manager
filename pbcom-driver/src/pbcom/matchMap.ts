/**
 * PURE mapping helpers for the PB.com push. No Playwright, no I/O — every function
 * here is unit-testable against synthetic fixtures.
 *
 * WHY last names (the crux, D-0045 flow C): a PB.com round-robin match row is
 * identified on screen by the two teams' player LAST NAMES — PB.com does not expose
 * a per-entry id on the row. And #987 established that `source_activity_id` is the
 * DIVISION id (shared by every registrant), so it cannot key a team or a match.
 * `source_team_id` groups doubles partners and `source_attendee_header_id` is
 * genuinely per-attendee, but neither is printed on a PB.com match row. So the driver
 * locates a B&E match on PB.com by the normalized, unordered SET of last names per
 * team — matching by TEAMS, never by round/position (B&E and PB.com number rounds
 * differently).
 */

// ── name normalization ──────────────────────────────────────────────────────────

/** Normalize a single last name for order-independent comparison. */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics (José → jose)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ""); // drop spaces/punctuation (O'Brien, Van Dyke, St. Clair)
}

/** A team's last-name set: normalized, de-duplicated, sorted (stable + order-free). */
export function lastNameSet(names: readonly string[]): string[] {
  return Array.from(new Set(names.map(normalizeName).filter(Boolean))).sort();
}

/**
 * A team's FIRST-name set — same normalization as last names. Used ONLY as a
 * tiebreaker when two PB.com rows share a last-name-set key (e.g. two different
 * "Smith / Jones" pairs in one division); never as the primary match key.
 */
export function firstNameSet(names: readonly string[]): string[] {
  return Array.from(new Set(names.map(normalizeName).filter(Boolean))).sort();
}

/** A canonical string key for a team's last-name set (for equality / Map keys). */
export function lastNameSetKey(names: readonly string[]): string {
  return lastNameSet(names).join("+");
}

/** A canonical, orientation-free key for a whole match (both teams). */
export function matchTeamsKey(teamA: readonly string[], teamB: readonly string[]): string {
  return [lastNameSetKey(teamA), lastNameSetKey(teamB)].sort().join(" vs ");
}

// ── relaxed name matching (PB.com truncates some last names) ───────────────────────
//
// PB.com's PUBLIC results API truncates or varies some last names: "Wysolmerski" → "W",
// "Smith" → "S", "DeRisi" → "Risi", "TalpinPhotography" → "Photography". B&E has the
// full, correct names. So when an EXACT last-name-set match fails, we allow a relaxed
// match where one name is a prefix OR suffix of the other — but SAFELY: a doubles team
// must still have at least ONE name match EXACTLY (the partner anchors it), and the
// caller must require the match be UNIQUE among candidates (fail-closed on ambiguity).
// A single (singles) name is matched EXACTLY only — a lone truncated initial is too
// weak to resolve.

type NameMatch = "exact" | "loose" | false;

/** How two normalized names relate: exact, a loose prefix/suffix, or no match. */
export function relaxedNameMatch(a: string, b: string): NameMatch {
  if (a === b) return "exact";
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!short) return false;
  return long.startsWith(short) || long.endsWith(short) ? "loose" : false;
}

/**
 * True when two last-name SETS match under the relaxed rule: same size, a full pairing
 * exists, and (for doubles) at least one pairing is exact. Singles require exact.
 * Inputs are normalized sets (use lastNameSet); order-independent (tries both pairings).
 */
export function relaxedSetMatch(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return false;
  if (a.length === 1) return a[0] === b[0];
  if (a.length === 2) {
    const [a0, a1] = a as [string, string];
    const [b0, b1] = b as [string, string];
    const pairOk = (x: string, y: string, p: string, q: string): boolean => {
      const r0 = relaxedNameMatch(x, p);
      const r1 = relaxedNameMatch(y, q);
      return !!r0 && !!r1 && (r0 === "exact" || r1 === "exact");
    };
    return pairOk(a0, a1, b0, b1) || pairOk(a0, a1, b1, b0);
  }
  // 3+ members (not expected for pickleball teams): require exact set equality.
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** One match's teams as last-name sets, for collision detection. */
export interface MatchSurnames {
  matchId: string;
  teamALastNames: readonly string[];
  teamBLastNames: readonly string[];
}

/**
 * Find matches whose last-name-set pair is NOT unique within the set — the exact
 * situation that makes `findMatchRow` return `ambiguous` (two matches PB.com can't
 * tell apart by surnames alone, e.g. two "Smith / Jones vs Brown / Davis" games).
 * Returns one group per colliding key with the match ids involved. First names (the
 * findMatchRow tiebreak) can still resolve these at push time — the preflight warns
 * so a human knows which games to watch.
 */
export function surnameCollisions(
  matches: readonly MatchSurnames[],
): { key: string; matchIds: string[] }[] {
  const byKey = new Map<string, string[]>();
  for (const m of matches) {
    // Skip a match that isn't a real two-team game (a bye / unseeded slot).
    if (lastNameSet(m.teamALastNames).length === 0 || lastNameSet(m.teamBLastNames).length === 0) continue;
    const key = matchTeamsKey(m.teamALastNames, m.teamBLastNames);
    const arr = byKey.get(key);
    if (arr) arr.push(m.matchId);
    else byKey.set(key, [m.matchId]);
  }
  return [...byKey.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, matchIds]) => ({ key, matchIds }));
}

// ── the PB.com match row model ────────────────────────────────────────────────────

/**
 * One parsed PB.com round-robin match row. The driver reads the DOM into these, then
 * calls `findMatchRow` — the DOM parsing is thin; the matching decision is pure here.
 */
export interface PbMatchRow {
  /** Opaque handle the driver uses to act on this row (a selector, index, or ref). */
  ref: string;
  /** Last names PB.com shows for the FIRST team on the row (its "top" side). */
  teamOneLastNames: string[];
  /** Last names PB.com shows for the SECOND team on the row (its "bottom" side). */
  teamTwoLastNames: string[];
  /** First names for the first/second team, when the DOM gave them — tiebreak only. */
  teamOneFirstNames?: string[];
  teamTwoFirstNames?: string[];
  /** True when the row already shows a saved score (idempotency: skip it). */
  hasScore?: boolean;
}

/** A successful mapping of a B&E match onto a PB.com row, with the side orientation. */
export interface RowMatch {
  row: PbMatchRow;
  /**
   * How B&E's A/B sides line up with PB.com's team-one/team-two on that row, so the
   * driver enters each team's score into the correct box. True → B&E team A is PB.com
   * team-one; false → B&E team A is PB.com team-two.
   */
  aIsTeamOne: boolean;
}

export type FindRowResult =
  | { ok: true; match: RowMatch }
  | { ok: false; reason: "not_found" | "ambiguous"; candidates: number };

/** First names for a B&E match's two teams, to break a last-name-set tie. */
export interface FirstNameHint {
  teamAFirstNames?: readonly string[];
  teamBFirstNames?: readonly string[];
}

/**
 * Locate the PB.com row for a B&E match by the two teams' last-name sets.
 * Returns the row plus the A/B ↔ team-one/team-two orientation. Fails (never guesses)
 * when zero rows match or more than one does — the caller escalates to needs_attention.
 *
 * When more than one row matches on last names (e.g. two "Smith / Jones" pairs in one
 * division) AND first names are supplied on both the B&E side (`hint`) and the PB.com
 * rows, the tie is broken by FIRST names, respecting each hit's A/B orientation. The
 * tiebreak only ever NARROWS: it resolves to a single row or leaves it ambiguous — it
 * never promotes a non-last-name match, so a wrong score is still impossible.
 */
export function findMatchRow(
  teamALastNames: readonly string[],
  teamBLastNames: readonly string[],
  rows: readonly PbMatchRow[],
  hint?: FirstNameHint,
): FindRowResult {
  const a = lastNameSetKey(teamALastNames);
  const b = lastNameSetKey(teamBLastNames);
  const wantPair = [a, b].sort().join(" vs ");

  const hits: RowMatch[] = [];
  for (const row of rows) {
    const one = lastNameSetKey(row.teamOneLastNames);
    const two = lastNameSetKey(row.teamTwoLastNames);
    if ([one, two].sort().join(" vs ") !== wantPair) continue;
    // Orientation: A maps to team-one iff A's key equals team-one's key. When both
    // teams share a key (degenerate — same last names on both sides) default A→one.
    hits.push({ row, aIsTeamOne: a === one });
  }

  if (hits.length === 1) return { ok: true, match: hits[0]! };
  if (hits.length === 0) return { ok: false, reason: "not_found", candidates: 0 };

  // Ambiguous on last names → try the FIRST-name tiebreak, if we have first names
  // on the B&E side and on every candidate row. A candidate survives only when BOTH
  // teams' first-name sets match in that row's orientation.
  const aFirst = firstNameSet(hint?.teamAFirstNames ?? []);
  const bFirst = firstNameSet(hint?.teamBFirstNames ?? []);
  const haveHint = aFirst.length > 0 || bFirst.length > 0;
  const rowsHaveFirst = hits.every(
    (h) => (h.row.teamOneFirstNames?.length ?? 0) > 0 || (h.row.teamTwoFirstNames?.length ?? 0) > 0,
  );
  if (haveHint && rowsHaveFirst) {
    const key = (ns?: readonly string[]) => firstNameSet(ns ?? []).join("+");
    const refined = hits.filter((h) => {
      const oneFirst = key(h.row.teamOneFirstNames);
      const twoFirst = key(h.row.teamTwoFirstNames);
      // In this hit's orientation, A is team-one iff aIsTeamOne.
      const wantOne = h.aIsTeamOne ? aFirst.join("+") : bFirst.join("+");
      const wantTwo = h.aIsTeamOne ? bFirst.join("+") : aFirst.join("+");
      return oneFirst === wantOne && twoFirst === wantTwo;
    });
    if (refined.length === 1) return { ok: true, match: refined[0]! };
  }

  return { ok: false, reason: "ambiguous", candidates: hits.length };
}

// ── seed ordering → Move Up/Down steps (flow A, step s4) ──────────────────────────

/**
 * PB.com's "Verify Seeding" page has no way to type a seed number: you click a team's
 * "Sort Item" button, then "Move Item Up"/"Move Item Down" to walk it one slot at a
 * time. This computes the minimal sequence of single-slot moves that turns the current
 * on-screen order into B&E's desired seeded order.
 *
 * `current` and `desired` are arrays of the SAME team keys (use `lastNameSetKey`) in
 * list order. Returns one move per click the driver must perform, in order.
 */
export interface SeedMove {
  /** The team key (lastNameSetKey) to select via "Sort Item". */
  teamKey: string;
  direction: "up" | "down";
}

export class SeedOrderError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SeedOrderError";
  }
}

export function computeSeedMoves(
  current: readonly string[],
  desired: readonly string[],
): SeedMove[] {
  if (current.length !== desired.length) {
    throw new SeedOrderError(
      `seed order length mismatch: current=${current.length} desired=${desired.length}`,
    );
  }
  const currentSorted = [...current].sort();
  const desiredSorted = [...desired].sort();
  for (let i = 0; i < currentSorted.length; i++) {
    if (currentSorted[i] !== desiredSorted[i]) {
      throw new SeedOrderError("seed order teams differ between current and desired");
    }
  }

  // Insertion-style: for each target slot top-down, bubble the wanted team up into
  // place with adjacent "up" moves. Only "up" is needed for a correct sequence
  // (the DOM also offers "down"; up-only keeps it deterministic and testable).
  const work = [...current];
  const moves: SeedMove[] = [];
  for (let i = 0; i < desired.length; i++) {
    const want = desired[i]!;
    let j = i;
    while (j < work.length && work[j] !== want) j++;
    if (j === work.length) {
      throw new SeedOrderError(`desired team ${want} not found in remaining order`);
    }
    while (j > i) {
      [work[j - 1], work[j]] = [work[j]!, work[j - 1]!];
      moves.push({ teamKey: want, direction: "up" });
      j--;
    }
  }
  return moves;
}
