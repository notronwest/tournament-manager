// supabase/functions/create-donation-intent/index.ts
//
// Charity donations P1 (#377). Creates a Stripe Connect *direct charge*
// PaymentIntent for an ANONYMOUS public donation to a tournament's
// organizer, records a pending `donations` row, and returns the
// client_secret (+ the organizer's connected account id) for the browser's
// Stripe Payment Element to confirm.
//
// DIRECT charge (not destination): the intent is created ON the organizer's
// connected account, so the donation settles straight into their balance and
// never touches the platform's. The browser must init Stripe.js with the
// returned connectedAccountId to confirm the connected-account-scoped secret.
//
// Mirrors create-payment-intent, with three deliberate differences:
//   1. ANONYMOUS — no JWT (verify_jwt = false in config.toml). Anyone can
//      donate without an account; we collect name + email for the receipt.
//   2. NO application_fee — 100% of the donation (minus Stripe's own
//      processing fee) goes to the organizer's connected account. The
//      platform takes nothing on donations (registration fees still do).
//   3. Amount comes from the client but is BOUNDS-CHECKED server-side
//      ($1..$100k). It is never used to compute a platform cut, so there is
//      no trust placed in it beyond min/max + integer validation.
//
// The webhook (stripe-webhook) marks the donation paid/failed/refunded —
// routed by metadata.type = "donation". This function only writes the
// pending row.
//
// Required secrets (all already set — no new secret):
//   STRIPE_SECRET_KEY                  — already set for Connect.
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — auto-injected by the runtime.

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

// Server-side amount bounds (cents). Min $1 guards against $0/negative;
// max $100k is a sanity ceiling for a single card donation.
const MIN_DONATION_CENTS = 100;
const MAX_DONATION_CENTS = 100_000_00;

type Body = {
  orgSlug: string;
  tournamentSlug: string;
  amountCents: number;
  donorName: string;
  donorEmail: string;
  message?: string;
  // The browser's origin (window.location.origin), stashed in metadata for
  // parity with create-payment-intent. Not security-relevant here.
  baseUrl?: string;
};

// Minimal email sanity check — the donor types this for their receipt;
// Stripe also validates before sending. We only reject obvious garbage.
function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // @ts-expect-error Deno env
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      apiVersion: "2024-06-20",
      httpClient: Stripe.createFetchHttpClient(),
    });

    // Service-role client (bypasses RLS for the donations write). There is
    // no caller JWT — donations are anonymous.
    const admin = createClient(
      // @ts-expect-error Deno env
      Deno.env.get("SUPABASE_URL")!,
      // @ts-expect-error Deno env
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = (await req.json()) as Body;
    const orgSlug = String(body.orgSlug ?? "");
    const tournamentSlug = String(body.tournamentSlug ?? "");
    const donorName = String(body.donorName ?? "").trim();
    const donorEmail = String(body.donorEmail ?? "").trim();
    const message =
      body.message != null ? String(body.message).trim().slice(0, 1000) : null;
    const baseUrl = body.baseUrl;

    // ── 1. Validate donor inputs ────────────────────────────────────
    const amountCents = Number(body.amountCents);
    if (!Number.isInteger(amountCents)) {
      return json({ error: "invalid_amount" }, 400);
    }
    if (amountCents < MIN_DONATION_CENTS || amountCents > MAX_DONATION_CENTS) {
      return json({ error: "amount_out_of_bounds" }, 400);
    }
    if (!donorName) return json({ error: "donor_name_required" }, 400);
    if (!looksLikeEmail(donorEmail)) {
      return json({ error: "invalid_email" }, 400);
    }

    // ── 2. Resolve org → tournament; gate on published + opt-in + Stripe
    const { data: tournament, error: tErr } = await admin
      .from("tournaments")
      .select(
        "id, organization_id, status, accepts_donations, organizations!inner(slug, stripe_account_id, stripe_account_status)",
      )
      .eq("slug", tournamentSlug)
      .single();
    if (tErr || !tournament) return json({ error: "tournament_not_found" }, 404);

    // @ts-expect-error to-one join shape
    const org = tournament.organizations;
    // Defense-in-depth: the public flow already filters by org, but verify
    // the tournament actually belongs to the claimed org slug.
    if (orgSlug && org?.slug && org.slug !== orgSlug) {
      return json({ error: "tournament_not_found" }, 404);
    }

    if (tournament.status !== "published") {
      return json({ error: "tournament_not_accepting_donations" }, 409);
    }
    if (!tournament.accepts_donations) {
      return json({ error: "donations_not_enabled" }, 409);
    }
    if (!org?.stripe_account_id || org.stripe_account_status !== "active") {
      return json({ error: "org_stripe_not_active" }, 409);
    }

    // ── 3. Create the PaymentIntent (direct charge, NO platform fee) ──
    // Created ON the organizer's connected account ({ stripeAccount }), so
    // 100% (minus Stripe's own processing fee, which the connected account
    // pays) lands in their balance — never the platform's.
    const intent = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        // NO application_fee_amount — the platform takes nothing on donations
        // (registration fees still do). This is the whole point of the flow.
        // Stripe's built-in email receipt — no Resend wiring needed (#377).
        receipt_email: donorEmail,
        description: `Donation — ${tournament.id}`,
        metadata: {
          // The webhook routes on this. Must be present so a donation intent
          // is never mistaken for a registration payment (and vice-versa).
          type: "donation",
          tournament_id: tournament.id,
          organization_id: tournament.organization_id,
          donor_email: donorEmail,
          base_url: (baseUrl ?? "").replace(/\/+$/, "").slice(0, 200),
        },
      },
      { stripeAccount: org.stripe_account_id },
    );

    // ── 4. Record the pending donation ──────────────────────────────
    // Upsert on the unique stripe_payment_intent_id so a retried call
    // doesn't duplicate the row.
    const { data: donation, error: dErr } = await admin
      .from("donations")
      .upsert(
        {
          organization_id: tournament.organization_id,
          tournament_id: tournament.id,
          stripe_payment_intent_id: intent.id,
          stripe_connected_account_id: org.stripe_account_id,
          donor_name: donorName,
          donor_email: donorEmail,
          amount_cents: amountCents,
          message,
          status: "pending",
        },
        { onConflict: "stripe_payment_intent_id" },
      )
      .select("id")
      .single();
    if (dErr || !donation) return json({ error: "donation_record_failed" }, 500);

    return json(
      {
        clientSecret: intent.client_secret,
        donationId: donation.id,
        connectedAccountId: org.stripe_account_id,
      },
      200,
    );
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
