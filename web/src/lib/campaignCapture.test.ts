import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({
  rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
}));
vi.mock("../supabase", () => ({ supabase: { rpc } }));
vi.mock("./visitorId", () => ({ getOrCreateVisitorId: () => "visitor-123" }));

import {
  buildCreditLandingHref,
  buildLoginHref,
  captureCampaign,
  captureCampaignParam,
  getCapturedCampaign,
  getCapturedTournamentSlug,
  grantAccountCreditIfEligible,
  recordRecapViewEvent,
  recordSignupEvent,
  resolveTournamentCampaign,
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
      p_tournament_slug: null,
    });
  });

  it("recordSignupEvent swallows RPC failures (best-effort, never blocks signup)", async () => {
    rpc.mockRejectedValueOnce(new Error("network down"));
    captureCampaignParam("?c=leaf-peeper-2026");
    await expect(recordSignupEvent()).resolves.toBeUndefined();
  });

  it("grantAccountCreditIfEligible is a no-op when no campaign was ever captured", async () => {
    await grantAccountCreditIfEligible();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("grantAccountCreditIfEligible fires grant_account_credit once a campaign is captured", async () => {
    captureCampaignParam("?c=leaf-peeper-2026");
    await grantAccountCreditIfEligible();
    expect(rpc).toHaveBeenCalledWith("grant_account_credit", {
      p_campaign: "leaf-peeper-2026",
    });
  });

  it("grantAccountCreditIfEligible swallows RPC failures (best-effort, never blocks signup)", async () => {
    rpc.mockRejectedValueOnce(new Error("network down"));
    captureCampaignParam("?c=leaf-peeper-2026");
    await expect(grantAccountCreditIfEligible()).resolves.toBeUndefined();
  });

  it("recordRecapViewEvent fires record_campaign_event with kind=recap_view for the given campaign", async () => {
    await recordRecapViewEvent("leaf-peeper-2026");
    expect(rpc).toHaveBeenCalledWith("record_campaign_event", {
      p_campaign: "leaf-peeper-2026",
      p_kind: "recap_view",
      p_visitor_id: "visitor-123",
      p_tournament_slug: null,
    });
  });

  // A recap_view row with a NULL tournament_id is readable by service_role
  // ALONE — campaign_events' RLS requires `tournament_id is not null`. The
  // first PROD view row landed that way, so this is pinned.
  it("recordRecapViewEvent stamps the tournament so the row is visible to org admins", async () => {
    await recordRecapViewEvent("leaf-peeper-2026", "2nd-annual-leaf-peeper-tournament");
    expect(rpc).toHaveBeenCalledWith("record_campaign_event", {
      p_campaign: "leaf-peeper-2026",
      p_kind: "recap_view",
      p_visitor_id: "visitor-123",
      p_tournament_slug: "2nd-annual-leaf-peeper-tournament",
    });
  });

  it("recordSignupEvent carries the tournament the campaign was captured on", async () => {
    captureCampaign("leaf-peeper-2026", "2nd-annual-leaf-peeper-tournament");
    await recordSignupEvent();
    expect(rpc).toHaveBeenCalledWith("record_campaign_event", {
      p_campaign: "leaf-peeper-2026",
      p_kind: "signup",
      p_visitor_id: "visitor-123",
      p_tournament_slug: "2nd-annual-leaf-peeper-tournament",
    });
  });

  it("recordRecapViewEvent swallows RPC failures (best-effort, never blocks the recap page)", async () => {
    rpc.mockRejectedValueOnce(new Error("network down"));
    await expect(recordRecapViewEvent("leaf-peeper-2026")).resolves.toBeUndefined();
  });

  // The 2026-10-09 Leaf Peeper send went out with an UNTAGGED recap link, so
  // nothing was measured and nobody could receive the $20. These pin the
  // fallback that recovers it.
  describe("the untagged-link fallback", () => {
    it("captureCampaign persists a campaign that never came from a ?c= param", () => {
      captureCampaign("leaf-peeper-2026", "2nd-annual-leaf-peeper-tournament");
      expect(getCapturedCampaign()).toBe("leaf-peeper-2026");
      expect(getCapturedTournamentSlug()).toBe("2nd-annual-leaf-peeper-tournament");
    });

    it("captureCampaign leaves the tournament unset when it isn't known", () => {
      captureCampaign("leaf-peeper-2026");
      expect(getCapturedCampaign()).toBe("leaf-peeper-2026");
      expect(getCapturedTournamentSlug()).toBeNull();
    });

    it("resolveTournamentCampaign asks the server which campaign is live", async () => {
      rpc.mockResolvedValueOnce({ data: "leaf-peeper-2026", error: null });
      await expect(
        resolveTournamentCampaign("wmpc", "2nd-annual-leaf-peeper-tournament"),
      ).resolves.toBe("leaf-peeper-2026");
      expect(rpc).toHaveBeenCalledWith("public_tournament_campaign", {
        p_org_slug: "wmpc",
        p_tournament_slug: "2nd-annual-leaf-peeper-tournament",
      });
    });

    it("resolveTournamentCampaign returns null when no campaign is live", async () => {
      rpc.mockResolvedValueOnce({ data: null, error: null });
      await expect(resolveTournamentCampaign("wmpc", "some-old-event")).resolves.toBeNull();
    });

    it("resolveTournamentCampaign returns null on an RPC error rather than throwing", async () => {
      rpc.mockResolvedValueOnce({ data: null, error: { message: "nope" } });
      await expect(resolveTournamentCampaign("wmpc", "x")).resolves.toBeNull();
    });

    it("resolveTournamentCampaign returns null when the RPC rejects", async () => {
      rpc.mockRejectedValueOnce(new Error("network down"));
      await expect(resolveTournamentCampaign("wmpc", "x")).resolves.toBeNull();
    });
  });

  describe("buildCreditLandingHref", () => {
    it("carries the campaign tag through hop 1 (recap -> credit landing)", () => {
      expect(buildCreditLandingHref("wmpc", "leaf-peeper-2026")).toBe(
        "/t/wmpc/credit?c=leaf-peeper-2026",
      );
    });

    it("omits ?c= when there is no campaign to carry", () => {
      expect(buildCreditLandingHref("wmpc", null)).toBe("/t/wmpc/credit");
    });
  });

  describe("buildLoginHref", () => {
    it("carries the campaign tag through hop 2 (credit landing -> login)", () => {
      expect(buildLoginHref("leaf-peeper-2026")).toBe(
        "/login?c=leaf-peeper-2026",
      );
    });

    it("omits ?c= when there is no campaign to carry", () => {
      expect(buildLoginHref(null)).toBe("/login");
    });
  });
});
