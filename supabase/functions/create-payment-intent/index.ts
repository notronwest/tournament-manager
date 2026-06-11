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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// @ts-expect-error remote import resolved at runtime by Deno
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

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
      .select("id, organization_id, organizations!inner(slug, stripe_account_id, stripe_account_status)")
      .eq("slug", tournamentSlug)
      .single();
    if (tErr || !tournament) return json({ error: "tournament_not_found" }, 404);

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
    if (totalCents <= 0) return json({ error: "nothing_to_charge" }, 400);

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

    // Idempotency over the exact pending set so a double-click reuses
    // the same intent.
    const regIds = lineItems
      .map((li) => li.event_registration_id)
      .filter(Boolean)
      .sort()
      .join(",");
    const idempotencyKey = `pi:${player.id}:${tournament.id}:${regIds}`;

    // ── 5. Create the PaymentIntent ─────────────────────────────────
    const intent = await stripe.paymentIntents.create(
      {
        amount: totalCents,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        application_fee_amount: platformFeeCents,
        transfer_data: { destination: org.stripe_account_id },
        metadata: {
          player_id: player.id,
          tournament_id: tournament.id,
          coupon_id: couponId ?? "",
          // Sanitised origin for the webhook's partner-invite links (#191).
          base_url: (baseUrl ?? "").replace(/\/+$/, "").slice(0, 200),
        },
      },
      { idempotencyKey },
    );

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
