import { describe, expect, it } from "vitest";
import {
  buildPreflightReport,
  preflightClear,
  countByStatus,
  type PreflightInput,
} from "../src/preflight.js";

function base(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    baseUrl: "https://pickleballbrackets.com",
    hasServiceRole: true,
    hasUsername: true,
    bindingOk: true,
    eid: "d2a71179",
    beDivisions: [
      { label: "Mens Doubles Skill: (3.0 To 3.49)", regCount: 6, teamCount: 3, seekingDoubles: 0 },
    ],
    pbcomEntryCounts: new Map([["Mens Doubles Skill: (3.0 To 3.49)", 6]]),
    sessionAuthenticated: true,
    surnameCollisions: [],
    bracketProbes: null,
    ...overrides,
  };
}

const find = (checks: ReturnType<typeof buildPreflightReport>, name: string) =>
  checks.find((c) => c.name === name);

describe("buildPreflightReport — config", () => {
  it("passes when everything is present", () => {
    expect(find(buildPreflightReport(base()), "config")!.status).toBe("pass");
  });
  it("fails and names what's missing", () => {
    const c = find(buildPreflightReport(base({ hasServiceRole: false, eid: null })), "config")!;
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(c.detail).toContain("tournament→eid");
  });
});

describe("buildPreflightReport — base URL", () => {
  it("passes on the live host", () => {
    expect(find(buildPreflightReport(base()), "base-url")!.status).toBe("pass");
  });
  it("fails on a non-live host (the training-site trap)", () => {
    const c = find(buildPreflightReport(base({ baseUrl: "https://train.pickleballbrackets.dev" })), "base-url")!;
    expect(c.status).toBe("fail");
  });
  it("warns when unset", () => {
    expect(find(buildPreflightReport(base({ baseUrl: undefined })), "base-url")!.status).toBe("warn");
  });
});

describe("buildPreflightReport — auth", () => {
  it("fails on an un-authenticated live session", () => {
    expect(find(buildPreflightReport(base({ sessionAuthenticated: false })), "auth")!.status).toBe("fail");
  });
  it("warns when not checked (DB-only)", () => {
    expect(find(buildPreflightReport(base({ sessionAuthenticated: null })), "auth")!.status).toBe("warn");
  });
});

describe("buildPreflightReport — roster match (the heart)", () => {
  it("passes when counts line up", () => {
    expect(find(buildPreflightReport(base()), "roster:Mens Doubles Skill: (3.0 To 3.49)")!.status).toBe("pass");
  });
  it("fails on a count mismatch", () => {
    const c = find(
      buildPreflightReport(base({ pbcomEntryCounts: new Map([["Mens Doubles Skill: (3.0 To 3.49)", 4]]) })),
      "roster:Mens Doubles Skill: (3.0 To 3.49)",
    )!;
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("B&E 6 vs PB.com 4");
  });
  it("fails when a B&E division has no PB.com match (binding/label error)", () => {
    const c = find(buildPreflightReport(base({ pbcomEntryCounts: new Map([["Womens Doubles 3.0", 8]]) })), "roster:Mens Doubles Skill: (3.0 To 3.49)")!;
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("NO division matching");
  });
  it("matches case/whitespace-insensitively", () => {
    const c = find(
      buildPreflightReport(base({ pbcomEntryCounts: new Map([["mens doubles skill:  (3.0 to 3.49)", 6]]) })),
      "roster:Mens Doubles Skill: (3.0 To 3.49)",
    )!;
    expect(c.status).toBe("pass");
  });
  it("warns about a PB.com division B&E never imported", () => {
    const checks = buildPreflightReport(base({
      pbcomEntryCounts: new Map([
        ["Mens Doubles Skill: (3.0 To 3.49)", 6],
        ["Coed Doubles Skill: (Any)", 24],
      ]),
    }));
    const extra = checks.find((c) => c.name.includes("Coed"));
    expect(extra!.status).toBe("warn");
    expect(extra!.detail).toContain("no matching division");
  });
  it("warns when the scrape wasn't run", () => {
    expect(find(buildPreflightReport(base({ pbcomEntryCounts: null })), "roster")!.status).toBe("warn");
  });
});

describe("buildPreflightReport — partner linkage", () => {
  it("passes when nothing is seeking", () => {
    expect(find(buildPreflightReport(base()), "partner-linkage")!.status).toBe("pass");
  });
  it("warns when doubles are still seeking", () => {
    const d = base({ beDivisions: [{ label: "Mens Doubles Skill: (3.0 To 3.49)", regCount: 6, teamCount: 3, seekingDoubles: 2 }] });
    const c = find(buildPreflightReport(d), "partner-linkage")!;
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("2 doubles");
  });
});

describe("buildPreflightReport — surname collisions", () => {
  it("passes when none found", () => {
    expect(find(buildPreflightReport(base()), "surname-collisions")!.status).toBe("pass");
  });
  it("warns per colliding division (does not fail — the push flags, never mis-writes)", () => {
    const checks = buildPreflightReport(base({ surnameCollisions: [{ label: "Mens Doubles 3.0", matches: 2 }] }));
    const c = checks.find((x) => x.name.startsWith("surname-collision:"))!;
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("2 match(es)");
    expect(preflightClear(checks)).toBe(true); // a warn never blocks
  });
  it("omits the check when not computed (null)", () => {
    const checks = buildPreflightReport(base({ surnameCollisions: null }));
    expect(checks.some((c) => c.name.startsWith("surname-collision"))).toBe(false);
  });
});

describe("buildPreflightReport — live score-surface probe", () => {
  const L = "Mens Doubles Skill: (3.0 To 3.49)";
  it("passes when the live score page parses the right number of rows", () => {
    const c = find(buildPreflightReport(base({ bracketProbes: [{ label: L, reachable: true, rows: 10, expectedMatches: 10 }] })), `score-page:${L}`)!;
    expect(c.status).toBe("pass");
  });
  it("warns (never fails) when the division isn't Running yet — the normal pre-event state", () => {
    const checks = buildPreflightReport({ ...base(), bracketProbes: [{ label: L, reachable: false, rows: 0, expectedMatches: 10 }] });
    const c = checks.find((x) => x.name === `score-page:${L}`)!;
    expect(c.status).toBe("warn");
    expect(preflightClear(checks)).toBe(true); // pre-event probe never blocks
  });
  it("warns on a row-count mismatch (bracket differs)", () => {
    const c = find(buildPreflightReport(base({ bracketProbes: [{ label: L, reachable: true, rows: 8, expectedMatches: 10 }] })), `score-page:${L}`)!;
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("8 match row(s), B&E has 10");
  });
  it("omits the check when not probed (null)", () => {
    expect(buildPreflightReport(base({ bracketProbes: null })).some((c) => c.name.startsWith("score-page"))).toBe(false);
  });
});

describe("preflightClear / countByStatus", () => {
  it("is clear with only passes and warns, blocked by any fail", () => {
    expect(preflightClear(buildPreflightReport(base()))).toBe(true);
    expect(preflightClear(buildPreflightReport(base({ hasServiceRole: false })))).toBe(false);
  });
  it("counts statuses", () => {
    const counts = countByStatus(buildPreflightReport(base()));
    expect(counts.fail).toBe(0);
    expect(counts.pass).toBeGreaterThan(0);
  });
});
