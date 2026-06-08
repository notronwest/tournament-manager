// web/src/lib/stripe.ts
//
// Singleton Stripe.js loader for the public checkout. The publishable
// key is a build-time env var (VITE_STRIPE_PUBLISHABLE_KEY) — set it in
// web/.env.local and in Cloudflare Pages (Production + Preview).
//
// loadStripe is called once at module load and the promise is reused by
// every <Elements> mount (Stripe's recommended pattern — avoids
// re-instantiating Stripe on each render). When the key is missing the
// promise resolves to null; CheckoutPage detects that and shows a
// configuration message instead of a broken card field.

import { loadStripe, type Stripe } from "@stripe/stripe-js";

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as
  | string
  | undefined;

export const stripeConfigured = Boolean(publishableKey);

export const stripePromise: Promise<Stripe | null> = publishableKey
  ? loadStripe(publishableKey)
  : Promise.resolve(null);
