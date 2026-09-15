import { describe, it, expect } from "vitest";
import { validateScore, resolveScoreRules } from "./scoreValidation";

describe("validateScore — game to 11, win by 2", () => {
  const rules = { target: 11, winBy: 2 };

  it("accepts a clean win at the target (11–9)", () => {
    expect(validateScore(11, 9, rules)).toEqual({ ok: true });
    // order-independent
    expect(validateScore(9, 11, rules)).toEqual({ ok: true });
  });

  it("rejects a one-point margin at the target (11–10 is not win-by-2)", () => {
    const r = validateScore(11, 10, rules);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("won by 2");
  });

  it("rejects an unfinished game (9–7 — nobody reached 11)", () => {
    const r = validateScore(9, 7, rules);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("must reach 11");
  });

  it("accepts a deuce game won by exactly 2 past the target (12–10)", () => {
    expect(validateScore(12, 10, rules)).toEqual({ ok: true });
  });

  it("rejects a game past the target with too large a margin (13–9)", () => {
    const r = validateScore(13, 9, rules);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Past 11");
  });
});

describe("validateScore — game to 15 (medal), win by 2", () => {
  it("accepts a clean win at the target (15–13)", () => {
    expect(validateScore(15, 13, { target: 15, winBy: 2 })).toEqual({ ok: true });
  });
});

describe("validateScore — basic guards", () => {
  const rules = { target: 11, winBy: 2 };

  it("rejects NaN (empty inputs)", () => {
    expect(validateScore(NaN, 5, rules).ok).toBe(false);
  });

  it("rejects negative scores", () => {
    const r = validateScore(-1, 11, rules);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("negative");
  });

  it("rejects a tie", () => {
    const r = validateScore(11, 11, rules);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("tied");
  });
});

describe("validateScore — unknown target (time-capped formats)", () => {
  const rules = { target: null, winBy: 2 };

  it("still enforces the win-by margin", () => {
    expect(validateScore(15, 14, rules).ok).toBe(false);
  });

  it("accepts any decided score at or above the margin (10–4)", () => {
    // No target known → don't false-reject a legitimate capped score.
    expect(validateScore(10, 4, rules)).toEqual({ ok: true });
  });
});

describe("resolveScoreRules", () => {
  it("uses the event's points_to_win / win_by for round-robin matches", () => {
    const match = { stage: "round_robin" as const, match_points_to_win: null, match_win_by: null };
    expect(resolveScoreRules(match, { points_to_win: 11, win_by: 2 })).toEqual({ target: 11, winBy: 2 });
  });

  it("uses the per-match config for playoff matches (semifinal/medal is stamped on the row)", () => {
    const medal = { stage: "playoff" as const, match_points_to_win: 15, match_win_by: 2 };
    expect(resolveScoreRules(medal, { points_to_win: 11, win_by: 2 })).toEqual({ target: 15, winBy: 2 });
  });

  it("a per-match override wins even on a round-robin match", () => {
    const match = { stage: "round_robin" as const, match_points_to_win: 21, match_win_by: 2 };
    expect(resolveScoreRules(match, { points_to_win: 11, win_by: 2 })).toEqual({ target: 21, winBy: 2 });
  });

  it("falls back to the loosest safe check for a playoff row missing its config", () => {
    const match = { stage: "playoff" as const, match_points_to_win: null, match_win_by: null };
    expect(resolveScoreRules(match, { points_to_win: 11, win_by: 2 })).toEqual({ target: null, winBy: 2 });
  });
});
