// supabase/functions/stripe-connect-oauth-callback/index.ts
//
// Handles the Stripe Connect OAuth callback after the org admin
// authorizes Tournament Manager on Stripe's hosted OAuth page.
//
// Flow:
//   1. Stripe redirects the browser to /admin/oauth/stripe-callback
//      ?code=<authorization_code>&state=<base64({"orgSlug":"..."})>.
//   2. The callback page (StripeOauthCallbackPage) POSTs the code +
//      state to this function with the caller's auth header.
//   3. We decode state → orgSlug, look up the org, verify the caller
//      is an org admin (has_org_role).
//   4. Exchange the code via stripe.oauth.token to get the
//      stripe_user_id — that's the connected account id.
//   5. Save it to organizations.stripe_account_id, status='active'.
//      Standard accounts come pre-verified, so no pending state.
//   6. Return { ok: true, slug } so the page redirects to the org's
//      settings page.
//
// Auth: caller's JWT identifies them; the org from `state` is
// confirmed via has_org_role(org, 'admin') so a forged callback
// can't connect Stripe to an org the caller doesn't administer.
//
// Required secrets:
//   STRIPE_SECRET_KEY       — same key the other Stripe edge
//                             functions use.
//   SUPABASE_* (auto)

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
  code: string;
  state: string;
};

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

  // ── Auth ──────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResp({ error: "Unauthenticated" }, 401);

  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user: callerUser },
  } = await caller.auth.getUser();
  if (!callerUser) return jsonResp({ error: "Unauthenticated" }, 401);

  // ── Body ──────────────────────────────────────────────────────
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResp({ error: "Invalid JSON body" }, 400);
  }
  if (!body.code || !body.state) {
    return jsonResp({ error: "code and state are required" }, 400);
  }

  // ── Decode state → orgSlug ───────────────────────────────────
  let orgSlug: string;
  try {
    const decoded = JSON.parse(b64UrlDecode(body.state));
    orgSlug = String(decoded.orgSlug ?? "");
    if (!orgSlug) throw new Error("missing orgSlug in state");
  } catch (e) {
    return jsonResp(
      { error: `Invalid state param: ${e instanceof Error ? e.message : "unknown"}` },
      400,
    );
  }

  // ── Org lookup + authorization ────────────────────────────────
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const { data: org } = await admin
    .from("organizations")
    .select("id, slug, stripe_account_id")
    .eq("slug", orgSlug)
    .is("deleted_at", null)
    .maybeSingle();
  if (!org) return jsonResp({ error: "Organization not found" }, 404);

  const { data: authorized } = await caller.rpc("has_org_role", {
    org: org.id,
    min_role: "admin",
  });
  if (!authorized) {
    return jsonResp(
      { error: "Not authorized for this organization." },
      403,
    );
  }

  // ── Exchange code for token ───────────────────────────────────
  const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });
  let stripeUserId: string;
  try {
    const tokenResp = await stripe.oauth.token({
      grant_type: "authorization_code",
      code: body.code,
    });
    if (!tokenResp.stripe_user_id) {
      return jsonResp(
        { error: "Stripe OAuth didn't return a connected account id." },
        500,
      );
    }
    stripeUserId = tokenResp.stripe_user_id;
  } catch (e) {
    return jsonResp(
      {
        error: `Stripe OAuth token exchange failed: ${e instanceof Error ? e.message : "unknown"}`,
      },
      500,
    );
  }

  // ── Save to org ──────────────────────────────────────────────
  // Standard accounts go through OAuth precisely because they're
  // already verified, so jump straight to 'active'. The status-refresh
  // function can re-pull the live state if we ever want to confirm.
  const { error: updErr } = await admin
    .from("organizations")
    .update({
      stripe_account_id: stripeUserId,
      stripe_account_status: "active",
    })
    .eq("id", org.id);
  if (updErr) {
    return jsonResp(
      {
        error: `Stripe connected (id ${stripeUserId}) but saving to org failed: ${updErr.message}`,
      },
      500,
    );
  }

  return jsonResp({ ok: true, slug: org.slug, accountId: stripeUserId });
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function b64UrlDecode(s: string): string {
  // Reverse of the URL-safe base64 used by stripe-connect-onboarding.
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return atob(padded + pad);
}
