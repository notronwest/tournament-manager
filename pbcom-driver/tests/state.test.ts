import { describe, expect, it } from "vitest";
import {
  INITIAL,
  IllegalTransition,
  initMachine,
  next,
  TERMINAL,
  type PushEvent,
  type PushState,
} from "../src/push/state.js";

describe("push state machine", () => {
  it("starts in verify", () => {
    expect(initMachine().state).toBe(INITIAL);
  });

  it("verify → waiting when the bracket is not yet on PB.com", () => {
    const m = next(initMachine(), "binding_ok_no_bracket");
    expect(m.state).toBe("waiting");
    expect(m.resume).toBe("waiting");
  });

  it("verify → running when the bracket already exists (reconcile)", () => {
    expect(next(initMachine(), "binding_ok_bracket_exists").state).toBe("running");
  });

  it("verify → needs_attention on a missing binding (terminal until human)", () => {
    const m = next(initMachine(), "binding_missing");
    expect(m.state).toBe("needs_attention");
    expect(TERMINAL.has(m.state)).toBe(true);
  });

  it("happy path: waiting → running → completed", () => {
    let m = next(initMachine(), "binding_ok_no_bracket");
    m = next(m, "bracket_created");
    expect(m.state).toBe("running");
    m = next(m, "score_pushed");
    expect(m.state).toBe("running");
    m = next(m, "all_complete");
    expect(m.state).toBe("completed");
  });

  it("counts attempts on failures and returns to the right resume point on retry", () => {
    let m = next(initMachine(), "binding_ok_bracket_exists"); // running
    m = next(m, "push_failed");
    expect(m.state).toBe("error");
    expect(m.attempts).toBe(1);
    expect(m.resume).toBe("running");
    m = next(m, "retry");
    expect(m.state).toBe("running"); // resumed where it failed, not from the top
    expect(m.attempts).toBe(1); // retry preserves the count
  });

  it("a bracket failure resumes to waiting, not running", () => {
    let m = next(initMachine(), "binding_ok_no_bracket"); // waiting
    m = next(m, "bracket_failed");
    expect(m.state).toBe("error");
    expect(m.resume).toBe("waiting");
    m = next(m, "retry");
    expect(m.state).toBe("waiting");
  });

  it("exhausted retries escalate to needs_attention", () => {
    let m = next(initMachine(), "binding_ok_bracket_exists");
    m = next(m, "push_failed");
    m = next(m, "exhausted");
    expect(m.state).toBe("needs_attention");
  });

  it("needs_attention only clears via human_reset (back to verify)", () => {
    let m = next(initMachine(), "binding_missing");
    expect(() => next(m, "retry")).toThrow(IllegalTransition);
    m = next(m, "human_reset");
    expect(m.state).toBe("verify");
  });

  it("a corrected result reopens a completed division to running", () => {
    let m = next(initMachine(), "binding_ok_bracket_exists");
    m = next(m, "all_complete");
    expect(m.state).toBe("completed");
    m = next(m, "drift_detected");
    expect(m.state).toBe("running");
  });

  it("is immutable — next() never mutates its input", () => {
    const m0 = initMachine();
    const snapshot = { ...m0 };
    next(m0, "binding_ok_no_bracket");
    expect(m0).toEqual(snapshot);
  });

  it("throws on every unmodelled transition", () => {
    const illegal: Array<[PushState, PushEvent]> = [
      ["verify", "score_pushed"],
      ["waiting", "all_complete"],
      ["running", "bracket_created"],
      ["completed", "score_pushed"],
      ["needs_attention", "bracket_created"],
    ];
    for (const [state, event] of illegal) {
      const m = { state, resume: "running" as const, attempts: 0 };
      expect(() => next(m, event)).toThrow(IllegalTransition);
    }
  });
});
