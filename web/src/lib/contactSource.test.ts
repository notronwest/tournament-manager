import { describe, expect, it } from "vitest";
import { matchesSource } from "./contactSource";

// Filters overlap: a registrant who was also imported must show under BOTH
// "Registrants" and "Imported" (regression: 26 of 70 Angels registrants were
// hidden from the Registrants filter because the import label won).
describe("matchesSource", () => {
  const importedRegistrant = { source: "import" as const, isRegistrant: true };
  const pureRegistrant = { source: "registrant" as const, isRegistrant: true };
  const pureImport = { source: "import" as const, isRegistrant: false };
  const manualRegistrant = { source: "manual" as const, isRegistrant: true };

  it("'all' matches everyone", () => {
    for (const c of [importedRegistrant, pureRegistrant, pureImport, manualRegistrant]) {
      expect(matchesSource(c, "all")).toBe(true);
    }
  });

  it("'registrant' includes anyone with an active registration, whatever the label", () => {
    expect(matchesSource(importedRegistrant, "registrant")).toBe(true);
    expect(matchesSource(manualRegistrant, "registrant")).toBe(true);
    expect(matchesSource(pureRegistrant, "registrant")).toBe(true);
    expect(matchesSource(pureImport, "registrant")).toBe(false);
  });

  it("'import' / 'manual' go by how the link was created", () => {
    expect(matchesSource(importedRegistrant, "import")).toBe(true);
    expect(matchesSource(pureImport, "import")).toBe(true);
    expect(matchesSource(pureRegistrant, "import")).toBe(false);
    expect(matchesSource(manualRegistrant, "manual")).toBe(true);
    expect(matchesSource(importedRegistrant, "manual")).toBe(false);
  });
});
