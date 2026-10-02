import { describe, it, expect } from "vitest";
import {
  BRACKET_WIZARD_STEPS,
  bracketWizardStepGate,
  bracketWizardFurthestReachable,
  type BracketWizardContext,
} from "./bracketWizard";

// A fully-ready singles event that has already been built — the "all
// clear" baseline each test bends one field of.
const ready: BracketWizardContext = {
  status: "ready",
  teamCount: 6,
  isDoubles: false,
  unpairedCount: 0,
  poolCount: 1,
  unassignedPoolCount: 0,
  matchCount: 15,
  courtsAssignedCount: 4,
  hasStartTime: true,
};

describe("bracketWizardStepGate — mark ready", () => {
  it("blocks leaving the ready step while the event is a draft", () => {
    const gate = bracketWizardStepGate("ready", { ...ready, status: "draft" });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/mark the event ready/i);
  });

  it("clears once the event is ready or already started", () => {
    expect(bracketWizardStepGate("ready", ready).ok).toBe(true);
    expect(
      bracketWizardStepGate("ready", { ...ready, status: "active" }).ok,
    ).toBe(true);
  });
});

describe("bracketWizardStepGate — confirm teams", () => {
  it("blocks with fewer than 2 teams", () => {
    const gate = bracketWizardStepGate("teams", { ...ready, teamCount: 1 });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/at least 2 teams/i);
  });

  it("blocks a doubles event with unpaired teams", () => {
    const gate = bracketWizardStepGate("teams", {
      ...ready,
      isDoubles: true,
      unpairedCount: 2,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/partner/i);
  });

  it("ignores unpaired count for singles", () => {
    expect(
      bracketWizardStepGate("teams", { ...ready, unpairedCount: 3 }).ok,
    ).toBe(true);
  });

  it("blocks when pools have unassigned teams", () => {
    const gate = bracketWizardStepGate("teams", {
      ...ready,
      poolCount: 2,
      unassignedPoolCount: 4,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/pool/i);
  });

  it("clears when every pooled team is assigned", () => {
    expect(
      bracketWizardStepGate("teams", {
        ...ready,
        poolCount: 2,
        unassignedPoolCount: 0,
      }).ok,
    ).toBe(true);
  });
});

describe("bracketWizardStepGate — courts & start time", () => {
  it("court blocks until at least one court is assigned", () => {
    const gate = bracketWizardStepGate("court", {
      ...ready,
      courtsAssignedCount: 0,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/court/i);
  });

  it("court clears once a court is assigned", () => {
    expect(
      bracketWizardStepGate("court", { ...ready, courtsAssignedCount: 1 }).ok,
    ).toBe(true);
  });

  it("starttime blocks until a start is set", () => {
    const gate = bracketWizardStepGate("starttime", {
      ...ready,
      hasStartTime: false,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/start time/i);
  });

  it("starttime clears once a start is set", () => {
    expect(
      bracketWizardStepGate("starttime", { ...ready, hasStartTime: true }).ok,
    ).toBe(true);
  });
});

describe("bracketWizardStepGate — settings & build", () => {
  it("settings always clears (valid defaults)", () => {
    expect(bracketWizardStepGate("settings", ready).ok).toBe(true);
  });

  it("build blocks until games exist", () => {
    const gate = bracketWizardStepGate("build", { ...ready, matchCount: 0 });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/build the bracket/i);
  });

  it("build clears once games are generated", () => {
    expect(bracketWizardStepGate("build", ready).ok).toBe(true);
  });

  it("start is a terminal step and never blocks reaching it", () => {
    expect(bracketWizardStepGate("start", { ...ready, matchCount: 0 }).ok).toBe(
      true,
    );
  });
});

describe("bracketWizardFurthestReachable", () => {
  it("a fresh draft can only see the first step", () => {
    const ctx: BracketWizardContext = {
      status: "draft",
      teamCount: 0,
      isDoubles: false,
      unpairedCount: 0,
      poolCount: 1,
      unassignedPoolCount: 0,
      matchCount: 0,
      courtsAssignedCount: 0,
      hasStartTime: false,
    };
    expect(bracketWizardFurthestReachable(ctx)).toBe(0);
  });

  it("a ready event with teams but no bracket stops at Build", () => {
    const ctx: BracketWizardContext = { ...ready, matchCount: 0 };
    // Steps: ready(0) teams(1) settings(2) build(3) start(4).
    // build is blocked, so the furthest reachable index is build itself.
    const buildIdx = BRACKET_WIZARD_STEPS.findIndex((s) => s.id === "build");
    expect(bracketWizardFurthestReachable(ctx)).toBe(buildIdx);
  });

  it("a fully-built ready event can reach the final step", () => {
    expect(bracketWizardFurthestReachable(ready)).toBe(
      BRACKET_WIZARD_STEPS.length - 1,
    );
  });
});

// The #1005 refactor moves the real, editable settings screen inline
// into the settings step, but the step *order and gating* must not
// change: teams stay confirmed before Build, and the bracket is built
// before Start. These lock that ordering invariant regardless of how the
// settings step renders.
describe("step ordering invariant (#1005 — inline settings)", () => {
  const stepIdx = (id: string) =>
    BRACKET_WIZARD_STEPS.findIndex((s) => s.id === id);

  it("settings sits between teams and build, and build before start", () => {
    expect(stepIdx("teams")).toBeLessThan(stepIdx("settings"));
    expect(stepIdx("settings")).toBeLessThan(stepIdx("build"));
    expect(stepIdx("build")).toBeLessThan(stepIdx("start"));
  });

  it("court then start time sit after settings and before build", () => {
    expect(stepIdx("settings")).toBeLessThan(stepIdx("court"));
    expect(stepIdx("court")).toBeLessThan(stepIdx("starttime"));
    expect(stepIdx("starttime")).toBeLessThan(stepIdx("build"));
  });

  it("an unassigned court blocks reaching Build even with settings settled", () => {
    const ctx: BracketWizardContext = {
      ...ready,
      courtsAssignedCount: 0,
      hasStartTime: false,
      matchCount: 0,
    };
    expect(bracketWizardFurthestReachable(ctx)).toBe(stepIdx("court"));
    expect(bracketWizardStepGate("court", ctx).ok).toBe(false);
  });

  it("unconfirmed teams block reaching the settings step", () => {
    // Doubles event with an unpaired team: the teams gate must fail, so
    // the furthest reachable step is teams itself — settings (and the
    // inline editor it now hosts) stays locked behind it.
    const ctx: BracketWizardContext = {
      ...ready,
      isDoubles: true,
      unpairedCount: 1,
      matchCount: 0,
    };
    expect(bracketWizardFurthestReachable(ctx)).toBe(stepIdx("teams"));
    expect(bracketWizardFurthestReachable(ctx)).toBeLessThan(
      stepIdx("settings"),
    );
  });

  it("an unbuilt bracket blocks reaching Start even with teams settled", () => {
    // A pooled doubles event, fully paired and pool-assigned, but no
    // games yet: reachable up to Build, never Start.
    const ctx: BracketWizardContext = {
      ...ready,
      isDoubles: true,
      unpairedCount: 0,
      poolCount: 2,
      unassignedPoolCount: 0,
      matchCount: 0,
    };
    expect(bracketWizardFurthestReachable(ctx)).toBe(stepIdx("build"));
    expect(bracketWizardStepGate("build", ctx).ok).toBe(false);
  });
});
