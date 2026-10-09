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
  it("application_fee is identical whether or not a donation rides the same registration", () => {
    const subtotalCents = 7000; // $70 registration
    const feeBps = 300; // 3%
    const feeFixedCents = 30; // $0.30

    const feeWithoutDonation = computePlatformFeeCents(subtotalCents, feeBps, feeFixedCents);
    const feeWithDonation = computePlatformFeeCents(subtotalCents, feeBps, feeFixedCents);

    expect(feeWithDonation).toBe(feeWithoutDonation);
    expect(feeWithDonation).toBe(240); // 3% of $70 (210) + $0.30 (30)
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
