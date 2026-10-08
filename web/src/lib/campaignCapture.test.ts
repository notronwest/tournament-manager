import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({
  rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
}));
vi.mock("../supabase", () => ({ supabase: { rpc } }));
vi.mock("./visitorId", () => ({ getOrCreateVisitorId: () => "visitor-123" }));

import {
  captureCampaignParam,
  getCapturedCampaign,
  recordRecapViewEvent,
  recordSignupEvent,
} from "./campaignCapture";

// No jsdom in this project's vitest setup — stub just enough of Storage.
class FakeStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe("campaignCapture", () => {
  let original: Storage | undefined;

  beforeEach(() => {
    rpc.mockClear();
    original = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    (globalThis as { sessionStorage?: Storage }).sessionStorage =
      new FakeStorage() as unknown as Storage;
  });

  afterEach(() => {
    (globalThis as { sessionStorage?: Storage }).sessionStorage = original;
  });

  it("persists ?c=<campaign> for the session", () => {
    captureCampaignParam("?c=leaf-peeper-2026");
    expect(getCapturedCampaign()).toBe("leaf-peeper-2026");
  });

  it("leaves a previously-captured campaign untouched on a page with no ?c=", () => {
    captureCampaignParam("?c=leaf-peeper-2026");
    captureCampaignParam("?foo=bar");
    expect(getCapturedCampaign()).toBe("leaf-peeper-2026");
  });

  it("recordSignupEvent is a no-op when no campaign was ever captured", async () => {
    await recordSignupEvent();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("recordSignupEvent fires record_campaign_event with kind=signup once a campaign is captured", async () => {
    captureCampaignParam("?c=leaf-peeper-2026");
    await recordSignupEvent();
    expect(rpc).toHaveBeenCalledWith("record_campaign_event", {
      p_campaign: "leaf-peeper-2026",
      p_kind: "signup",
      p_visitor_id: "visitor-123",
    });
  });

  it("recordSignupEvent swallows RPC failures (best-effort, never blocks signup)", async () => {
    rpc.mockRejectedValueOnce(new Error("network down"));
    captureCampaignParam("?c=leaf-peeper-2026");
    await expect(recordSignupEvent()).resolves.toBeUndefined();
  });

  it("recordRecapViewEvent fires record_campaign_event with kind=recap_view for the given campaign", async () => {
    await recordRecapViewEvent("leaf-peeper-2026");
    expect(rpc).toHaveBeenCalledWith("record_campaign_event", {
      p_campaign: "leaf-peeper-2026",
      p_kind: "recap_view",
      p_visitor_id: "visitor-123",
    });
  });

  it("recordRecapViewEvent swallows RPC failures (best-effort, never blocks the recap page)", async () => {
    rpc.mockRejectedValueOnce(new Error("network down"));
    await expect(recordRecapViewEvent("leaf-peeper-2026")).resolves.toBeUndefined();
  });
});
