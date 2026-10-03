/**
 * The PURE reverse-sync planner (PB.com → B&E). Given a B&E division draw and the
 * parsed PB.com public matches for that division, decide which B&E match scores to
 * WRITE — with no I/O, so the whole decision is unit-testable and previewable.
 *
 * IDENTITY / IDEMPOTENCY, without a separate ledger:
 *   • A PB.com match is located onto a B&E match by the two teams' normalized
 *     last-name SETS (reusing pbcom/matchMap.findMatchRow — the same crux as the
 *     forward push: PB.com exposes names, not B&E ids). findMatchRow also yields the
 *     A↔team-one orientation, so each side's score lands on the correct B&E team.
 *   • The "have we already synced this?" check is B&E's OWN current score: we write
 *     only when the B&E match is not completed or its score/winner differs. This is
 *     self-correcting (a hand-correction in B&E or on PB.com reconciles next tick)
 *     and needs no reverse-ledger table.
 *
 * SCOPE (v1): ROUND-ROBIN pool matches only. RR matches always exist in B&E with
 * fixed teams from bracket creation, so name-matching works and there is no
 * feed-forward. Playoff sync (seeding B&E's playoff bracket from standings +
 * feed-forward) is a documented follow-up — see DESIGN.md §reverse.
 *
 * FAIL-CLOSED: a completed PB.com RR match that maps to NO B&E match is surfaced as
 * `unmatched` (a roster/division divergence a human must resolve, e.g. the Men's
 * 4.0 pool mismatch) — it is reported and alerted, never written.
 */
import type { BandeDraw, BandeMatch } from "../types.js";
import { resolveTeams, teamLastNames, divisionKeyOf } from "../push/plan.js";
import { findMatchRow, type PbMatchRow } from "../pbcom/matchMap.js";
import { isRoundRobin, type PbPublicMatch } from "../pbcom/results.js";

/** One B&E match score to write, resolved from the matched PB.com match. */
export interface PulledScore {
  /** B&E matches.id */
  matchId: string;
  /** B&E events.id (the division) — passed to the write so it can scope/validate. */
  eventId: string;
  /** The PB.com match uuid this came from (audit trail). */
  pbMatchUuid: string;
  /** B&E team A / B points (oriented to B&E's A/B sides). */
  teamAScore: number;
  teamBScore: number;
  /** B&E registration id of the winning team (one of team_a_reg_id / team_b_reg_id). */
  winnerRegId: string;
}

/** A completed PB.com match that matched no B&E match — the out-of-sync signal. */
export interface UnmatchedPbMatch {
  pbMatchUuid: string;
  teamOneLastNames: string[];
  teamTwoLastNames: string[];
  reason: "not_found" | "ambiguous";
}

export interface PullPlan {
  divisionLabel: string;
  /** Completed PB matches whose B&E score is missing or different — write these. */
  toWrite: PulledScore[];
  /** Completed PB matches whose B&E match already holds the same score — skip. */
  alreadyInSync: number;
  /** Completed PB RR matches that mapped to NO B&E match (fail-closed; never written). */
  unmatched: UnmatchedPbMatch[];
  /** Best-of-N PB results v1 cannot map onto B&E's single score — skip + count. */
  skippedMultiGame: number;
  /** PB RR matches not yet complete (or missing a usable score/winner) — informational. */
  notReady: number;
}

/** Did B&E team A win, given the PB winner (1|2) and the A↔team-one orientation? */
function bandeTeamAWon(pbWinner: 1 | 2, aIsTeamOne: boolean): boolean {
  return aIsTeamOne ? pbWinner === 1 : pbWinner === 2;
}

/**
 * Plan the reverse sync for ONE division. `pbMatches` are the parsed public-API
 * matches for the SAME division (the runner maps B&E division ↔ PB division by
 * title before calling this). Pure: no I/O.
 */
