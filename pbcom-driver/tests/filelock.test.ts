import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLock } from "../src/push/run.js";

const dir = mkdtempSync(join(tmpdir(), "pbcom-lock-"));
const lockPath = () => join(dir, "pbcom-push.lock");
afterEach(() => rmSync(lockPath(), { force: true }));

describe("FileLock", () => {
  it("acquires when free, and a second acquire by a live holder fails", () => {
    const a = new FileLock(lockPath());
    expect(a.acquire()).toBe(true); // writes THIS process's (live) pid
    const b = new FileLock(lockPath());
    expect(b.acquire()).toBe(false); // holder (us) is alive → yield
    a.release();
    expect(existsSync(lockPath())).toBe(false);
  });

  it("reclaims a STALE lock whose recorded PID is dead (crashed/Ctrl-C'd run)", () => {
    writeFileSync(lockPath(), "999999\n"); // a PID that isn't running
    const lock = new FileLock(lockPath());
    expect(lock.acquire()).toBe(true); // self-heals instead of wedging forever
    lock.release();
  });

  it("reclaims an empty/garbage lock file", () => {
    writeFileSync(lockPath(), "not-a-pid");
    expect(new FileLock(lockPath()).acquire()).toBe(true);
  });
});
