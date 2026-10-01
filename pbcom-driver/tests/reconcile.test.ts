import { describe, expect, it } from "vitest";
import { buildReconcileReport, type DivisionReconcileInput } from "../src/reconcile.js";

const div = (o: Partial<DivisionReconcileInput> = {}): DivisionReconcileInput => ({
  label: "Mens Doubles 3.0",
  completedMatches: 0,
  confirmedScorePushes: 0,
  orphanedPushes: 0,
  bracketConfirmed: false,
  hasBracket: false,
  ...o,
});

describe("buildReconcileReport", () => {
  it("in sync when every completed match is confirmed and nothing is orphaned", () => {
    const r = buildReconcileReport([
      div({ completedMatches: 10, confirmedScorePushes: 10, bracketConfirmed: true, hasBracket: true }),
    ]);
    expect(r.inSync).toBe(true);
    expect(r.divisions[0]!.status).toBe("in_sync");
    expect(r.divisions[0]!.pendingScorePushes).toBe(0);
  });

  it("flags pending pushes — results B&E has that PB.com doesn't yet", () => {
    const r = buildReconcileReport([
      div({ completedMatches: 10, confirmedScorePushes: 7, bracketConfirmed: true, hasBracket: true }),
    ]);
    expect(r.inSync).toBe(false);
    expect(r.divisions[0]!.status).toBe("pending");
    expect(r.divisions[0]!.pendingScorePushes).toBe(3);
    expect(r.totals.pendingScorePushes).toBe(3);
  });

  it("needs attention on an orphaned push (a re-draw left a score on PB.com)", () => {
    const r = buildReconcileReport([
      div({ completedMatches: 10, confirmedScorePushes: 10, orphanedPushes: 1, bracketConfirmed: true, hasBracket: true }),
    ]);
    expect(r.inSync).toBe(false);
    expect(r.divisions[0]!.status).toBe("needs_attention");
  });

  it("orphaned outranks pending in the division status", () => {
    const r = buildReconcileReport([
      div({ completedMatches: 10, confirmedScorePushes: 6, orphanedPushes: 2, hasBracket: true }),
    ]);
    expect(r.divisions[0]!.status).toBe("needs_attention");
    expect(r.divisions[0]!.pendingScorePushes).toBe(4);
  });

  it("not started when there is no bracket and no results", () => {
    const r = buildReconcileReport([div()]);
    expect(r.divisions[0]!.status).toBe("not_started");
    expect(r.inSync).toBe(true); // nothing pending or orphaned
  });

  it("confirmed can never exceed completed (pending floors at 0)", () => {
    const r = buildReconcileReport([
      div({ completedMatches: 3, confirmedScorePushes: 5, hasBracket: true }),
    ]);
    expect(r.divisions[0]!.pendingScorePushes).toBe(0);
  });

  it("totals sum across divisions and inSync reflects the whole tournament", () => {
    const r = buildReconcileReport([
      div({ label: "A", completedMatches: 10, confirmedScorePushes: 10, bracketConfirmed: true, hasBracket: true }),
      div({ label: "B", completedMatches: 8, confirmedScorePushes: 5, bracketConfirmed: true, hasBracket: true }),
    ]);
    expect(r.totals.completedMatches).toBe(18);
    expect(r.totals.pendingScorePushes).toBe(3);
    expect(r.inSync).toBe(false);
  });
});
