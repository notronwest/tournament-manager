// Score-entry validation for the tournament desk.
//
// Every place an admin types a final game score (the two Court Manager
// pages and the Event Console Games tab) runs the same checks here, so a
// physically impossible score is caught before it is written and a winner
// is confirmed with the same rules everywhere.
//
// Live-desk feedback (2026-09): the old checks only rejected NaN, negative
// and tied scores, so an unfinished game like 9–7 (a game to 11, win by 2
// that nobody has actually won) was accepted. These helpers add the two
// missing rules — reach the target, and win by the margin — while staying
// deliberately lenient when the target is unknown (time-capped formats)
// so a legitimate score is never falsely rejected.

/** The rules a single game is scored under. */
export type ScoreRules = {
  /**
   * Points the game is played to (e.g. 11, 15). `null` when unknown — the
   * target-related checks are skipped so time-capped / non-standard formats
   * are never falsely rejected. Only the win-by margin is enforced then.
   */
  target: number | null;
  /** Margin required to win (e.g. 2). */
  winBy: number;
};

export type ScoreValidation = { ok: true } | { ok: false; error: string };

/** Structural subset of a `matches` row needed to resolve its scoring rules. */
type MatchScoreConfig = {
  stage: "round_robin" | "playoff";
  match_points_to_win: number | null;
  match_win_by: number | null;
};

/** Structural subset of an `events` row needed to resolve round-robin rules. */
type EventScoreConfig = {
  points_to_win: number;
  win_by: number;
};

/**
 * Resolve the target / win-by a match is scored under.
 *
 * Per-match overrides (`match_points_to_win` / `match_win_by`) win when
 * present. Playoff matches always carry these — the bracket generator
 * stamps each row from the event's semifinal_* or medal_* config, so the
 * semifinal-vs-medal distinction is already baked into the match row and
 * needs no round/position guesswork here. Round-robin matches leave them
 * null and fall back to the event's `points_to_win` / `win_by`.
 *
 * When neither is available (a playoff row somehow missing its config) the
 * target is left `null` and win-by defaults to 2 — the loosest safe check,
 * with the confirmation modal as the human backstop.
 */
export function resolveScoreRules(
  match: MatchScoreConfig,
  event: EventScoreConfig | null | undefined,
): ScoreRules {
  const isRR = match.stage === "round_robin";
  const target =
    match.match_points_to_win ?? (isRR ? event?.points_to_win ?? null : null);
  const winBy = match.match_win_by ?? (isRR ? event?.win_by ?? 2 : 2);
  return { target, winBy };
}

/**
 * Validate a final game score against its rules. Returns `{ ok: true }` for
 * a legal finished game, or `{ ok: false, error }` with a specific,
 * desk-readable message otherwise.
 *
 * Checks, in order: both numbers present, non-negative, not tied, decided
 * by at least `winBy`, and — only when the target is known — that the
 * winner reached the target and that a game past the target ended the
 * instant a team led by exactly `winBy`.
 */
export function validateScore(
  a: number,
  b: number,
  rules: ScoreRules,
): ScoreValidation {
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return { ok: false, error: "Both scores required." };
  }
  if (a < 0 || b < 0) {
    return { ok: false, error: "Scores can't be negative." };
  }
  if (a === b) {
    return { ok: false, error: "Scores can't be tied — a game must have a winner." };
  }

  const hi = Math.max(a, b);
  const lo = Math.min(a, b);

  if (hi - lo < rules.winBy) {
    return { ok: false, error: `A game must be won by ${rules.winBy} — ${hi}–${lo} isn't.` };
  }

  const { target, winBy } = rules;
  if (target && target > 0) {
    if (hi < target) {
      return {
        ok: false,
        error: `Winner must reach ${target} (win by ${winBy}) — ${hi}–${lo} is unfinished.`,
      };
    }
    if (hi > target && hi - lo !== winBy) {
      return {
        ok: false,
        error: `Past ${target}, a game ends the instant a team leads by ${winBy} — it can't finish ${hi}–${lo}.`,
      };
    }
  }

  return { ok: true };
}
