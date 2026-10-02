/**
 * Sync RECONCILE — a read-only "are we in sync?" report you can run ANY TIME
 * during the tournament to confirm B&E and PB.com agree.
 *
 * The push verifies every write before recording the ledger (run.ts), so the
 * push ledger is a faithful record of what is CONFIRMED on PB.com. This module
 * compares, per division, B&E's current state against that ledger:
 *   • completed B&E matches vs confirmed score pushes → anything PENDING (a
 *     result B&E has that PB.com hasn't been told about yet),
 *   • ledger entries with no matching B&E match → ORPHANED (a re-draw/withdrawal
 *     left a score on PB.com the driver won't delete — a human must reconcile),
 *   • whether the bracket itself is confirmed created.
 * A division is IN SYNC when nothing is pending and nothing is orphaned.
 *
 * PURE: the CLI reads the DB + ledger and hands the counts here, so the whole
 * report is unit-testable with no DB and no browser.
 */

export type DivisionReconcileInput = {
  label: string;
  /** B&E round-robin + playoff matches that have a recorded result. */
  completedMatches: number;
  /** Score pushes confirmed on PB.com (verified-before-ledger entries). */
  confirmedScorePushes: number;
  /** Ledger score entries whose B&E match no longer exists (a re-draw/withdrawal). */
  orphanedPushes: number;
  /** The bracket-create step is recorded in the ledger. */
  bracketConfirmed: boolean;
  /** This division's bracket exists in B&E (there are matches to push). */
  hasBracket: boolean;
};

export type DivisionReconcile = {
  label: string;
  completedMatches: number;
  confirmedScorePushes: number;
  /** completedMatches − confirmedScorePushes, floored at 0: results not yet on PB.com. */
  pendingScorePushes: number;
  orphanedPushes: number;
  bracketConfirmed: boolean;
  /** This division's bracket exists in B&E (carried through for the report). */
  hasBracket: boolean;
  inSync: boolean;
  status: "in_sync" | "pending" | "needs_attention" | "not_started";
};

export type ReconcileReport = {
  divisions: DivisionReconcile[];
  totals: {
    completedMatches: number;
    confirmedScorePushes: number;
    pendingScorePushes: number;
    orphanedPushes: number;
  };
  /** True when NO division has pending or orphaned scores. */
  inSync: boolean;
};

export function buildReconcileReport(
  input: DivisionReconcileInput[],
): ReconcileReport {
  const divisions: DivisionReconcile[] = input.map((d) => {
    const pending = Math.max(0, d.completedMatches - d.confirmedScorePushes);
    const inSync = pending === 0 && d.orphanedPushes === 0;
    let status: DivisionReconcile["status"];
    if (d.orphanedPushes > 0) status = "needs_attention";
    else if (pending > 0) status = "pending";
    else if (!d.hasBracket && d.completedMatches === 0) status = "not_started";
    else status = "in_sync";
    return {
      label: d.label,
      completedMatches: d.completedMatches,
      confirmedScorePushes: d.confirmedScorePushes,
      pendingScorePushes: pending,
      orphanedPushes: d.orphanedPushes,
      bracketConfirmed: d.bracketConfirmed,
      hasBracket: d.hasBracket,
      inSync,
      status,
    };
  });

  const totals = divisions.reduce(
    (acc, d) => ({
      completedMatches: acc.completedMatches + d.completedMatches,
      confirmedScorePushes: acc.confirmedScorePushes + d.confirmedScorePushes,
      pendingScorePushes: acc.pendingScorePushes + d.pendingScorePushes,
      orphanedPushes: acc.orphanedPushes + d.orphanedPushes,
    }),
    { completedMatches: 0, confirmedScorePushes: 0, pendingScorePushes: 0, orphanedPushes: 0 },
  );

  return {
    divisions,
    totals,
    inSync: totals.pendingScorePushes === 0 && totals.orphanedPushes === 0,
  };
}
