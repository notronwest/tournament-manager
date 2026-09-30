/**
 * The push-lifecycle state machine, mirroring PB.com's live-console states so an
 * operator watching PB.com and an operator watching B&E see the SAME word:
 *
 *   verify → waiting → running → completed
 *                  ↘  error  ↗        ↘ needs_attention
 *
 *   • verify         — pre-flight: binding resolves, a PB.com session is possible,
 *                      the division maps. No writes.
 *   • waiting        — verified; the bracket does not yet exist on PB.com. Ready to create.
 *   • running        — the bracket exists on PB.com; scores are being submitted as
 *                      matches complete.
 *   • completed      — every match in the division is complete AND every score is
 *                      confirmed on PB.com.
 *   • error          — a step failed but is retryable (transient / re-drivable).
 *   • needs_attention — drift we cannot auto-heal, or retries exhausted. This is the
 *                      human-visible "PB.com out of sync" signal D-0045 requires. It is
 *                      terminal until a human resets it.
 *
 * The machine is pure and total: `next()` validates every transition and throws on
 * an illegal one, so a caller can never silently land in a bad state.
 */

export type PushState =
  | "verify"
  | "waiting"
  | "running"
  | "completed"
  | "error"
  | "needs_attention";

export type PushEvent =
  // verify outcomes
  | "binding_ok_no_bracket"
  | "binding_ok_bracket_exists"
  | "binding_missing"
  | "login_failed"
  // create outcomes
  | "bracket_created"
  | "bracket_failed"
  // score outcomes
  | "score_pushed"
  | "all_complete"
  | "push_failed"
  // drift / recovery
  | "drift_detected"
  | "retry"
  | "exhausted"
  | "human_reset";

export const INITIAL: PushState = "verify";

/** States from which the machine cannot advance without a human. */
export const TERMINAL: ReadonlySet<PushState> = new Set<PushState>(["completed", "needs_attention"]);

/**
 * Where a retry from `error` should resume. We remember the pre-error state so a
 * transient failure returns to exactly where it was, not to the top.
 */
type ResumeTarget = "waiting" | "running";

export interface PushMachine {
  state: PushState;
  /** Where `error → retry` resumes to. */
  resume: ResumeTarget;
  /** Consecutive failed attempts at the current step; drives `exhausted`. */
  attempts: number;
}

export function initMachine(): PushMachine {
  return { state: INITIAL, resume: "waiting", attempts: 0 };
}

export class IllegalTransition extends Error {
  constructor(state: PushState, event: PushEvent) {
    super(`illegal push transition: ${event} from ${state}`);
    this.name = "IllegalTransition";
  }
}

/**
 * Advance the machine. Returns a NEW machine (immutable), never mutates the input.
 * Throws IllegalTransition for any (state, event) pair not modelled below.
 */
export function next(m: PushMachine, event: PushEvent): PushMachine {
  const { state } = m;

  switch (state) {
    case "verify":
      switch (event) {
        case "binding_ok_no_bracket":
          return { state: "waiting", resume: "waiting", attempts: 0 };
        case "binding_ok_bracket_exists":
          return { state: "running", resume: "running", attempts: 0 };
        case "binding_missing":
          return { state: "needs_attention", resume: m.resume, attempts: m.attempts };
        case "login_failed":
          return { state: "error", resume: "waiting", attempts: m.attempts + 1 };
        default:
          throw new IllegalTransition(state, event);
      }

    case "waiting":
      switch (event) {
        case "bracket_created":
          return { state: "running", resume: "running", attempts: 0 };
        case "bracket_failed":
          return { state: "error", resume: "waiting", attempts: m.attempts + 1 };
        case "drift_detected":
          // bracket vanished / changed on PB.com while we waited → still create.
          return { state: "waiting", resume: "waiting", attempts: 0 };
        default:
          throw new IllegalTransition(state, event);
      }

    case "running":
      switch (event) {
        case "score_pushed":
          return { state: "running", resume: "running", attempts: 0 };
        case "all_complete":
          return { state: "completed", resume: "running", attempts: 0 };
        case "push_failed":
          return { state: "error", resume: "running", attempts: m.attempts + 1 };
        case "drift_detected":
          // a previously-pushed score changed on PB.com → re-reconcile from running.
          return { state: "running", resume: "running", attempts: 0 };
        default:
          throw new IllegalTransition(state, event);
      }

    case "error":
      switch (event) {
        case "retry":
          return { state: m.resume, resume: m.resume, attempts: m.attempts };
        case "exhausted":
          return { state: "needs_attention", resume: m.resume, attempts: m.attempts };
        default:
          throw new IllegalTransition(state, event);
      }

    case "completed":
      switch (event) {
        case "drift_detected":
          // a corrected result arrived after completion → reopen to running.
          return { state: "running", resume: "running", attempts: 0 };
        default:
          throw new IllegalTransition(state, event);
      }

    case "needs_attention":
      switch (event) {
        case "human_reset":
          return { state: "verify", resume: "waiting", attempts: 0 };
        default:
          throw new IllegalTransition(state, event);
      }

    default:
      throw new IllegalTransition(state, event);
  }
}
