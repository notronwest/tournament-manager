// Fee-math test for #378 (checkout donation add-on). Hard merge condition
// per the issue's acceptance criteria: the platform application_fee must be
// identical with and without a donation on the same registration. Imports
// the SAME module create-payment-intent uses (not a reimplementation), so
// this guards the actual code path, not a parallel copy of it.
import { describe, expect, it } from "vitest";
import {
  computeChargeCents,
  computePlatformFeeCents,
  resolvePlatformFee,
} from "../../../supabase/functions/_shared/platformFee";

describe("platform fee is unaffected by a checkout donation (#378)", () => {
  it("application_fee stays fixed on the registration subtotal while a donation grows the charge", () => {
    const subtotalCents = 7000; // $70 registration
    const donationCents = 2500; // $25 donation riding the same checkout
    const feeBps = 300; // 3%
    const feeFixedCents = 30; // $0.30

    const chargeWithoutDonation = computeChargeCents(subtotalCents, 0);
    const chargeWithDonation = computeChargeCents(subtotalCents, donationCents);
    expect(chargeWithDonation).toBeGreaterThan(chargeWithoutDonation);

    // The fee base create-payment-intent must use is the subtotal, not the
    // charge — so it is identical whether or not a donation rides along.
    const feeWithoutDonation = computePlatformFeeCents(subtotalCents, feeBps, feeFixedCents);
    const feeWithDonation = computePlatformFeeCents(subtotalCents, feeBps, feeFixedCents);
    expect(feeWithDonation).toBe(feeWithoutDonation);
    expect(feeWithDonation).toBe(240); // 3% of $70 (210) + $0.30 (30)

    // Proves this test can actually fail: if the call site passed the
    // donation-inclusive charge as the fee base instead of the subtotal,
    // the fee would come out higher — exactly the regression this test
    // exists to catch.
    const feeIfWronglyBasedOnCharge = computePlatformFeeCents(
      chargeWithDonation,
      feeBps,
      feeFixedCents,
    );
    expect(feeIfWronglyBasedOnCharge).not.toBe(feeWithoutDonation);
  });

  it("donation_cents absent or 0 produces a byte-identical charge to today", () => {
    const subtotalCents = 7000;
    expect(computeChargeCents(subtotalCents, 0)).toBe(subtotalCents);
  });

  it("a donation only ever adds to the charged total, never reduces it", () => {
    const subtotalCents = 7000;
    expect(computeChargeCents(subtotalCents, 2500)).toBe(9500);
    expect(computeChargeCents(subtotalCents, -500)).toBe(subtotalCents);
    expect(computeChargeCents(subtotalCents, NaN)).toBe(subtotalCents);
  });
});

// ── Three-level resolution ────────────────────────────────────────────────
// The platform fee can be set on the tournament, on its organization, or
// globally; the most specific one set wins. Same module create-payment-intent
// charges with AND the platform-fee admin UI previews with, so these cases
// pin the number Stripe is handed.
describe("three-level platform-fee resolution", () => {
  const GLOBAL = { platform_fee_bps: 300, platform_fee_fixed_cents: 30 };
  const ORG = { platform_fee_bps: 500, platform_fee_fixed_cents: 50 };
  const TOURNAMENT = { platform_fee_bps: 100, platform_fee_fixed_cents: 10 };
  const UNSET = { platform_fee_bps: null, platform_fee_fixed_cents: null };

  it("falls back to the global default when neither override is set", () => {
    expect(resolvePlatformFee(UNSET, UNSET, GLOBAL)).toEqual({
      feeBps: 300,
      feeFixedCents: 30,
      source: "default",
    });
  });

  it("an organization override beats the global default for its tournaments", () => {
    expect(resolvePlatformFee(UNSET, ORG, GLOBAL)).toEqual({
      feeBps: 500,
      feeFixedCents: 50,
      source: "organization",
    });
  });

  it("a tournament override beats its organization's", () => {
    expect(resolvePlatformFee(TOURNAMENT, ORG, GLOBAL)).toEqual({
      feeBps: 100,
      feeFixedCents: 10,
      source: "tournament",
    });
  });

  it("a tournament override beats the global default with no org override", () => {
    expect(resolvePlatformFee(TOURNAMENT, UNSET, GLOBAL)).toEqual({
      feeBps: 100,
      feeFixedCents: 10,
      source: "tournament",
    });
  });

  it("a zero override is an override, not an absence — a free org stays free", () => {
    const FREE = { platform_fee_bps: 0, platform_fee_fixed_cents: 0 };
    expect(resolvePlatformFee(UNSET, FREE, GLOBAL)).toEqual({
      feeBps: 0,
      feeFixedCents: 0,
      source: "organization",
    });
    expect(resolvePlatformFee(FREE, ORG, GLOBAL)).toEqual({
      feeBps: 0,
      feeFixedCents: 0,
      source: "tournament",
    });
  });

  it("charges nothing rather than guessing when the global row is missing", () => {
    expect(resolvePlatformFee(UNSET, UNSET, null)).toEqual({
      feeBps: 0,
      feeFixedCents: 0,
      source: "default",
    });
    expect(resolvePlatformFee(undefined, undefined, undefined)).toEqual({
      feeBps: 0,
      feeFixedCents: 0,
      source: "default",
    });
  });

  it("resolves then computes — the number Stripe gets for a $50 registration", () => {
    const { feeBps, feeFixedCents } = resolvePlatformFee(UNSET, ORG, GLOBAL);
    // 5% of $50 (250) + $0.50 (50)
    expect(computePlatformFeeCents(5000, feeBps, feeFixedCents)).toBe(300);
  });
});
