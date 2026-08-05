// supabase/functions/admin-unregistered-users/index.ts
//
// PLATFORM-ADMIN only. Lists people who created a login account and have signed
// in at least once, but have NEVER registered for anything — so an admin can
// spot and reach out to them. Cross-org (site-level), read-only.
//
// "Signed up + logged in + never registered" =
//   players.auth_user_id is not null, not deleted
//   AND auth.users.last_sign_in_at is not null   (actually logged in)
//   AND no non-deleted event_registrations for that player.
//
// Body: none (POST). Returns: { users: UnregisteredUser[] } sorted by last login desc.
//
// Required secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   SUPABASE_ANON_KEY.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthenticated" }, 401);

  // @ts-expect-error Deno env
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  // @ts-expect-error Deno env
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // @ts-expect-error Deno env
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

  // ── Authenticate + authorize (platform admins only) ──────────────────
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user: callerUser }, error: userErr } = await caller.auth.getUser();
  if (userErr || !callerUser) return json({ error: "unauthenticated" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: padmin } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", callerUser.id)
    .maybeSingle();
  if (!padmin) return json({ error: "forbidden_platform_admin_only" }, 403);

  try {
    // ── 1. Players with a linked account ──────────────────────────────
    const { data: players, error: pErr } = await admin
      .from("players")
      .select("id, first_name, last_name, email, created_at, auth_user_id")
      .not("auth_user_id", "is", null)
      .is("deleted_at", null);
    if (pErr) return json({ error: pErr.message }, 500);
    const accounts = players ?? [];
    if (accounts.length === 0) return json({ users: [] });

    // ── 2. Player ids that HAVE a (non-deleted) registration ──────────
    const registered = new Set<string>();
    const ids = accounts.map((p) => p.id);
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const { data: regs, error: rErr } = await admin
        .from("event_registrations")
        .select("player_id")
        .in("player_id", slice)
        .is("deleted_at", null);
      if (rErr) return json({ error: rErr.message }, 500);
      for (const r of regs ?? []) if (r.player_id) registered.add(r.player_id);
    }

    // ── 3. last_sign_in_at per auth user (paginate the auth admin API) ─
    const lastSignIn = new Map<string, string | null>();
    const authEmail = new Map<string, string | null>();
    const PER_PAGE = 1000;
    for (let page = 1; page <= 50; page++) {
      const { data: list, error: lErr } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
      if (lErr) return json({ error: lErr.message }, 500);
      const batch = list?.users ?? [];
      for (const u of batch) {
        lastSignIn.set(u.id, u.last_sign_in_at ?? null);
        authEmail.set(u.id, u.email ?? null);
      }
      if (batch.length < PER_PAGE) break;
    }

    // ── 4. Keep accounts that never registered AND have logged in ─────
    const users = accounts
      .filter((p) => !registered.has(p.id))
      .filter((p) => p.auth_user_id && lastSignIn.get(p.auth_user_id))
      .map((p) => ({
        playerId: p.id,
        firstName: p.first_name ?? "",
        lastName: p.last_name ?? "",
        email: p.email ?? authEmail.get(p.auth_user_id!) ?? null,
        createdAt: p.created_at,
        lastSignInAt: lastSignIn.get(p.auth_user_id!) ?? null,
      }))
      .sort((a, b) => (b.lastSignInAt ?? "").localeCompare(a.lastSignInAt ?? ""));

    return json({ users });
  } catch (e) {
    return json({ error: String((e as { message?: string })?.message ?? e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
