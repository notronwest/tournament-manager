# Stripe charging design (#20)

Status: **DRAFT for Ron's review.** Decisions marked **[DECIDE]** are
money/infra calls that must be signed off before the Builder touches any
charging code. Everything else is the proposed architecture.

## What already exists (don't rebuild)

- **Connect onboarding**: `stripe-connect-onboarding`,
  `stripe-connect-oauth-callback`, `stripe-account-status-refresh` edge
  functions. `organizations.stripe_account_id` +
  `stripe_account_status` (`not_connected|pending|active|restricted`).
- **Schema**: `payments` (with `stripe_payment_intent_id` UNIQUE,
  `stripe_charge_id`, `stripe_connected_account_id`, `amount_cents`,
  `platform_fee_cents`, `status payment_status`, `failure_message`,
  `raw jsonb`) and `payment_line_items` (per entry-fee / per-event row).
  Writes are server-only (no client INSERT policy).
- **`payment_status` enum**: `pending, processing, succeeded, failed,
  refunded, partially_refunded`.
- **Checkout UI**: `CheckoutPage.onPay` currently flips each
  `pending_payment` `event_registration` → paid directly (no Stripe).
  Comments already mark where the PaymentIntent + webhook slot in.
- **`sweep-stale-pending-regs`**: reaps abandoned pending regs.

## The locked decision (CLAUDE.md #4)

Stripe **Connect destination charges**: each org connects its own
Stripe account; we charge on the platform account with
`transfer_data.destination = <org account>` and take
`application_fee_amount`. Not separate-charges-and-transfers.

## Architecture: server-creates-intent + client-confirms

Pure client-side intent creation is rejected because the **amount must
be authoritative** (entry + per-event tiers + coupons) and we need
`application_fee_amount` + `transfer_data.destination` + idempotency.
So the server creates the PaymentIntent; the browser only confirms it
with the Payment Element.

```
CheckoutPage  ──POST {orgSlug, tournamentSlug, couponCode?}──▶  create-payment-intent (edge fn)
                                                                  │ auth = player JWT
                                                                  │ compute authoritative total (RPC)
                                                                  │ apply coupon (validate_coupon)
                                                                  │ create PaymentIntent (destination + fee)
                                                                  │ upsert payments(pending) + line_items
   ◀────────────── { clientSecret, paymentId } ─────────────────┘
   │
   │ stripe.confirmPayment(Payment Element)
   ▼
 Stripe ──webhook payment_intent.succeeded──▶ stripe-webhook (edge fn)
                                                │ verify signature
                                                │ payments → succeeded (+ charge id) [idempotent]
                                                │ flip linked event_registrations → paid
                                                │ redeem_coupon(coupon_id)
                                                │ fire deferred partner-invite emails
```

### Why the total is computed server-side

The client cannot be trusted to send the amount. Two options:

- **(A) [RECOMMENDED] A SECURITY DEFINER RPC** `compute_checkout_total(p_player_id, p_tournament_id)`
  returning `{ total_cents, line_items[] }` from the player's
  `pending_payment` regs + the tournament entry fee + active pricing
  tiers. One authority, reused by both the edge fn and (optionally) the
  UI preview. Mirrors `web/src/lib/pricing.ts` logic in SQL.
- (B) Port `pricing.ts` into the edge function (TS duplication, drift
  risk).

Recommend (A). It's a Ron-written RPC (Card A) since it's
SECURITY DEFINER.

## Idempotency & correctness

- `payments.stripe_payment_intent_id` is UNIQUE → at most one payment
  row per intent. `create-payment-intent` uses a Stripe
  **Idempotency-Key** derived from `(player_id, tournament_id, sorted
  pending reg ids)` so a double-click reuses the same intent.
- The webhook is **idempotent**: it only transitions
  `payments.status` and flips regs **if not already done** (guard on
  current status). Re-delivered events are no-ops.
- Reg status flip happens **only in the webhook** (source of truth =
  Stripe), never optimistically in the browser.
- A failed/abandoned payment leaves regs in `pending_payment`;
  `sweep-stale-pending-regs` already handles the long tail.

## Decisions (RESOLVED 2026-06-08)

1. **Platform fee — no-code admin setting.** Stored in the
   `platform_settings` singleton table (`platform_fee_bps` +
   `platform_fee_fixed_cents`), editable by the site super-admin via a
   platform settings UI — NOT an env var. The edge function reads it via
   service_role. `application_fee_amount = round(total * bps / 10000) +
   fixed`. Migration drafted: `20260608130000_platform_settings.sql`
   (adds the table + an `is_platform_admin()` helper). UI tracked as a
   separate Builder story.
2. **Charging path: Payment Element (in-page).** Confirmed. Not Stripe
   Checkout hosted pages.
3. **Secrets** (Ron sets):
   - `STRIPE_SECRET_KEY` — already set for Connect.
   - `STRIPE_WEBHOOK_SIGNING_SECRET` — Stripe Dashboard → Developers →
     Webhooks → (the endpoint you create in step 4) → "Signing secret"
     (`whsec_…`). Set via `supabase secrets set STRIPE_WEBHOOK_SIGNING_SECRET=whsec_…`.
   - `VITE_STRIPE_PUBLISHABLE_KEY` — Stripe Dashboard → Developers →
     API keys → "Publishable key" (`pk_test_…`/`pk_live_…`). Goes in
     `web/.env.local` AND Cloudflare Pages env (Production + Preview).
4. **Webhook registration** — after deploying `stripe-webhook`, add an
   endpoint in Stripe → Developers → Webhooks → "Add endpoint":
   - URL: `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`
   - Events: `payment_intent.succeeded`, `payment_intent.payment_failed`
   - Then copy the endpoint's signing secret into the secret above.
5. **`compute_checkout_total` RPC** — approved (option A). Ron writes it
   (SECURITY DEFINER). Tracked in **Card A**.

## Proposed sub-story split

- **Card A (Ron)** — write + apply `compute_checkout_total` RPC; write +
  deploy `create-payment-intent` and `stripe-webhook` edge functions
  (skeletons drafted in `supabase/functions/`); set secrets; register
  the webhook endpoint. *Money + server-only + SECURITY DEFINER = Ron.*
- **Card B (Builder)** — wire `CheckoutPage`: replace the direct
  status-flip in `onPay` with a call to `create-payment-intent`, mount
  the Stripe Payment Element with the returned `clientSecret`, call
  `confirmPayment`, and show a "payment processing → confirmed" state
  driven by polling the reg status (which the webhook flips). No money
  logic in the client.
- **Card C (Builder)** — payment result/receipt UX: success +
  failure/retry states, the line-item breakdown from
  `payment_line_items`, and the deferred partner-invite email trigger
  moving behind the webhook.
- **(Unblocks #22 & #30)** — once Card A's edge functions exist, the
  refund function (#22) and coupon discount wiring (#30) build on the
  same pattern.
