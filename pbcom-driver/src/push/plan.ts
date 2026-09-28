/**
 * The pure reconcile planner. Given a B&E draw and what has already been pushed
 * (the ledger), decide WHAT to push onto PB.com — with no browser and no DB, so
 * the whole decision is unit-testable and previewable (`--dry-run`).
 *
 * This mirrors the import direction's `pbReconcile.buildPlan` (a pure planner the
 * edge function reproduces at write time): here the planner is what the driver
 * reproduces at drive time.
 *
 * IDEMPOTENCY / RECONCILE keys — no fuzzy matching, because the import preserved
 * PB.com's own ids:
 *   • bracket identity  = the division's PB.com label (events.source_division_label).
 *   • match identity    = division label + BOTH teams' PB.com per-entry ids
 *                         (event_registrations.source_activity_id, sorted) + the
 *                         match's structural coordinates (stage/bracket/round/position).
 *   • score digest      = the score itself, so a CORRECTED score re-pushes while an
 *                         unchanged one is skipped.
 * A re-run compares desired vs ledger and emits only the delta.
 */
import type {
  BandeDraw,
  BandeEntry,
  BandeMatch,
  BandeTeam,
  PushLedgerEntry,
} from "../types.js";

// ── keys / normalization ─────────────────────────────────────────────────────

/** Stable division key = its PB.com label, case/space-insensitive (matches tm's divisionKey). */
export function divisionKeyOf(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Group a division's entries into PB.com "teams" (1 entry = singles, 2 partnered
 * entries = doubles). Teams are keyed by source_team_id when present; otherwise a
 * doubles pair is grouped by partner_registration_id, and a lone entry is its own team.
 */
export function resolveTeams(entries: BandeEntry[]): BandeTeam[] {
  const byRegId = new Map(entries.map((e) => [e.registrationId, e]));
  const assigned = new Set<string>();
  const teams: BandeTeam[] = [];

  const seedOf = (es: BandeEntry[]): number | null => {
    const seeds = es.map((e) => e.seed).filter((s): s is number => s != null);
    return seeds.length ? Math.min(...seeds) : null;
  };
  const makeTeam = (members: BandeEntry[]): BandeTeam => {
    for (const m of members) assigned.add(m.registrationId);
    const activityIds = members
      .map((m) => m.sourceActivityId)
      .filter((x): x is string => !!x)
      .sort();
    const teamId = members.find((m) => m.sourceTeamId)?.sourceTeamId ?? null;
    const teamKey = teamId
      ? `team:${teamId}`
      : `regs:${members.map((m) => m.registrationId).sort().join("+")}`;
    return {
      teamKey,
      sourceTeamId: teamId,
      registrationIds: members.map((m) => m.registrationId).sort(),
      sourceActivityIds: activityIds,
      seed: seedOf(members),
    };
  };

  // 1) group explicit PB.com doubles teams by shared source_team_id
  const byTeamId = new Map<string, BandeEntry[]>();
  for (const e of entries) {
    if (e.sourceTeamId) {
      const list = byTeamId.get(e.sourceTeamId) ?? [];
      list.push(e);
      byTeamId.set(e.sourceTeamId, list);
    }
  }
  for (const members of byTeamId.values()) teams.push(makeTeam(members));

  // 2) remaining entries: pair by partner_registration_id, else solo
  for (const e of entries) {
    if (assigned.has(e.registrationId)) continue;
    const partner = e.partnerRegistrationId ? byRegId.get(e.partnerRegistrationId) : undefined;
    if (partner && !assigned.has(partner.registrationId)) {
      teams.push(makeTeam([e, partner]));
    } else {
      teams.push(makeTeam([e]));
    }
  }

  return teams.sort((a, b) => a.teamKey.localeCompare(b.teamKey));
}

/** The sorted PB.com activity ids of the team a given registration belongs to. */
function teamActivityIds(regId: string | null, teams: BandeTeam[]): string[] {
  if (!regId) return [];
  const t = teams.find((tm) => tm.registrationIds.includes(regId));
  return t ? t.sourceActivityIds : [];
}

/**
 * A stable, fuzzy-match-free identity for a match, built from the preserved PB.com
 * per-entry ids of both teams plus the match's structural coordinates.
 */
export function matchIdentity(
  divisionLabel: string,
  match: BandeMatch,
  teams: BandeTeam[],
): string {
  const a = teamActivityIds(match.teamARegId, teams).join(",");
  const b = teamActivityIds(match.teamBRegId, teams).join(",");
  // Sort the two team blocks so A-vs-B and B-vs-A collapse to one identity.
  const [x, y] = [a, b].sort();
  const bracket = match.bracket ?? "main";
  return [
    divisionKeyOf(divisionLabel),
    x,
    y,
    match.stage,
    bracket,
    `r${match.round ?? "?"}`,
    `p${match.position ?? "?"}`,
  ].join("|");
}

