/**
 * The two FORM-SPECIFIC operations that the live director-session trace will fill.
 *
 * Their INPUT and OUTPUT types are defined precisely here (from the B&E side) so the
 * rest of the driver — planning, state machine, reconcile, logging — is complete and
 * testable now. Only the PB.com DOM interaction BODIES are stubs, clearly marked, to
 * be replaced with the selectors/steps captured in the trace (D-0045 "trace first").
 *
 * Both operations MUST be verify-after-write: they drive PB.com, then read PB.com back
 * and set `verified` only when the landed state matches what was pushed. The executor
 * records the ledger entry ONLY on `verified === true`, which is what makes re-runs
 * safe and the "out of sync" signal honest.
 */
import type { ResolvedDivisionTarget } from "../binding.js";
import type { BandeMatch, BandeTeam } from "../types.js";
import type { PbcomSession } from "./session.js";

// ── createBracketOnPbcom ───────────────────────────────────────────────────────

/** The seeded draw B&E owns and wants reflected as a PB.com bracket. */
export interface BracketPushInput {
  /** PB.com division label (its identity; events.source_division_label). */
  divisionLabel: string;
  /** How B&E generated the draw — tells the driver which PB.com bracket shape to build. */
  bracketType:
    | "round_robin"
    | "single_elim"
    | "double_elim"
    | "pool_then_bracket"
    | null;
  /** The teams (singles=1 entry, doubles=2), each carrying PB.com source ids + seed. */
  teams: BandeTeam[];
  /** The generated match structure (slots/rounds), pre-scores, from the `matches` table. */
  matches: BandeMatch[];
}

export interface BracketPushResult {
  /** True only when PB.com was read back and shows the bracket as pushed. */
  verified: boolean;
  /** PB.com's own bracket/division id, if the trace lets us capture it (for future binds). */
  pbcomDivisionId: string | null;
  /** A human-readable note for the log / "out of sync" surface on failure. */
  detail: string;
}

/**
 * Create + seed the division's bracket on PB.com.
 *
 * ┌─ TRACE SEAM (createBracket) ─────────────────────────────────────────────────┐
 * │ Fill from the director-session trace. Do NOT invent selectors. Expected shape:│
 * │   1. navigate to the event (target.pbcomEid) → the division                   │
 * │      (target.pbcomDivisionId if pinned, else locate by target.divisionLabel). │
 * │   2. create/open the bracket of `input.bracketType`.                          │
 * │   3. place each team into its seeded slot; map a B&E team to a PB.com entry by │
 * │      team.sourceActivityIds / team.sourceTeamId (preserved on import — NO      │
 * │      fuzzy matching).                                                          │
 * │   4. save; dismiss any overlay (session.dismissPopups()).                     │
 * │   5. VERIFY: reload and confirm the bracket + seeds landed; capture           │
 * │      pbcomDivisionId if visible. Return verified accordingly.                  │
 * │ Prefer XHR-replay over UI clicks where the trace shows a clean endpoint       │
 * │ (courtreserve-api cr_ajax pattern); fall back to UI automation otherwise.     │
 * └───────────────────────────────────────────────────────────────────────────────┘
 */
export async function createBracketOnPbcom(
  _session: PbcomSession,
  _target: ResolvedDivisionTarget,
  _input: BracketPushInput,
): Promise<BracketPushResult> {
  throw new Error(
    "createBracketOnPbcom: TRACE SEAM not filled — capture the PB.com bracket-create flow " +
      "(D-0045) and implement per the header. Types are final; only the DOM body is pending.",
  );
}

// ── submitScoreCard ────────────────────────────────────────────────────────────

/** One completed match's score, resolved to PB.com entry ids. */
export interface ScoreCardInput {
  /** B&E matches.id — for logging / traceability. */
  matchId: string;
  /** The reconcile identity (from push/plan.matchIdentity). */
  identity: string;
  /** PB.com per-entry ids of team A / team B (source_activity_id, sorted). */
  teamActivityIdsA: string[];
  teamActivityIdsB: string[];
  /** The aggregate score B&E recorded (single pair; B&E has no per-game table). */
  teamAScore: number;
  teamBScore: number;
  /** Which side won, derived from winner_reg_id. */
  winnerSide: "a" | "b";
}

export interface ScoreCardResult {
  /** True only when PB.com was read back and shows this score. */
  verified: boolean;
  /** A human-readable note for the log / "out of sync" surface on failure. */
  detail: string;
}

/**
 * Enter (or correct) one match's score on PB.com.
 *
 * ┌─ TRACE SEAM (submitScoreCard) ───────────────────────────────────────────────┐
 * │ Fill from the director-session trace. Do NOT invent selectors. Expected shape:│
 * │   1. locate the match on PB.com from the two teams' source ids                │
 * │      (input.teamActivityIdsA / …B) within the event's division — the match    │
 * │      identity is already resolved, so this is a lookup, not a search.          │
 * │   2. open its score card; enter input.teamAScore / teamBScore (respecting the │
 * │      side mapping — A/B must match how PB.com labels the two teams).           │
 * │   3. save; dismiss any overlay (session.dismissPopups()).                     │
 * │   4. VERIFY: reload and confirm the saved score equals what we sent; set      │
 * │      verified accordingly (a corrected score must overwrite, not append).      │
 * │ Prefer XHR-replay where the trace shows a clean score-submit endpoint.        │
 * └───────────────────────────────────────────────────────────────────────────────┘
 */
export async function submitScoreCard(
  _session: PbcomSession,
  _target: ResolvedDivisionTarget,
  _input: ScoreCardInput,
): Promise<ScoreCardResult> {
  throw new Error(
    "submitScoreCard: TRACE SEAM not filled — capture the PB.com score-entry flow " +
      "(D-0045) and implement per the header. Types are final; only the DOM body is pending.",
  );
}
