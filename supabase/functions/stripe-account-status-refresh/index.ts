// supabase/functions/stripe-account-status-refresh/index.ts
//
// Pulls the live state of an organization's Stripe Connect account
// and updates organizations.stripe_account_status to match.
//
// Called by OrgStripeSettingsPage on mount (especially after the
// user returns from the Stripe-hosted onboarding flow with
// ?from=stripe in the URL) and by a "Refresh status" button. A
// webhook handler is a follow-on; for MVP this poll-on-page-load
// approach gives accurate-enough status.
//
// Status derivation from the Stripe Account object:
//   account.charges_enabled === true
//     and no `disabled_reason`            → 'active'
//   account.requirements.disabled_reason  → 'restricted'
//   otherwise (details not submitted, or
//     pending review)                      → 'pending'
//
// Auth: org admin (or platform admin via has_org_role).
//
// Required secrets — same as stripe-connect-onboarding.

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

type Body = { orgSlug: string };

type StripeStatus = "not_connected" | "pending" | "active" | "restricted";

// @ts-expect-error Deno global
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResp({ error: "Method not allowed" }, 405);
  }

  // @ts-expect-error Deno global
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) {
    return jsonResp(
      { error: "STRIPE_SECRET_KEY isn't configured on this Supabase project." },
      500,
    );
  }
  // @ts-expect-error Deno global
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  // @ts-expect-error Deno global
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // @ts-expect-error Deno global
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResp({ error: "Unauthenticated" }, 401);

  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user: callerUser },
  } = await caller.auth.getUser();
  if (!callerUser) return jsonResp({ error: "Unauthenticated" }, 401);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResp({ error: "Invalid JSON body" }, 400);
  }
  if (!body.orgSlug) {
    return jsonResp({ error: "orgSlug is required" }, 400);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const { data: org } = await admin
    .from("organizations")
    .select("id, slug, stripe_account_id, stripe_account_status")
    .eq("slug", body.orgSlug)
    .is("deleted_at", null)
    .maybeSingle();
  if (!org) return jsonResp({ error: "Organization not found" }, 404);

  const { data: authorized } = await caller.rpc("has_org_role", {
    org: org.id,
    min_role: "admin",
  });
  if (!authorized) {
    return jsonResp({ error: "Not authorized for this organization." }, 403);
  }

  if (!org.stripe_account_id) {
    // Nothing connected yet — just echo back the current status.
    return jsonResp({ ok: true, status: org.stripe_account_status });
  }

  // ── Fetch live Stripe account ──────────────────────────────────
  const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20", httpClient: Stripe.createFetchHttpClient() });
  let stripeAccount;
  try {
    stripeAccount = await stripe.accounts.retrieve(org.stripe_account_id);
  } catch (e) {
    return jsonResp(
      {
        error: `Stripe account retrieve failed: ${e instanceof Error ? e.message : "unknown"}`,
      },
      500,
    );
  }

  // ── Derive our status enum ────────────────────────────────────
  //
  // charges_enabled is the canonical "can this account take money?"
  // signal — it's what Stripe themselves use to gate transactions.
  // disabled_reason can be present for low-priority follow-ups
  // (e.g. peripheral capabilities under review) even when the
  // account is fully functional for charges, so checking
  // charges_enabled FIRST avoids mis-flagging a working account
  // as "restricted." We only treat it as restricted when the
  // account can't actually charge AND Stripe gave a reason.
  const disabledReason: string | null =
    (stripeAccount.requirements?.disabled_reason as string | null) ?? null;

  let newStatus: StripeStatus;
  if (stripeAccount.charges_enabled) {
    newStatus = "active";
  } else if (disabledReason) {
    newStatus = "restricted";
  } else {
    newStatus = "pending";
  }

  if (newStatus !== org.stripe_account_status) {
    const { error: updErr } = await admin
      .from("organizations")
      .update({ stripe_account_status: newStatus })
      .eq("id", org.id);
    if (updErr) {
      return jsonResp(
        { error: `Saving updated status failed: ${updErr.message}` },
        500,
      );
    }
  }

  return jsonResp({
    ok: true,
    status: newStatus,
    chargesEnabled: !!stripeAccount.charges_enabled,
    detailsSubmitted: !!stripeAccount.details_submitted,
    disabledReason,
  });
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
