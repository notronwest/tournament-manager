import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  BindingError,
  loadBinding,
  parseBinding,
  resolveDivisionTarget,
  resolveEventBinding,
} from "../src/binding.js";
import type { BandeDivision, BindingConfig } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(HERE, "fixtures", "binding.example.json");

const cfg: BindingConfig = {
  version: 1,
  events: [
    {
      tournamentId: "t-1",
      pbcomEid: "555",
      divisions: [{ sourceDivisionLabel: "Mens Doubles Skill: (3.0 To 3.49)", pbcomDivisionId: "div-9" }],
    },
  ],
};

function division(p: Partial<BandeDivision> = {}): BandeDivision {
  return {
    eventId: "e-1",
    tournamentId: "t-1",
    name: "MD 3.0",
    sourceSystem: "pbcom",
    sourceDivisionLabel: "Mens Doubles Skill: (3.0 To 3.49)",
    format: "doubles",
    gender: "men",
    bracketType: "round_robin",
    teamsAdvancingToPlayoff: 0,
    playoffRounds: 1,
    ...p,
  };
}

describe("parseBinding", () => {
  it("accepts a valid v1 config", () => {
    expect(parseBinding(cfg).events).toHaveLength(1);
  });
  it("rejects a wrong version", () => {
    expect(() => parseBinding({ version: 2, events: [] })).toThrow(BindingError);
  });
  it("rejects an entry missing pbcomEid", () => {
    expect(() => parseBinding({ version: 1, events: [{ tournamentId: "x" }] })).toThrow(BindingError);
  });
  it("rejects duplicate tournament bindings", () => {
    expect(() =>
      parseBinding({ version: 1, events: [{ tournamentId: "x", pbcomEid: "1" }, { tournamentId: "x", pbcomEid: "2" }] }),
    ).toThrow(BindingError);
  });
  it("loads + validates the example fixture from disk", () => {
    const loaded = loadBinding(EXAMPLE);
    expect(loaded.events[0]!.pbcomEid).toBe("123456");
  });
});

describe("resolveEventBinding", () => {
  it("finds the binding for a tournament", () => {
    expect(resolveEventBinding(cfg, "t-1").pbcomEid).toBe("555");
  });
  it("throws for an unmapped tournament", () => {
    expect(() => resolveEventBinding(cfg, "nope")).toThrow(BindingError);
  });
});

describe("resolveDivisionTarget", () => {
  it("maps a pbcom-sourced division by label and honors the pinned id", () => {
    const target = resolveDivisionTarget(cfg.events[0]!, division());
    expect(target.pbcomEid).toBe("555");
    expect(target.divisionLabel).toBe("Mens Doubles Skill: (3.0 To 3.49)");
    expect(target.pbcomDivisionId).toBe("div-9");
  });
  it("matches the override case/space-insensitively", () => {
    const target = resolveDivisionTarget(cfg.events[0]!, division({ sourceDivisionLabel: "mens doubles skill:  (3.0 to 3.49)" }));
    expect(target.pbcomDivisionId).toBe("div-9");
  });
  it("returns a null pbcomDivisionId when no override is pinned", () => {
    const bare = { tournamentId: "t-1", pbcomEid: "555" };
    expect(resolveDivisionTarget(bare, division()).pbcomDivisionId).toBeNull();
  });
  it("refuses a division that is not PB.com-sourced", () => {
    expect(() => resolveDivisionTarget(cfg.events[0]!, division({ sourceSystem: null, sourceDivisionLabel: null }))).toThrow(BindingError);
  });
});
