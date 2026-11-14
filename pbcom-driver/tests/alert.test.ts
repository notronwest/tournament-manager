import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alertPayload, DiscordAlerter } from "../src/alert.js";

describe("DiscordAlerter quiet flag (D-0308)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("payload carries flags 4096 and no-mention parsing", () => {
    const p = alertPayload("hi");
    expect(p.content).toBe("hi");
    expect(p.flags & 4096).toBe(4096);
    expect(p.flags).toBe(4096);
    expect(p.allowed_mentions).toEqual({ parse: [] });
  });

  it("the outgoing POST body carries the flag", async () => {
    const kind = `quiet-test-${Date.now()}`;
    const fetchStub = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchStub);
    await new DiscordAlerter("https://example.invalid/hook").send(kind, "lapsed session");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchStub.mock.calls[0]![1] as { body: string }).body);
    expect(body.flags).toBe(4096);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    rmSync(new URL(`../state/alerts/alerted-${kind}`, import.meta.url), { force: true });
  });
});
