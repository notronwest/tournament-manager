// supabase/functions/admin-update-player-email/index.ts
//
// Platform-admin-only endpoint for updating a player's contact email
// and/or login (auth) email. The login-email path calls
// auth.admin.updateUserById with service_role — unavailable client-side.
//
// ⚠️  Deploy with: supabase functions deploy admin-update-player-email
//
// POST { playerId, contactEmail?, loginEmail? }
//
//   contactEmail — new value for players.email; pass empty string to clear.
//   loginEmail   — new auth login email; only applied when the player has
//                  an auth_user_id. Omit or leave blank to skip.
//
// Required secrets (auto-injected by the Edge Functions runtime):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
//
// Returns { ok: true } or { error: string }.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Body = {
  playerId: string;
  contactEmail?: string;
  loginEmail?: string;
};

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResp({ error: "Method not allowed" }, 405);
  }

  // ── Verify caller identity ──────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResp({ error: "Unauthenticated" }, 401);

  // @ts-expect-error Deno global
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  // @ts-expect-error Deno global
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // @ts-expect-error Deno global
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

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

  // Caller must be a platform admin (server-side check).
  const { data: padmin } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", callerUser.id)
    .maybeSingle();
  if (!padmin) {
    return jsonResp({ error: "Not a platform admin" }, 403);
  }

  // ── Parse + validate body ───────────────────────────────────────
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResp({ error: "Invalid JSON body" }, 400);
  }

  const playerId = (body.playerId || "").trim();
  if (!playerId) return jsonResp({ error: "playerId is required." }, 400);

  const contactEmail =
    body.contactEmail !== undefined ? body.contactEmail.trim() : undefined;
  const loginEmail =
    body.loginEmail !== undefined ? body.loginEmail.trim() : undefined;

  const hasContactUpdate = contactEmail !== undefined;
  const hasLoginUpdate = !!loginEmail;

  if (!hasContactUpdate && !hasLoginUpdate) {
    return jsonResp({ error: "Nothing to update." }, 400);
  }

  if (hasContactUpdate && contactEmail && contactEmail.length > 200) {
    return jsonResp({ error: "Email address is too long." }, 400);
  }
  if (
    hasContactUpdate &&
    contactEmail &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)
  ) {
    return jsonResp({ error: "Contact email address is not valid." }, 400);
  }
  if (
    hasLoginUpdate &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail!)
  ) {
    return jsonResp({ error: "Login email address is not valid." }, 400);
  }

  // ── Load the player ─────────────────────────────────────────────
  const { data: player, error: playerErr } = await admin
    .from("players")
    .select("id, auth_user_id, email")
    .eq("id", playerId)
    .is("deleted_at", null)
    .single();

  if (playerErr || !player) {
    return jsonResp({ error: "Player not found." }, 404);
  }

  // ── Update contact email ────────────────────────────────────────
  if (hasContactUpdate) {
    const { error: updateErr } = await admin
      .from("players")
      .update({ email: contactEmail || null })
      .eq("id", playerId);
    if (updateErr) {
      return jsonResp(
        { error: `Failed to update contact email: ${updateErr.message}` },
        500,
      );
    }
  }

  // ── Update login email ──────────────────────────────────────────
  if (hasLoginUpdate) {
    if (!player.auth_user_id) {
      return jsonResp(
        { error: "This player has no linked account — cannot change login email." },
        400,
      );
    }
    const { error: authErr } = await admin.auth.admin.updateUserById(
      player.auth_user_id,
      { email: loginEmail! },
    );
    if (authErr) {
      const msg = authErr.message.toLowerCase().includes("already registered")
        ? `That email address is already in use by another account.`
        : `Failed to update login email: ${authErr.message}`;
      return jsonResp({ error: msg }, 400);
    }
  }

  return jsonResp({ ok: true });
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