export function planPull(draw: BandeDraw, pbMatches: readonly PbPublicMatch[]): PullPlan {
  const label = draw.division.sourceDivisionLabel ?? draw.division.name;
  const teams = resolveTeams(draw.entries);

  // v1 scope: round-robin pool matches only, on both sides.
  const pbRrMatches = pbMatches.filter(isRoundRobin);
  const byUuid = new Map(pbRrMatches.map((m) => [m.matchUuid, m]));
  const rows: PbMatchRow[] = pbRrMatches.map((m) => ({
    ref: m.matchUuid,
    teamOneLastNames: m.teamOneLastNames,
    teamTwoLastNames: m.teamTwoLastNames,
    hasScore: m.completed,
  }));

  const toWrite: PulledScore[] = [];
  let alreadyInSync = 0;
  let skippedMultiGame = 0;
  let notReady = 0;
  const matchedPbUuids = new Set<string>();

  const rrBandeMatches = draw.matches.filter(
    (m: BandeMatch) => m.stage === "round_robin" && m.teamARegId && m.teamBRegId,
  );

  for (const m of rrBandeMatches) {
    const bandeA = teamLastNames(m.teamARegId, teams);
    const bandeB = teamLastNames(m.teamBRegId, teams);
    const found = findMatchRow(bandeA, bandeB, rows);
    if (!found.ok) {
      // No PB counterpart for this B&E match yet (not played, or a name mismatch we
      // cannot resolve). Nothing to write; the PB-side `unmatched` sweep below is
      // what flags a divergence a human must see.
      notReady += 1;
      continue;
    }
    const pb = byUuid.get(found.match.row.ref);
    if (!pb) {
      notReady += 1;
      continue;
    }
    matchedPbUuids.add(pb.matchUuid);

    if (!pb.completed) {
      notReady += 1;
      continue;
    }
    if (pb.multiGame) {
      skippedMultiGame += 1;
      continue;
    }

    const aIsTeamOne = found.match.aIsTeamOne;
    const aScore = aIsTeamOne ? pb.teamOneScore : pb.teamTwoScore;
    const bScore = aIsTeamOne ? pb.teamTwoScore : pb.teamOneScore;
    if (aScore == null || bScore == null || pb.winner == null) {
      // Completed on PB.com but without a usable single-game score/winner — not
      // actionable this tick (bad/partial data); never guess.
      notReady += 1;
      continue;
    }

    const winnerRegId = bandeTeamAWon(pb.winner, aIsTeamOne)
      ? (m.teamARegId as string)
      : (m.teamBRegId as string);

    const inSync =
      m.status === "completed" &&
      m.teamAScore === aScore &&
      m.teamBScore === bScore &&
      m.winnerRegId === winnerRegId;
    if (inSync) {
      alreadyInSync += 1;
      continue;
    }

    toWrite.push({
      matchId: m.matchId,
      eventId: draw.division.eventId,
      pbMatchUuid: pb.matchUuid,
      teamAScore: aScore,
      teamBScore: bScore,
      winnerRegId,
    });
  }

  // Fail-closed sweep: a completed PB RR match that matched no B&E match is a
  // divergence (roster/pool mismatch). Report it; never write a guess.
  const unmatched: UnmatchedPbMatch[] = [];
  for (const pb of pbRrMatches) {
    if (!pb.completed || matchedPbUuids.has(pb.matchUuid)) continue;
    // Re-run the locate from the PB side to classify not_found vs ambiguous.
    const bandeRows: PbMatchRow[] = rrBandeMatches.map((m) => ({
      ref: m.matchId,
      teamOneLastNames: teamLastNames(m.teamARegId, teams),
      teamTwoLastNames: teamLastNames(m.teamBRegId, teams),
    }));
    const locate = findMatchRow(pb.teamOneLastNames, pb.teamTwoLastNames, bandeRows);
    unmatched.push({
      pbMatchUuid: pb.matchUuid,
      teamOneLastNames: pb.teamOneLastNames,
      teamTwoLastNames: pb.teamTwoLastNames,
      reason: locate.ok ? "not_found" : locate.reason,
    });
  }

  return { divisionLabel: label, toWrite, alreadyInSync, unmatched, skippedMultiGame, notReady };
}

/** Case/space-insensitive division key, re-exported for the runner's title matching. */
export { divisionKeyOf };
