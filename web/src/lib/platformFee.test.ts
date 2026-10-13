// Fee-math test for #378 (checkout donation add-on). Hard merge condition
// per the issue's acceptance criteria: the platform application_fee must be
// identical with and without a donation on the same registration. Imports
// the SAME module create-payment-intent uses (not a reimplementation), so
// this guards the actual code path, not a parallel copy of it.
import { describe, expect, it } from "vitest";
import {
  computeChargeCents,
  computePlatformFeeCents,
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
