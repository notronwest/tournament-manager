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
