// supabase/functions/_shared/platformFee.ts
//
// Pure helpers for create-payment-intent's money math (#378). Pulled out so
// the fee invariant required by #378's acceptance criteria — the platform
// application_fee never changes because of an at-checkout donation — has a
// single implementation the test and the edge function both call, instead of
// two copies that could drift.

// The platform's cut of a Connect direct charge. ALWAYS computed on the
// registration subtotal — callers must never pass a donation-inclusive
// amount in here, or the donation portion would be taxed too.
export function computePlatformFeeCents(
  subtotalCents: number,
  feeBps: number,
  feeFixedCents: number,
): number {
  return Math.round((subtotalCents * feeBps) / 10000) + feeFixedCents;
}

// The amount actually charged via Stripe: registration subtotal plus any
// at-checkout donation add-on. The donation can only ever add — a negative
// or missing donation contributes nothing.
export function computeChargeCents(
  subtotalCents: number,
  donationCents: number,
): number {
  return subtotalCents + Math.max(0, Math.trunc(donationCents) || 0);
}

// ── Three-level fee resolution ────────────────────────────────────────────
//
// A platform fee can be set at three levels; the most specific one that is
// set wins. Both columns of a level are set together (a DB check constraint
// enforces both-or-neither), so a level is "set" when its bps is non-null.
//
//   tournament override  →  organization override  →  global default
//
// This is the ONLY implementation of that precedence: create-payment-intent
// charges with it and the platform-fee admin UI previews with it, so the
// number an admin sees is the number Stripe gets.

export type PlatformFeeSource = "tournament" | "organization" | "default";

export type PlatformFeeLevel = {
  platform_fee_bps: number | null;
  platform_fee_fixed_cents: number | null;
} | null | undefined;

export type ResolvedPlatformFee = {
  feeBps: number;
  feeFixedCents: number;
  // Which level supplied the number — drives the "Custom" / "Inherited"
  // labelling in the admin UI and the audit trail on the payment.
  source: PlatformFeeSource;
};

export function resolvePlatformFee(
  tournament: PlatformFeeLevel,
  organization: PlatformFeeLevel,
  platformDefault: PlatformFeeLevel,
): ResolvedPlatformFee {
  if (
    tournament?.platform_fee_bps !== null &&
    tournament?.platform_fee_bps !== undefined &&
    tournament.platform_fee_fixed_cents !== null &&
    tournament.platform_fee_fixed_cents !== undefined
  ) {
    return {
      feeBps: tournament.platform_fee_bps,
      feeFixedCents: tournament.platform_fee_fixed_cents,
      source: "tournament",
    };
  }
  if (
    organization?.platform_fee_bps !== null &&
    organization?.platform_fee_bps !== undefined &&
    organization.platform_fee_fixed_cents !== null &&
    organization.platform_fee_fixed_cents !== undefined
  ) {
    return {
      feeBps: organization.platform_fee_bps,
      feeFixedCents: organization.platform_fee_fixed_cents,
      source: "organization",
    };
  }
  return {
    feeBps: platformDefault?.platform_fee_bps ?? 0,
    feeFixedCents: platformDefault?.platform_fee_fixed_cents ?? 0,
    source: "default",
  };
}
