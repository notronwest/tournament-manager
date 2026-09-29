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
