/**
 * Supervised DRESS-REHEARSAL verdict — the pure scoring of a rehearsal run.
 *
 * The push's write path (create bracket + submit scores on PB.com) is traced but
 * has never been driven end-to-end by the DRIVER against a live-shaped site. The
 * `rehearse` command drives ONE division for real against the CONFIGURED PB.com
 * (point it at the training site), using an in-memory ledger so nothing persists,
 * and every write still verifies-after-write. This turns the drive's outcome into a
 * clear PASS / FAIL so a human knows the automated path actually works before the
 * real tournament — instead of discovering it mid-event.
 *
 * `expected` = planned writes (bracket-create + each completed score). `verified` =
 * writes that read back on PB.com (the in-memory ledger only records verified ones).
 */
export type RehearsalOutcome = "passed" | "failed" | "nothing_to_do";

export interface RehearsalVerdict {
  outcome: RehearsalOutcome;
  expected: number;
  verified: number;
  summary: string;
}

export function rehearsalVerdict(expected: number, verified: number): RehearsalVerdict {
  if (expected === 0) {
    return {
      outcome: "nothing_to_do",
      expected,
      verified,
      summary: "nothing to rehearse — this division has no bracket to create and no completed scores to push. Score a match in B&E first.",
    };
  }
  if (verified >= expected) {
    return {
      outcome: "passed",
      expected,
      verified,
      summary: `REHEARSAL PASSED — all ${expected} write(s) (bracket + scores) landed AND read back on PB.com. The automated write path works.`,
    };
  }
  return {
    outcome: "failed",
    expected,
    verified,
    summary: `REHEARSAL FAILED — only ${verified} of ${expected} write(s) verified on PB.com. The driver stopped at the first write that didn't read back (it never guesses); see the log above for which step. Fix before the real event.`,
  };
}
