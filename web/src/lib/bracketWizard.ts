// Bracket Setup wizard — pure step model + per-step advance gates.
//
// The wizard (pages/admin/BracketSetupWizard.tsx) is a guided, one-path
// consolidation of the five actions that today live in five different
// places to start an event's bracket:
//
//   1. Mark ready   — event status draft → ready
//   2. Confirm teams — the roster + doubles pairings
//   3. Confirm settings — bracket format / pools / playoff config
//   4. Build         — generate the games from settings
//   5. Start         — event → active; games appear in the Court Manager
//
// This module owns the *decision* logic only (which step you may leave,
// and why not) so it can be unit-tested without React. The wizard shell
// and EventConsolePage own the DOM and the side-effectful handlers
// (mark-ready / generate / start) — those are reused, never reimplemented
// here.

export type BracketWizardStepId =
  | "ready"
  | "teams"
  | "settings"
  | "court"
  | "starttime"
  | "build"
  | "start";

export type BracketWizardStepMeta = {
  id: BracketWizardStepId;
  title: string;
  // One-line description shown under the step heading.
  blurb: string;
};

export const BRACKET_WIZARD_STEPS: BracketWizardStepMeta[] = [
  {
    id: "ready",
    title: "Mark ready",
    blurb: "Lock the event as configured and ready to play.",
  },
  {
    id: "teams",
    title: "Confirm teams",
    blurb: "Check the roster and doubles pairings before the draw.",
  },
  {
    id: "settings",
    title: "Confirm settings",
    blurb: "Format, pools, and playoff configuration.",
  },
  {
    id: "court",
    title: "Courts",
    blurb: "Assign the courts this event will use today.",
  },
  {
    id: "starttime",
    title: "Start time",
    blurb: "Pick when this event starts, around the day's other events.",
  },
  {
    id: "build",
    title: "Build the bracket",
    blurb: "Generate the games from the settings above.",
  },
  {
    id: "start",
    title: "Review & start",
    blurb: "Start the event — games appear in the Court Manager.",
  },
];

// Everything the gates need to decide "can I leave this step?" — read
// live from the event / teams / matches the console already holds.
export type BracketWizardContext = {
  // event.status ("draft" | "ready" | "active" | "medal_round" | …)
  status: string;
  teamCount: number;
  isDoubles: boolean;
  // Doubles teams still missing a partner (0 for singles).
  unpairedCount: number;
  // Pool play only: how many pools the event is split into, and how many
  // teams are not yet assigned to one.
  poolCount: number;
  unassignedPoolCount: number;
  // Games generated so far (round-robin + bracket).
  matchCount: number;
  // Courts assigned to this event (event_courts rows). The court step is
  // satisfied once at least one is assigned.
  courtsAssignedCount: number;
  // Whether the event has a scheduled_start_at. Gates the start-time step.
  hasStartTime: boolean;
};

// A step is either clear to advance past, or blocked with a reason the
// wizard surfaces inline and as the Next-button tooltip.
export type StepGate = { ok: true } | { ok: false; reason: string };

const CLEAR: StepGate = { ok: true };

// Statuses at or past "ready" — the mark-ready step is satisfied by any
// of them (re-running the wizard on an already-started event is fine).
const READY_OR_BEYOND = new Set([
  "ready",
  "active",
  "medal_round",
  "complete",
  "verified",
  "on_hold",
]);

// Can the director advance PAST `step`? Pure — same inputs, same answer.
export function bracketWizardStepGate(
  step: BracketWizardStepId,
  ctx: BracketWizardContext,
): StepGate {
  switch (step) {
    case "ready":
      // Must have marked the event ready (or already started it).
      if (READY_OR_BEYOND.has(ctx.status)) return CLEAR;
      return { ok: false, reason: "Mark the event ready to continue." };

    case "teams": {
      if (ctx.teamCount < 2)
        return { ok: false, reason: "Add at least 2 teams first." };
      if (ctx.isDoubles && ctx.unpairedCount > 0)
        return {
          ok: false,
          reason: `${ctx.unpairedCount} team${
            ctx.unpairedCount === 1 ? "" : "s"
          } still need a partner.`,
        };
      // Pools are assigned from the Teams tab, so hold the wizard here
      // until every team has a pool — otherwise Build would reject it.
      if (ctx.poolCount > 1 && ctx.unassignedPoolCount > 0)
        return {
          ok: false,
          reason: `Assign every team to a pool — ${ctx.unassignedPoolCount} unassigned.`,
        };
      return CLEAR;
    }

    case "settings":
      // Settings always have valid defaults; confirmation is enough.
      return CLEAR;

    case "court":
      // Auto-satisfied when the recommendation is accepted; block only if the
      // director cleared every court.
      if (ctx.courtsAssignedCount > 0) return CLEAR;
      return { ok: false, reason: "Assign at least one court to continue." };

    case "starttime":
      // Auto-satisfied when the recommended start is accepted.
      if (ctx.hasStartTime) return CLEAR;
      return { ok: false, reason: "Set a start time to continue." };

    case "build":
      if (ctx.matchCount > 0) return CLEAR;
      return { ok: false, reason: "Build the bracket to continue." };

    case "start":
      // Terminal step — the Start button itself enforces the check-in
      // gate. Nothing blocks *reaching* the review.
      return CLEAR;
  }
}

// Convenience for the shell: is every step up to and including `index`
// clear? Used to decide which future steps are reachable (a locked step
// blocks all steps after it).
export function bracketWizardFurthestReachable(
  ctx: BracketWizardContext,
): number {
  for (let i = 0; i < BRACKET_WIZARD_STEPS.length; i++) {
    const gate = bracketWizardStepGate(BRACKET_WIZARD_STEPS[i].id, ctx);
    if (!gate.ok) return i; // can see step i, but not past it
  }
  return BRACKET_WIZARD_STEPS.length - 1;
}
