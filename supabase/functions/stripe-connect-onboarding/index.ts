// supabase/functions/stripe-connect-onboarding/index.ts
//
// Kicks off (or resumes) Stripe Connect Express onboarding for an
// organization. The browser POSTs here with the org slug + a base
// URL; the function creates a Stripe Connect account (if needed),
// records the account_id on the org row, and returns a Stripe-hosted
// onboarding URL the browser then redirects to.
//
// When the organizer finishes (or bails out of) the Stripe-hosted
// flow, Stripe redirects them back to {baseUrl}/admin/{slug}/settings/
// stripe?from=stripe. That landing logic lives in
// OrgStripeSettingsPage, which calls stripe-account-status-refresh
// on mount to pull the latest status from Stripe.
//
// Auth: caller must be an org admin (owner or admin) OR a platform
// admin. has_org_role() returns true for platform admins, so a
// single RPC call covers both.
//
// Required secrets:
//   STRIPE_SECRET_KEY  — sk_test_… (or sk_live_…) from
//                        stripe.com → Developers → API keys. Set via
//                        `supabase secrets set STRIPE_SECRET_KEY=...`.
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY
//                      — auto-injected by the Edge Functions runtime.

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
  // Browser origin so the return/refresh URLs work in any env
  // (localhost dev vs the deployed Pages site).
  baseUrl: string;
  // 'oauth'   → "Sign in with existing Stripe" flow. The org admin
  //             authorizes Tournament Manager against their existing
  //             Stripe account; faster + no re-entering business info.
  //             Returns a Stripe OAuth authorize URL.
  // 'express' → "Create a new Stripe account" flow. We create a
  //             Connect Express account on their behalf and return a
  //             Stripe-hosted onboarding URL. Use when the org doesn't
  //             have Stripe yet.
  mode?: "oauth" | "express";
};

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResp({ error: "Method not allowed" }, 405);
  }

  // ── Env ───────────────────────────────────────────────────────
  // @ts-expect-error Deno global
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) {
    return jsonResp(
      {
        error:
          "Stripe isn't configured yet — STRIPE_SECRET_KEY isn't set on this Supabase project. Ron needs to run `supabase secrets set STRIPE_SECRET_KEY=sk_test_...` first.",
      },
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
    error: userErr,
  } = await caller.auth.getUser();
  if (userErr || !callerUser) {
    return jsonResp({ error: "Unauthenticated" }, 401);
  }

  // ── Body ──────────────────────────────────────────────────────
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResp({ error: "Invalid JSON body" }, 400);
  }
  const orgSlug = (body.orgSlug || "").trim();
  const baseUrl = (body.baseUrl || "").replace(/\/$/, "");
  if (!orgSlug) return jsonResp({ error: "orgSlug is required" }, 400);
  if (!baseUrl) return jsonResp({ error: "baseUrl is required" }, 400);

  // ── Org lookup + authorization ────────────────────────────────
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("id, slug, name, stripe_account_id, stripe_account_status")
    .eq("slug", orgSlug)
    .is("deleted_at", null)
    .maybeSingle();
  if (orgErr || !org) {
    return jsonResp({ error: "Organization not found" }, 404);
  }

  // has_org_role returns true for platform admins too (see
  // 20260529210000_platform_admin_implicit_org_access). We call it
  // via the caller's client so auth.uid() resolves to them.
  const { data: authorized, error: roleErr } = await caller.rpc(
    "has_org_role",
    { org: org.id, min_role: "admin" },
  );
  if (roleErr) {
    return jsonResp({ error: `Auth check failed: ${roleErr.message}` }, 500);
  }
  if (!authorized) {
    return jsonResp(
      { error: "Only org admins (owner / admin) can connect Stripe." },
      403,
    );
  }

  const mode = body.mode ?? "express";

  // ── OAuth mode: build a Stripe Connect OAuth authorize URL ────
  //
  // The org admin authorizes Tournament Manager against their
  // existing Stripe account (or creates a new full Stripe account
  // through Stripe's signup screen — Stripe branches on the OAuth
  // page based on whether they're signed in). On success Stripe
  // redirects to /admin/oauth/stripe-callback with ?code + ?state;
  // StripeOauthCallbackPage hands those to the stripe-connect-
  // oauth-callback edge function which exchanges the code for a
  // stripe_user_id and saves it to the org.
  //
  // state encodes the org slug so the callback knows which org this
  // is for; the callback's own has_org_role check is what actually
  // gates the write (a forged callback can't connect Stripe to an
  // org the caller doesn't administer).
  if (mode === "oauth") {
    // @ts-expect-error Deno global
    const clientId = Deno.env.get("STRIPE_CONNECT_CLIENT_ID");
    if (!clientId) {
      return jsonResp(
        {
          error:
            "STRIPE_CONNECT_CLIENT_ID isn't set on this Supabase project. Ron needs to enable OAuth on the Connect platform and run `supabase secrets set STRIPE_CONNECT_CLIENT_ID=ca_test_...`.",
        },
        500,
      );
    }
    const state = b64UrlEncode(JSON.stringify({ orgSlug: org.slug }));
    const redirectUri = `${baseUrl}/admin/oauth/stripe-callback`;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      scope: "read_write",
      redirect_uri: redirectUri,
      state,
      // stripe_landing=login forces the OAuth screen to lead with
      // "Sign in to your existing Stripe account" rather than
      // auto-detecting and (sometimes) dropping the user into the
      // signup form. Users who don't yet have a Stripe account can
      // still click "Sign up" from the login screen — but the
      // default surface matches the "Sign in with Stripe" button
      // they clicked.
      stripe_landing: "login",
      // Pre-fill the email so the Stripe sign-in screen is one click
      // closer to done.
      "stripe_user[email]": callerUser.email ?? "",
    });
    const url = `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
    return jsonResp({ ok: true, kind: "oauth", onboardingUrl: url });
  }

  // ── Express mode: ensure Connect account exists ───────────────
  const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });

  let accountId = org.stripe_account_id;
  if (!accountId) {
    try {
      const account = await stripe.accounts.create({
        type: "express",
        country: "US",
        email: callerUser.email ?? undefined,
        business_profile: {
          name: org.name,
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: {
          tournament_manager_org_id: org.id,
          tournament_manager_org_slug: org.slug,
        },
      });
      accountId = account.id;
    } catch (e) {
      return jsonResp(
        {
          error: `Stripe account creation failed: ${e instanceof Error ? e.message : "unknown"}`,
        },
        500,
      );
    }

    const { error: updErr } = await admin
      .from("organizations")
      .update({
        stripe_account_id: accountId,
        stripe_account_status: "pending",
      })
      .eq("id", org.id);
    if (updErr) {
      // Best-effort: the Stripe account already exists upstream; the
      // platform admin can re-link manually if this saves wrong.
      return jsonResp(
        {
          error: `Stripe account created (id ${accountId}) but saving to the org failed: ${updErr.message}. Contact a platform admin.`,
        },
        500,
      );
    }
  }

  // ── AccountLink (hosted onboarding URL) ───────────────────────
  // refresh_url is where Stripe sends the user if the link expires
  // before they finish (we just re-create the link). return_url is
  // where Stripe sends them when they're done (or step out early).
  // Both land on the settings page; the page reads ?from=stripe to
  // know it should pull the latest status from Stripe.
  const settingsUrl = `${baseUrl}/admin/${org.slug}/settings/stripe`;
  let accountLinkUrl: string;
  try {
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${settingsUrl}?from=stripe&kind=refresh`,
      return_url: `${settingsUrl}?from=stripe&kind=return`,
      type: "account_onboarding",
    });
    accountLinkUrl = link.url;
  } catch (e) {
    return jsonResp(
      {
        error: `Stripe AccountLink creation failed: ${e instanceof Error ? e.message : "unknown"}`,
      },
      500,
    );
  }

  return jsonResp({ ok: true, accountId, onboardingUrl: accountLinkUrl });
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// URL-safe base64 (no padding) — used for the OAuth state param so it
// survives query-string round-tripping without needing extra encoding.
function b64UrlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
