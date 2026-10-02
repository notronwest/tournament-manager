/**
 * Pure structural comparison between B&E's authoritative draw and PB.com's bracket.
 *
 * B&E is authoritative for pool assignment and round-robin matchups. This module
 * reduces both sides to order-free, name-based keys so the two can be compared
 * without any Playwright / I/O. The driver uses this to decide whether PB.com's
 * bracket MATCHES B&E's pools (D-0045); this phase only reads/compares — no
 * PB.com pool-assignment clicks are emitted until the s2/s5 DOM dumps come back.
 *
 * Team identity here is the team's normalized last-name set (`lastNameSetKey`) —
 * the same key PB.com row matching is done on (a PB.com row shows last names,
 * not ids). See pbcom/matchMap.ts.
 */
import type { BandeMatch, BandeTeam } from "../types.js";
import { lastNameSetKey } from "../pbcom/matchMap.js";

/**
 * The `lastNameSetKey` of the team whose `registrationIds` includes `regId`, else
 * null (null regId, or no team owns it).
 */
export function teamKeyForReg(regId: string | null, teams: BandeTeam[]): string | null {
  if (regId == null) return null;
  const team = teams.find((t) => t.registrationIds.includes(regId));
  return team ? lastNameSetKey(team.lastNames) : null;
}

/** Canonical, order-free key for an unordered pair of team keys. */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join(" ⅋ ");
}

/**
 * poolIndex → sorted array of team keys (`lastNameSetKey`). Teams with a null
 * poolIndex are grouped under key `-1`.
 */
export function bandePools(teams: BandeTeam[]): Map<number, string[]> {
  const pools = new Map<number, string[]>();
  for (const team of teams) {
    const key = team.poolIndex ?? -1;
    const list = pools.get(key) ?? [];
    list.push(lastNameSetKey(team.lastNames));
    pools.set(key, list);
  }
  for (const list of pools.values()) list.sort();
  return pools;
}

/**
 * The set of round-robin matchups B&E expects, as order-free pair keys. Only
 * `stage === "round_robin"` matches whose BOTH sides resolve to a team key are
 * included.
 */
export function bandeRoundRobinMatchups(teams: BandeTeam[], matches: BandeMatch[]): Set<string> {
  const pairs = new Set<string>();
  for (const m of matches) {
    if (m.stage !== "round_robin") continue;
    const keyA = teamKeyForReg(m.teamARegId, teams);
    const keyB = teamKeyForReg(m.teamBRegId, teams);
    if (keyA == null || keyB == null) continue;
    pairs.add(pairKey(keyA, keyB));
  }
  return pairs;
}

export interface MatchupDiff {
  ok: boolean;
  matched: string[];
  missingOnPbcom: string[];
  extraOnPbcom: string[];
}

/**
 * Compare B&E's expected matchups against PB.com's. `matched` = in both;
 * `missingOnPbcom` = in B&E but not PB.com; `extraOnPbcom` = in PB.com but not
 * B&E; `ok` = both missing and extra are empty. All arrays sorted.
 */
export function compareMatchups(bande: Set<string>, pbcom: Set<string>): MatchupDiff {
  const matched: string[] = [];
  const missingOnPbcom: string[] = [];
  const extraOnPbcom: string[] = [];
  for (const k of bande) (pbcom.has(k) ? matched : missingOnPbcom).push(k);
  for (const k of pbcom) if (!bande.has(k)) extraOnPbcom.push(k);
  matched.sort();
  missingOnPbcom.sort();
  extraOnPbcom.sort();
  return {
    ok: missingOnPbcom.length === 0 && extraOnPbcom.length === 0,
    matched,
    missingOnPbcom,
    extraOnPbcom,
  };
}
