// supabase/functions/create-organization/index.ts
//
// Super-admin-only flow for onboarding a new organization. Closes
// the bootstrap gap that previously required running SQL in the
// Supabase dashboard.
//
// Caller flow (from /admin/new-org):
//   POST { orgName, orgSlug, ownerFirstName, ownerLastName, ownerEmail }
//
// What this does:
//   1. Verifies the caller's user_id is in public.platform_admins.
//   2. Inserts the organizations row (service_role bypasses RLS).
//      The auto-add-creator-as-owner trigger no-ops because
//      auth.uid() is NULL inside a service-role context.
//   3. Looks up the owner email via the find_user_by_email helper:
//        * found     → link that user_id directly as owner.
//        * not found → admin.auth.admin.inviteUserByEmail sends a
//                      Supabase invite email and creates an
//                      unconfirmed auth.users row; we link that
//                      new user_id as owner immediately so they
//                      land in the org the moment they confirm.
//   4. Inserts organization_members (user_id, organization_id,
//      role='owner').
//   5. On any failure after the org is inserted, rolls the org
//      back so we don't leave an orphan organization.
//
// Required Supabase secrets (auto-injected by the Edge Functions
// runtime, except the one explicitly set per project):
//   SUPABASE_URL                 — auto
//   SUPABASE_SERVICE_ROLE_KEY    — auto
//   SUPABASE_ANON_KEY            — auto (used to verify the caller's JWT)
//
// Returns: { ok: true, slug, ownerWasInvited } on success, or
//          { error: string } with the appropriate HTTP status.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Body = {
  orgName: string;
  orgSlug: string;
  ownerFirstName: string;
  ownerLastName?: string;
  ownerEmail: string;
  // The browser's origin so the invite email's confirmation link
  // lands on the right environment (localhost vs prod).
  baseUrl?: string;
};

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResp({ error: "Method not allowed" }, 405);
  }

  // ── Auth check ────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResp({ error: "Unauthenticated" }, 401);
  }

  // @ts-expect-error Deno global
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  // @ts-expect-error Deno global
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // @ts-expect-error Deno global
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  // Resolve caller identity using their JWT.
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

  const admin = createClient(supabaseUrl, serviceRoleKey);

  // Caller must be a platform admin.
  const { data: padmin } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", callerUser.id)
    .maybeSingle();
  if (!padmin) {
    return jsonResp({ error: "Not a platform admin" }, 403);
  }

  // ── Body validation ───────────────────────────────────────────
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResp({ error: "Invalid JSON body" }, 400);
  }
  const orgName = (body.orgName || "").trim();
  const orgSlug = (body.orgSlug || "").trim().toLowerCase();
  const ownerEmail = (body.ownerEmail || "").trim().toLowerCase();
  const ownerFirstName = (body.ownerFirstName || "").trim();
  const ownerLastName = (body.ownerLastName || "").trim();

  if (!orgName) return jsonResp({ error: "Organization name is required." }, 400);
  if (!/^[a-z0-9-]{2,60}$/.test(orgSlug)) {
    return jsonResp(
      { error: "Slug must be 2–60 chars, lowercase letters/numbers/hyphens." },
      400,
    );
  }
  if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    return jsonResp({ error: "Valid owner email is required." }, 400);
  }
  if (!ownerFirstName) {
    return jsonResp({ error: "Owner first name is required." }, 400);
  }

  // ── Insert org ───────────────────────────────────────────────
  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .insert({ name: orgName, slug: orgSlug })
    .select()
    .single();
  if (orgErr || !org) {
    // Duplicate slug surfaces here as a 23505 unique_violation.
    const msg =
      orgErr?.code === "23505"
        ? `An organization with slug "${orgSlug}" already exists.`
        : (orgErr?.message ?? "Failed to create organization.");
    return jsonResp({ error: msg }, 400);
  }

  // ── Resolve or invite the owner ───────────────────────────────
  let ownerUserId: string | null = null;
  let ownerWasInvited = false;

  // Existing auth user?
  const { data: foundUserId } = await admin.rpc("find_user_by_email", {
    p_email: ownerEmail,
  });
  if (foundUserId) {
    ownerUserId = foundUserId as string;
  } else {
    // Send an invitation. Supabase creates an unconfirmed auth.users
    // row; once the recipient confirms + sets a password they're a
    // fully-fledged user and (because we link them as owner below)
    // they land straight into the new org.
    const { data: inviteData, error: inviteErr } =
      await admin.auth.admin.inviteUserByEmail(ownerEmail, {
        data: {
          first_name: ownerFirstName,
          last_name: ownerLastName,
          invited_to_org: org.slug,
        },
        redirectTo: body.baseUrl
          ? `${body.baseUrl}/admin/${org.slug}`
          : undefined,
      });
    if (inviteErr || !inviteData?.user) {
      // Roll back the org so a failed invite doesn't leave debris.
      await admin.from("organizations").delete().eq("id", org.id);
      return jsonResp(
        { error: `Failed to invite owner: ${inviteErr?.message ?? "unknown"}` },
        400,
      );
    }
    ownerUserId = inviteData.user.id;
    ownerWasInvited = true;
  }

  // ── Link as owner ────────────────────────────────────────────
  const { error: memErr } = await admin
    .from("organization_members")
    .insert({
      organization_id: org.id,
      user_id: ownerUserId,
      role: "owner",
    });
  if (memErr) {
    // Roll the org back — we don't want a half-onboarded org floating
    // around. The invited auth.users row stays (Supabase doesn't make
    // it easy to delete a half-invited user; if it matters the
    // platform admin can delete from the dashboard).
    await admin.from("organizations").delete().eq("id", org.id);
    return jsonResp(
      { error: `Org created but owner link failed: ${memErr.message}` },
      500,
    );
  }

  return jsonResp({
    ok: true,
    slug: org.slug,
    name: org.name,
    ownerWasInvited,
  });
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
