import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL = join(import.meta.dirname, "..", "install.sh");

describe("install.sh release-clone guard", () => {
  it("refuses to run outside the release clone, before touching anything", () => {
    const home = mkdtempSync(join(tmpdir(), "pbcom-home-"));
    const res = spawnSync("bash", [INSTALL], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("REFUSING");
    // Refused before step 1: no LaunchAgents dir was created under the fake HOME.
    expect(spawnSync("ls", [join(home, "Library")]).status).not.toBe(0);
  });

  it("refuses from a copy that is not the release path even if the release dir exists", () => {
    const home = mkdtempSync(join(tmpdir(), "pbcom-home-"));
    mkdirSync(join(home, "data/web/wmpc/releases/tournament-manager/pbcom-driver"), { recursive: true });
    const other = mkdtempSync(join(tmpdir(), "pbcom-other-"));
    copyFileSync(INSTALL, join(other, "install.sh"));
    const res = spawnSync("bash", [join(other, "install.sh")], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("REFUSING");
  });
});
