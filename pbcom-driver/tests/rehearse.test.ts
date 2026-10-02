import { describe, expect, it } from "vitest";
import { rehearsalVerdict } from "../src/rehearse.js";

describe("rehearsalVerdict", () => {
  it("passes when every planned write verified", () => {
    const v = rehearsalVerdict(5, 5);
    expect(v.outcome).toBe("passed");
    expect(v.summary).toContain("all 5 write(s)");
  });
  it("fails when fewer writes verified than planned", () => {
    const v = rehearsalVerdict(5, 3);
    expect(v.outcome).toBe("failed");
    expect(v.summary).toContain("only 3 of 5");
  });
  it("reports nothing-to-do when there were no planned writes", () => {
    const v = rehearsalVerdict(0, 0);
    expect(v.outcome).toBe("nothing_to_do");
  });
  it("treats extra verified (idempotent re-record) as a pass, not a fail", () => {
    expect(rehearsalVerdict(3, 4).outcome).toBe("passed");
  });
});
