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

  // ── Deferred partner-invite emails (#191) ─────────────────────────
  // Relocated here from CheckoutPage so a doubles invite email fires
  // ONLY on a confirmed payment — never for an abandoned/unpaid
  // checkout. Idempotent by construction: handleSucceeded short-circuits
  // above when the payment is already 'succeeded', so a re-delivered
  // webhook never reaches this and can't double-send.
  await sendDeferredInvites(regIds, pi);
}

// Fan out the payer's pending OUTBOUND partner invites for the events
// they just paid for. We match invites by (inviter = payer, event in the
// paid set, status = 'pending'); inbound invites the payer merely
// accepted have a different inviter and are correctly skipped. Email
// composition is unchanged — we just invoke the existing
// send-partner-invite function per invite.
async function sendDeferredInvites(regIds: string[], pi: any) {
  if (regIds.length === 0) return;

  const inviterPlayerId = pi.metadata?.player_id;
  if (!inviterPlayerId) return;

  // Resolve the events covered by this payment's registrations.
  const { data: regs } = await admin
    .from("event_registrations")
    .select("event_id")
    .in("id", regIds);
  const eventIds = Array.from(
    new Set((regs ?? []).map((r: any) => r.event_id).filter(Boolean)),
  );
  if (eventIds.length === 0) return;

  // The payer's still-pending outbound invites for those events.
  const { data: invites } = await admin
    .from("partner_invites")
    .select("id, invitee_email")
    .eq("inviter_player_id", inviterPlayerId)
    .eq("status", "pending")
    .in("event_id", eventIds);

  // Base URL captured at checkout (origin the player paid from), with a
  // prod fallback if an older intent has no base_url in metadata.
  const baseUrl =
    (pi.metadata?.base_url && String(pi.metadata.base_url)) ||
    // @ts-expect-error Deno env
    Deno.env.get("PUBLIC_APP_URL") ||
    "https://tournament-manager.pages.dev";

  for (const inv of invites ?? []) {
    // Mirror CheckoutPage's guard: don't email obviously-fake addresses
    // (seeded test players use .test / example.com).
    if (isObviouslyFakeEmail(inv.invitee_email)) continue;
    try {
      await admin.functions.invoke("send-partner-invite", {
        body: { inviteId: inv.id, baseUrl },
      });
    } catch (e) {
      // Best-effort: a failed invite email must not 500 the webhook (that
      // would make Stripe retry the whole — already-applied — payment).
      console.warn(
        `partner invite ${inv.id} email failed:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}

// Mirrors the helper in CheckoutPage / RegisterPage — keep in sync until
// it's extracted into a shared module.
function isObviouslyFakeEmail(email: string | null): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (e.endsWith(".test")) return true;
  if (
    e.endsWith("@example.com") ||
    e.endsWith("@example.net") ||
    e.endsWith("@example.org")
  ) {
    return true;
  }
  return false;
}
