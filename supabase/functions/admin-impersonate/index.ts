// supabase/functions/admin-impersonate/index.ts
//
// Platform-admin-only "log in as" for a real attendee. Mints a single-use
// magic-link token for the target player's auth account and returns its
// hashed_token; the client calls supabase.auth.verifyOtp({ token_hash,
// type: 'magiclink' }) to assume that session. No password, no email is sent
// (generateLink only GENERATES the token — it does not deliver anything).
//
// This is full impersonation of a real user, so unlike seed-test-players it
// MUST authorize the caller: only rows in public.platform_admins may call it,
// and every call is written to audit_log.
//
// ⚠️  Deploy: supabase functions deploy admin-impersonate
//
// POST { playerId }
// Returns { ok: true, tokenHash, email } | { error, code? }
//   code "no_account" → the attendee has never signed up (auth_user_id null).

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Body = { playerId?: string };

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResp({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResp({ error: "Unauthenticated" }, 401);

  // @ts-expect-error Deno global
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  // @ts-expect-error Deno global
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // @ts-expect-error Deno global
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  // ── Authenticate the caller via their JWT ────────────────────────────
  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user: callerUser },
    error: userErr,
  } = await caller.auth.getUser();
  if (userErr || !callerUser) return jsonResp({ error: "Unauthenticated" }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey);

  // ── Authorize: platform admins only ──────────────────────────────────
  const { data: padmin } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", callerUser.id)
    .maybeSingle();
  if (!padmin) return jsonResp({ error: "Not a platform admin" }, 403);

  // ── Input ────────────────────────────────────────────────────────────
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResp({ error: "Invalid JSON body" }, 400);
  }
  const playerId = (body.playerId || "").trim();
  if (!playerId) return jsonResp({ error: "playerId is required." }, 400);

  // ── Resolve the target player + their auth account ───────────────────
  const { data: player, error: playerErr } = await admin
    .from("players")
    .select("id, first_name, last_name, email, auth_user_id")
    .eq("id", playerId)
    .is("deleted_at", null)
    .single();
  if (playerErr || !player) return jsonResp({ error: "Player not found." }, 404);
  if (!player.auth_user_id) {
    return jsonResp(
      { error: "This attendee hasn't signed up yet — no account to log in as.", code: "no_account" },
      400,
    );
  }

  // Use the canonical auth login email (may differ from players.email).
  const { data: targetUserData, error: targetErr } =
    await admin.auth.admin.getUserById(player.auth_user_id);
  const targetEmail = targetUserData?.user?.email ?? null;
  if (targetErr || !targetEmail) {
    return jsonResp({ error: "Target account has no usable email." }, 409);
  }

  // ── Mint a single-use magic-link token (no email delivered) ──────────
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: targetEmail,
  });
  const tokenHash = (linkData?.properties as { hashed_token?: string } | undefined)
    ?.hashed_token;
  if (linkErr || !tokenHash) {
    return jsonResp({ error: linkErr?.message ?? "Could not generate session." }, 502);
  }

  // ── Audit: who impersonated whom (best-effort; never blocks the login) ─
  try {
    await admin.from("audit_log").insert({
      actor_user_id: callerUser.id,
      entity_type: "player",
      entity_id: player.id,
      action: "impersonate",
      data: { target_auth_user_id: player.auth_user_id, target_email: targetEmail },
    });
  } catch {
    // audit failure shouldn't block a legitimate admin action
  }

  return jsonResp({ ok: true, tokenHash, email: targetEmail }, 200);
});

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
