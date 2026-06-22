// supabase/functions/create-payment-intent/index.ts
//
// SKELETON — drafted for #20 (see docs/STRIPE_CHARGING.md). Ron reviews +
// completes the [DECIDE]/TODO parts before deploy. Money path: do not
// ship without sign-off.
//
// Creates a Stripe Connect *destination charge* PaymentIntent for the
// caller's pending_payment registrations in one tournament, records a
// pending `payments` row + `payment_line_items`, and returns the
// client_secret for the browser's Stripe Payment Element to confirm.
//
// The amount is computed SERVER-SIDE (never trusted from the client) via
// the compute_checkout_total RPC, then optionally reduced by a validated
// coupon. The platform fee + destination account drive the Connect
// split.
//
// Platform fee is read from the platform_settings table (no-code,
// editable by the site super-admin), not from an env var.
//
// Required secrets:
//   STRIPE_SECRET_KEY                  — already set for Connect.
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY
//                                      — auto-injected by the runtime.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "npm:@supabase/supabase-js@2";
// @ts-expect-error remote import resolved at runtime by Deno
import Stripe from "npm:stripe@14.21.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Body = {
  orgSlug: string;
  tournamentSlug: string;
  couponCode?: string;
  // The browser's origin (window.location.origin). Stashed into the
  // PaymentIntent metadata so the webhook — which has no browser
  // context — can build partner-invite accept links pointing back at
  // wherever the player checked out (localhost vs. prod). See #191.
  baseUrl?: string;
};

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // @ts-expect-error Deno env
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      apiVersion: "2024-06-20",
      httpClient: Stripe.createFetchHttpClient(),
    });

    // Service-role client (bypasses RLS for the payments write); auth
    // is verified explicitly from the caller's JWT below.
    const admin = createClient(
      // @ts-expect-error Deno env
      Deno.env.get("SUPABASE_URL")!,
      // @ts-expect-error Deno env
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── 1. Authenticate the caller and resolve their player id ──────
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return json({ error: "unauthorized" }, 401);
    }
    const authUserId = userData.user.id;

    const { orgSlug, tournamentSlug, couponCode, baseUrl } =
      (await req.json()) as Body;

    // Resolve org → tournament. (Pricing is tier-based; tournaments has
    // no entry_fee_cents — the total comes from compute_checkout_total.)
    const { data: tournament, error: tErr } = await admin
      .from("tournaments")
      .select("id, organization_id, status, organizations!inner(slug, stripe_account_id, stripe_account_status)")
      .eq("slug", tournamentSlug)
      .single();
    if (tErr || !tournament) return json({ error: "tournament_not_found" }, 404);

    // Guard: only published tournaments accept payment.
    if (tournament.status !== "published") {
      return json({ error: "tournament_not_accepting_payment" }, 409);
    }

    // @ts-expect-error to-one join shape
    const org = tournament.organizations;
    if (!org?.stripe_account_id || org.stripe_account_status !== "active") {
      return json({ error: "org_stripe_not_active" }, 409);
    }

    // Map auth user → player id.
    const { data: player } = await admin
      .from("players")
      .select("id")
      .eq("auth_user_id", authUserId)
      .single();
    if (!player) return json({ error: "player_not_found" }, 404);

    // ── 2. Authoritative total (server-side) ────────────────────────
    // TODO(Ron): compute_checkout_total RPC must exist (Card A).
    // Returns { total_cents, line_items: [{ event_registration_id,
    // description, amount_cents }] } for this player's pending_payment
    // regs in this tournament (entry fee + per-event tiers).
    const { data: totalRes, error: totalErr } = await admin.rpc(
      "compute_checkout_total",
      { p_player_id: player.id, p_tournament_id: tournament.id },
    );
    if (totalErr || !totalRes) return json({ error: "total_compute_failed" }, 500);

    let totalCents: number = totalRes.total_cents;
    const lineItems: Array<{ event_registration_id: string | null; description: string; amount_cents: number }> =
      totalRes.line_items ?? [];
    // NB: a $0 total is NOT an error here — a tournament with no fees (or a
    // coupon that brings the basket to $0) is a valid FREE registration,
    // handled after the coupon step below. We only reject when there's
    // genuinely nothing in the cart (no regs), checked there.

    // Guard: verify the regs we're about to charge are still pending_payment,
    // not soft-deleted, and belong to this tournament's events. Prevents
    // charging for a reg that was cancelled/withdrawn between page-load and
    // payment-form submit.
    const regIdsToCharge = lineItems
      .map((li) => li.event_registration_id)
      .filter((id): id is string => !!id);
    if (regIdsToCharge.length > 0) {
      const { data: validRegs, error: verifyErr } = await admin
        .from("event_registrations")
        .select("id, events!inner(tournament_id)")
        .in("id", regIdsToCharge)
        .eq("status", "pending_payment")
        .is("deleted_at", null)
        .eq("events.tournament_id", tournament.id);
      if (verifyErr) return json({ error: "reg_verify_failed" }, 500);
      if (!validRegs || validRegs.length !== regIdsToCharge.length) {
        return json({ error: "regs_not_payable" }, 409);
      }
    }

    // ── 3. Optional coupon ──────────────────────────────────────────
    let couponId: string | null = null;
    if (couponCode) {
      const { data: cv } = await admin.rpc("validate_coupon", {
        p_tournament_id: tournament.id,
        p_code: couponCode,
        p_subtotal_cents: totalCents,
      });
      if (cv?.valid) {
        totalCents = Math.max(0, totalCents - (cv.discount_cents ?? 0));
        couponId = cv.coupon_id ?? null;
        lineItems.push({
          event_registration_id: null,
          description: `Coupon ${couponCode}`,
          amount_cents: -(cv.discount_cents ?? 0),
        });
      }
      // Invalid coupon: ignore silently here; the UI validates + shows
      // the error before the user reaches Pay.
    }

    // ── Free registration (no payment) ──────────────────────────────
    // $0 to pay — either the tournament has no fees or a coupon zeroed the
    // basket. There's no Stripe charge and therefore no webhook to flip the
    // regs, so we confirm right here: mark the player's pending regs paid,
    // redeem any coupon, and fire the deferred partner invites — mirroring
    // stripe-webhook's handleSucceeded for the paid path. The total is
    // computed server-side (compute_checkout_total) above, so a client can't
    // forge a free checkout for a paid event.
    if (totalCents <= 0) {
      if (regIdsToCharge.length === 0) {
        return json({ error: "nothing_to_charge" }, 400);
      }
      const { error: flipErr } = await admin
        .from("event_registrations")
        .update({ status: "paid" })
        .in("id", regIdsToCharge)
        .eq("status", "pending_payment");
      if (flipErr) return json({ error: "free_confirm_failed" }, 500);
      if (couponId) await admin.rpc("redeem_coupon", { p_coupon_id: couponId });
      await sendFreeInvites(admin, player.id, regIdsToCharge, baseUrl);
      return json({ confirmed: true, free: true }, 200);
    }

    // ── 4. Platform fee (Connect destination charge) ────────────────
    // Read from the platform_settings singleton (edited no-code by the
    // site super-admin), NOT an env var.
    const { data: settings } = await admin
      .from("platform_settings")
      .select("platform_fee_bps, platform_fee_fixed_cents")
      .eq("id", true)
      .single();
    const feeBps = settings?.platform_fee_bps ?? 0;
    const feeFixed = settings?.platform_fee_fixed_cents ?? 0;
    const platformFeeCents = Math.round((totalCents * feeBps) / 10000) + feeFixed;

    // ── 5. Create or reuse the PaymentIntent ────────────────────────
    // A player can return to checkout with the same pending regs after a
    // prior attempt: a declined card, an abandoned tab, or — in local dev
    // with no webhook — a payment that already SUCCEEDED before the regs
    // flipped to 'paid'. We reuse the existing intent only while Stripe can
    // still collect on it. A terminal intent (succeeded/canceled) or one
    // mid-processing must never be handed back to the browser's Elements,
    // which throws "This PaymentIntent is in a terminal state and cannot be
    // used to initialize Elements".
    //
    // This replaces an earlier *stable* idempotency key: Stripe replays the
    // original response for that key for 24h, so once the first intent went
    // terminal every retry got the same dead intent. Double-click creation
    // is instead guarded client-side (the Pay button disables on submit).
    const metadata = {
      player_id: player.id,
      tournament_id: tournament.id,
      coupon_id: couponId ?? "",
      // Sanitised origin for the webhook's partner-invite links (#191).
      base_url: (baseUrl ?? "").replace(/\/+$/, "").slice(0, 200),
    };
    const REUSABLE_INTENT_STATUSES = new Set([
      "requires_payment_method",
      "requires_confirmation",
      "requires_action",
    ]);

    let intent: { id: string; client_secret: string | null } | null = null;

    // Newest still-pending payment row for this player+tournament points at
    // the intent from their last attempt (if any). In prod the webhook flips
    // it off 'pending' on success, so this only finds genuinely-resumable
    // attempts; in dev it may surface a succeeded intent we then discard.
    const { data: priorPayment } = await admin
      .from("payments")
      .select("stripe_payment_intent_id")
      .eq("player_id", player.id)
      .eq("organization_id", tournament.organization_id)
      .eq("status", "pending")
      .not("stripe_payment_intent_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (priorPayment?.stripe_payment_intent_id) {
      try {
        const existing = await stripe.paymentIntents.retrieve(
          priorPayment.stripe_payment_intent_id,
        );
        if (REUSABLE_INTENT_STATUSES.has(existing.status)) {
          // Resync amount/fee in case the basket or coupon changed since the
          // intent was first created, then reuse its client_secret.
          intent =
            existing.amount !== totalCents ||
            existing.application_fee_amount !== platformFeeCents
              ? await stripe.paymentIntents.update(existing.id, {
                  amount: totalCents,
                  application_fee_amount: platformFeeCents,
                  metadata,
                })
              : existing;
        }
      } catch (_err) {
        // Intent missing or unreadable — fall through and create a fresh one.
      }
    }

    if (!intent) {
      intent = await stripe.paymentIntents.create({
        amount: totalCents,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        application_fee_amount: platformFeeCents,
        transfer_data: { destination: org.stripe_account_id },
        metadata,
      });
    }

    // ── 6. Record the pending payment + line items ──────────────────
    // Upsert on the unique stripe_payment_intent_id so a retried call
    // doesn't duplicate the row.
    const { data: payment, error: payErr } = await admin
      .from("payments")
      .upsert(
        {
          organization_id: tournament.organization_id,
          player_id: player.id,
          stripe_payment_intent_id: intent.id,
          stripe_connected_account_id: org.stripe_account_id,
          amount_cents: totalCents,
          platform_fee_cents: platformFeeCents,
          status: "pending",
        },
        { onConflict: "stripe_payment_intent_id" },
      )
      .select("id")
      .single();
    if (payErr || !payment) return json({ error: "payment_record_failed" }, 500);

    // Replace line items for this payment (idempotent on retry).
    await admin.from("payment_line_items").delete().eq("payment_id", payment.id);
    if (lineItems.length > 0) {
      await admin.from("payment_line_items").insert(
        lineItems.map((li) => ({
          payment_id: payment.id,
          event_registration_id: li.event_registration_id,
          description: li.description,
          amount_cents: li.amount_cents,
        })),
      );
    }

    return json({ clientSecret: intent.client_secret, paymentId: payment.id }, 200);
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Fire the player's pending OUTBOUND partner invites for the events they just
// registered for free. Mirrors stripe-webhook's sendDeferredInvites (which
// handles the paid path) — kept in sync by hand until extracted to a shared
// module. Best-effort: a failed email must not fail the confirmation.
// deno-lint-ignore no-explicit-any
async function sendFreeInvites(
  admin: any,
  inviterPlayerId: string,
  regIds: string[],
  baseUrl?: string,
) {
  if (regIds.length === 0) return;
  const { data: regs } = await admin
    .from("event_registrations")
    .select("event_id")
    .in("id", regIds);
  const eventIds = Array.from(
    new Set((regs ?? []).map((r: { event_id: string }) => r.event_id).filter(Boolean)),
  );
  if (eventIds.length === 0) return;

  const { data: invites } = await admin
    .from("partner_invites")
    .select("id, invitee_email")
    .eq("inviter_player_id", inviterPlayerId)
    .eq("status", "pending")
    .in("event_id", eventIds);

  const base =
    (baseUrl ?? "").replace(/\/+$/, "") || "https://tournament-manager.pages.dev";

  for (const inv of (invites ?? []) as { id: string; invitee_email: string | null }[]) {
    if (isObviouslyFakeEmail(inv.invitee_email)) continue;
    try {
      await admin.functions.invoke("send-partner-invite", {
        body: { inviteId: inv.id, baseUrl: base },
      });
    } catch (_e) {
      // best-effort — confirmation already succeeded
    }
  }
}

function isObviouslyFakeEmail(email: string | null): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return (
    e.endsWith(".test") ||
    e.endsWith("@example.com") ||
    e.endsWith("@example.net") ||
    e.endsWith("@example.org")
  );
}
