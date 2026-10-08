import { afterEach, describe, expect, it, vi } from "vitest";
import { isCreditOfferEnabled } from "./featureFlags";

describe("isCreditOfferEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off when VITE_CREDIT_OFFER is unset", () => {
    vi.stubEnv("VITE_CREDIT_OFFER", undefined);
    expect(isCreditOfferEnabled()).toBe(false);
  });

  it("is off for any value other than 'true'", () => {
    vi.stubEnv("VITE_CREDIT_OFFER", "1");
    expect(isCreditOfferEnabled()).toBe(false);
  });

  it("is on when VITE_CREDIT_OFFER=true", () => {
    vi.stubEnv("VITE_CREDIT_OFFER", "true");
    expect(isCreditOfferEnabled()).toBe(true);
  });

  it("is case/whitespace tolerant", () => {
    vi.stubEnv("VITE_CREDIT_OFFER", "  TRUE  ");
    expect(isCreditOfferEnabled()).toBe(true);
  });
});
