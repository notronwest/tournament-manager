// supabase/functions/delete-organization/index.ts
//
// Platform-admin-only flow for deleting (soft-deleting) an entire
// organization tenant. Mirrors create-organization's auth/authorize
// shape.
//
// Caller flow (from /admin/:orgSlug/settings/danger):
//   POST { organizationId }
//
// What this does:
//   1. Verifies the caller's user_id is in public.platform_admins.
//   2. Soft-deletes the organization (sets deleted_at = now()).
//      The "orgs read public" RLS policy already filters
//      deleted_at is null, so the org disappears from every picker,
//      switcher, and the useCurrentOrg guard immediately.
//   3. Cascades the soft delete to the org's tournaments so their
//      public registration / detail pages (which all filter
//      `deleted_at is null`) stop serving. Children of those
//      tournaments are hidden transitively — the public tournament
//      page won't load once the tournament row is filtered out, so
//      we don't need to touch events/registrations.
//   4. Writes an audit_log row for traceability.
//
// Soft delete is the only practical option: tournaments and
// registrations FK into organizations with `on delete restrict`, so
// a hard DELETE is refused by Postgres whenever the org has any.
//
// Required Supabase secrets (auto-injected by the Edge Functions
// runtime):
//   SUPABASE_URL                 — auto
//   SUPABASE_SERVICE_ROLE_KEY    — auto
//   SUPABASE_ANON_KEY            — auto (used to verify the caller's JWT)
//
// Returns: { ok: true, slug, tournamentsHidden } on success, or
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
  organizationId: string;
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
  const organizationId = (body.organizationId || "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      organizationId,
    )
  ) {
    return jsonResp({ error: "A valid organizationId is required." }, 400);
  }

  // ── Soft-delete the org ───────────────────────────────────────
  // Guard on deleted_at is null so a double-submit returns a clear
  // "already deleted" rather than silently re-stamping the timestamp.
  const nowIso = new Date().toISOString();
  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .update({ deleted_at: nowIso })
    .eq("id", organizationId)
    .is("deleted_at", null)
    .select("id, slug, name")
    .maybeSingle();
  if (orgErr) {
    return jsonResp(
      { error: `Failed to delete organization: ${orgErr.message}` },
      500,
    );
  }
  if (!org) {
    return jsonResp(
      { error: "Organization not found or already deleted." },
      404,
    );
  }

  // ── Cascade to the org's tournaments ──────────────────────────
  const { data: hiddenTournaments, error: tErr } = await admin
    .from("tournaments")
    .update({ deleted_at: nowIso })
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .select("id");
  if (tErr) {
    // The org is already soft-deleted (and hidden); surface the
    // partial failure so the admin knows some tournaments may still
    // be reachable by direct URL.
    return jsonResp(
      {
        error:
          `Organization deleted, but hiding its tournaments failed: ${tErr.message}. ` +
          `Some tournament pages may still be reachable.`,
      },
      500,
    );
  }
  const tournamentsHidden = hiddenTournaments?.length ?? 0;

  // ── Audit trail (best-effort) ─────────────────────────────────
  await admin.from("audit_log").insert({
    organization_id: org.id,
    actor_user_id: callerUser.id,
    entity_type: "organization",
    entity_id: org.id,
    action: "soft_delete",
    data: { slug: org.slug, name: org.name, tournamentsHidden },
  });

  return jsonResp({
    ok: true,
    slug: org.slug,
    name: org.name,
    tournamentsHidden,
  });
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
