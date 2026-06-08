// supabase/functions/stripe-webhook/index.ts
//
// SKELETON — drafted for #20 (see docs/STRIPE_CHARGING.md). Ron reviews +
// completes before deploy. Money path: do not ship without sign-off.
//
// Stripe's source-of-truth callback. On payment_intent.succeeded it
// confirms the payment, flips the linked pending_payment registrations
// to paid, redeems any coupon, and fires the deferred partner-invite
// emails. On payment_intent.payment_failed it records the failure and
// leaves the regs pending so the player can retry.
//
// IMPORTANT: registration status is flipped ONLY here (Stripe is the
// source of truth), never optimistically in the browser. The handler is
// idempotent — re-delivered events are no-ops.
//
// Required secrets:
//   STRIPE_SECRET_KEY                  — already set.
//   STRIPE_WEBHOOK_SIGNING_SECRET      — new; from the Stripe webhook
//                                        endpoint after first deploy.
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — auto-injected.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// @ts-expect-error remote import resolved at runtime by Deno
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

// @ts-expect-error Deno global
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const admin = createClient(
  // @ts-expect-error Deno env
  Deno.env.get("SUPABASE_URL")!,
  // @ts-expect-error Deno env
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// @ts-expect-error Deno global
Deno.serve(async (req: Request) => {
  // Stripe webhooks are server-to-server; no CORS, no JWT. Auth is the
  // signature check below.
  const sig = req.headers.get("stripe-signature");
  // @ts-expect-error Deno env
  const whSecret = Deno.env.get("STRIPE_WEBHOOK_SIGNING_SECRET")!;
  const raw = await req.text(); // raw body required for signature verify

  let event: any;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, whSecret);
  } catch (e) {
    return new Response(`signature verification failed: ${String(e?.message ?? e)}`, {
      status: 400,
    });
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object;
        await handleSucceeded(pi);
        break;
      }
      case "payment_intent.payment_failed": {
        const pi = event.data.object;
        await admin
          .from("payments")
          .update({
            status: "failed",
            failure_message: pi.last_payment_error?.message ?? "payment failed",
            raw: pi,
          })
          .eq("stripe_payment_intent_id", pi.id)
          .neq("status", "succeeded"); // never downgrade a succeeded payment
        break;
      }
      default:
        // Unhandled event types ack with 200 so Stripe stops retrying.
        break;
    }
    return new Response("ok", { status: 200 });
  } catch (e) {
    // 500 → Stripe retries with backoff (the handler is idempotent).
    return new Response(`handler error: ${String(e?.message ?? e)}`, { status: 500 });
  }
});

async function handleSucceeded(pi: any) {
  // ── Idempotency guard: only act if not already succeeded ──────────
  const { data: payment } = await admin
    .from("payments")
    .select("id, status")
    .eq("stripe_payment_intent_id", pi.id)
    .single();
  if (!payment) return; // intent we didn't create — ignore.
  if (payment.status === "succeeded") return; // already processed.

  // Mark payment succeeded.
  await admin
    .from("payments")
    .update({
      status: "succeeded",
      stripe_charge_id: pi.latest_charge ?? null,
      raw: pi,
    })
    .eq("id", payment.id);

  // ── Flip the paid registrations ───────────────────────────────────
  // Linked via payment_line_items.event_registration_id. Only flip rows
  // still pending_payment (idempotent).
  const { data: lis } = await admin
    .from("payment_line_items")
    .select("event_registration_id")
    .eq("payment_id", payment.id);
  const regIds = (lis ?? [])
    .map((li: any) => li.event_registration_id)
    .filter(Boolean);

  if (regIds.length > 0) {
    await admin
      .from("event_registrations")
      .update({ status: "paid" }) // TODO(Ron): confirm target registration_status value
      .in("id", regIds)
      .eq("status", "pending_payment");
  }

  // ── Redeem coupon (atomic; service_role) ──────────────────────────
  const couponId = pi.metadata?.coupon_id;
  if (couponId) {
    await admin.rpc("redeem_coupon", { p_coupon_id: couponId });
  }

  // ── Deferred partner-invite emails ────────────────────────────────
  // TODO(Ron/Builder Card C): fan out the pending partner invites for
  // these regs here (the send-partner-invite edge fn is already built);
  // this is where CheckoutPage's current at-pay-time email send moves to.
}
