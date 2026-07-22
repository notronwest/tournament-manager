// web/src/lib/stripe.ts
//
// Stripe.js loader for the public checkout. The publishable key is a
// build-time env var (VITE_STRIPE_PUBLISHABLE_KEY) — set it in
// web/.env.local and in Cloudflare Pages (Production + Preview). It is the
// PLATFORM's publishable key; direct charges are scoped to the organizer's
// connected account via the `stripeAccount` option below, NOT a per-org key.
//
// We use Stripe Connect DIRECT charges: each registration/donation
// PaymentIntent is created ON the organizer's connected account, so its
// client_secret is connected-account-scoped. Stripe.js must therefore be
// initialised with { stripeAccount: <connected account id> } to confirm it —
// a plain platform-scoped instance throws "No such payment_intent" against a
// connected-account secret. So instead of one module-level singleton we cache
// one loadStripe() promise PER connected account (Stripe's recommended pattern
// — avoids re-instantiating Stripe on each render, while keeping the accounts
// isolated). When the key is missing the promise resolves to null;
// CheckoutPage/DonatePage detect that and show a configuration message
// instead of a broken card field.

import { loadStripe, type Stripe } from "@stripe/stripe-js";

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as
  | string
  | undefined;

export const stripeConfigured = Boolean(publishableKey);

// One cached Stripe.js promise per connected account id.
const byAccount = new Map<string, Promise<Stripe | null>>();

// Load (and cache) a Stripe.js instance scoped to the organizer's connected
// account for a direct-charge checkout. The connectedAccountId comes back from
// create-payment-intent / create-donation-intent alongside the client secret.
export function getStripeForAccount(
  connectedAccountId: string,
): Promise<Stripe | null> {
  if (!publishableKey || !connectedAccountId) return Promise.resolve(null);
  let p = byAccount.get(connectedAccountId);
  if (!p) {
    p = loadStripe(publishableKey, { stripeAccount: connectedAccountId });
    byAccount.set(connectedAccountId, p);
  }
  return p;
}