/** The winning side, derived from winner_reg_id membership (not a stored 'a'/'b'). */
export function winnerSide(match: BandeMatch, teams: BandeTeam[]): "a" | "b" | null {
  if (!match.winnerRegId) return null;
  const aIds = teamActivityIds(match.teamARegId, teams);
  const winnerTeam = teams.find((t) => t.registrationIds.includes(match.winnerRegId!));
  if (!winnerTeam) return null;
  return winnerTeam.sourceActivityIds.join(",") === aIds.join(",") ? "a" : "b";
}

/** The score digest — changes when the recorded score changes, so a correction re-pushes. */
export function scoreDigest(match: BandeMatch, teams: BandeTeam[]): string {
  return `${match.teamAScore ?? ""}-${match.teamBScore ?? ""}/w:${winnerSide(match, teams) ?? "?"}`;
}

/** A match is pushable only when it is complete with a real score. */
export function isPushable(match: BandeMatch): boolean {
  return (
    match.status === "completed" &&
    match.teamAScore != null &&
    match.teamBScore != null &&
    match.winnerRegId != null
  );
}

// ── the plan ──────────────────────────────────────────────────────────────────

export interface PlannedScore {
  matchId: string;
  identity: string;
  digest: string;
  teamActivityIdsA: string[];
  teamActivityIdsB: string[];
}

export interface PushPlan {
  divisionLabel: string;
  teams: BandeTeam[];
  /** True when the bracket has not yet been created on PB.com. */
  bracketToCreate: boolean;
  /** Completed matches whose current score is not yet on PB.com (new or corrected). */
  scoresToPush: PlannedScore[];
  /** Completed matches already confirmed on PB.com with the same score — skip. */
  alreadyPushed: PlannedScore[];
  /** Matches not yet complete — informational (nothing to push). */
  notReady: number;
  /** Ledger score records whose match no longer exists in the draw — REPORT only. */
  orphaned: PushLedgerEntry[];
  /** True when every match is complete and every score is already pushed. */
  divisionComplete: boolean;
}

const BRACKET_KIND = "bracket" as const;
const SCORE_KIND = "score" as const;

/**
 * Compute the delta between a B&E draw and the push ledger. Pure: no I/O.
 * The ledger contains ONLY confirmed pushes (records written after PB.com verify).
 */
export function computePlan(draw: BandeDraw, ledger: PushLedgerEntry[]): PushPlan {
  const label = draw.division.sourceDivisionLabel ?? draw.division.name;
  const teams = resolveTeams(draw.entries);

  const bracketRecorded = ledger.some(
    (e) => e.kind === BRACKET_KIND && e.key === divisionKeyOf(label),
  );
  const scoreLedger = new Map(
    ledger.filter((e) => e.kind === SCORE_KIND).map((e) => [e.key, e.scoreDigest]),
  );

  const scoresToPush: PlannedScore[] = [];
  const alreadyPushed: PlannedScore[] = [];
  const desiredKeys = new Set<string>();
  let notReady = 0;

  for (const match of draw.matches) {
    if (!isPushable(match)) {
      notReady += 1;
      continue;
    }
    const identity = matchIdentity(label, match, teams);
    const digest = scoreDigest(match, teams);
    desiredKeys.add(identity);
    const planned: PlannedScore = {
      matchId: match.matchId,
      identity,
      digest,
      teamActivityIdsA: teamActivityIds(match.teamARegId, teams),
      teamActivityIdsB: teamActivityIds(match.teamBRegId, teams),
    };
    const priorDigest = scoreLedger.get(identity);
    if (priorDigest === digest) alreadyPushed.push(planned);
    else scoresToPush.push(planned);
  }

  // Orphans: a confirmed score whose match identity is gone from the draw
  // (a division re-draw, a withdrawn team). Reported so the "out of sync" signal
  // can surface it; the driver never auto-deletes on PB.com.
  const orphaned = ledger.filter(
    (e) => e.kind === SCORE_KIND && !desiredKeys.has(e.key),
  );

  const divisionComplete =
    bracketRecorded && notReady === 0 && scoresToPush.length === 0 && orphaned.length === 0;

  return {
    divisionLabel: label,
    teams,
    bracketToCreate: !bracketRecorded,
    scoresToPush,
    alreadyPushed,
    notReady,
    orphaned,
    divisionComplete,
  };
}

/** The ledger entry to write after a confirmed bracket create. */
export function bracketLedgerEntry(divisionLabel: string, at: string): PushLedgerEntry {
  return { key: divisionKeyOf(divisionLabel), kind: BRACKET_KIND, scoreDigest: "", pushedAt: at };
}

/** The ledger entry to write after a confirmed score submit. */
export function scoreLedgerEntry(planned: PlannedScore, at: string): PushLedgerEntry {
  return { key: planned.identity, kind: SCORE_KIND, scoreDigest: planned.digest, pushedAt: at };
}
