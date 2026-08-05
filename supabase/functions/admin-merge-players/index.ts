// supabase/functions/admin-merge-players/index.ts
//
// Merge a duplicate player (LOSER) into a kept one (WINNER). PLATFORM-ADMIN only.
// Two actions:
//   action: 'preview' → merge_players_preview RPC (read-only counts + conflicts).
//   action: 'commit'  → merge_players RPC (transactional re-point + soft-delete),
//                       then an audit_log row.
//
// All DB work goes through the service-role client; the merge_players* functions
// are granted to service_role only (not callable from a client JWT).
//
// Body:    { action: 'preview' | 'commit', winnerId: string, loserId: string }
// Returns: preview → the preview jsonb; commit → { ok, summary }.
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

type Body = {
  action?: "preview" | "commit";
  winnerId?: string;
  loserId?: string;
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

  // ── Authenticate the caller ──────────────────────────────────────────
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user: callerUser }, error: userErr } = await caller.auth.getUser();
  if (userErr || !callerUser) return json({ error: "unauthenticated" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── Authorize: platform admins only ──────────────────────────────────
  const { data: padmin } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", callerUser.id)
    .maybeSingle();
  if (!padmin) return json({ error: "forbidden_platform_admin_only" }, 403);

  // ── Input ────────────────────────────────────────────────────────────
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = body.action;
  const winnerId = (body.winnerId ?? "").trim();
  const loserId = (body.loserId ?? "").trim();
  if (action !== "preview" && action !== "commit") {
    return json({ error: "action must be 'preview' or 'commit'" }, 400);
  }
  if (!winnerId || !loserId) return json({ error: "winnerId and loserId are required" }, 400);
  if (winnerId === loserId) return json({ error: "winner and loser must differ" }, 400);

  // ── Preview ──────────────────────────────────────────────────────────
  if (action === "preview") {
    const { data, error } = await admin.rpc("merge_players_preview", {
      p_winner: winnerId,
      p_loser: loserId,
    });
    if (error) return json({ error: error.message }, 400);
    return json(data);
  }

  // ── Commit ───────────────────────────────────────────────────────────
  const { data, error } = await admin.rpc("merge_players", {
    p_winner: winnerId,
    p_loser: loserId,
  });
  if (error) return json({ error: error.message }, 400);

  // Audit (best-effort; the merge already committed atomically in the RPC).
  try {
    await admin.from("audit_log").insert({
      actor_user_id: callerUser.id,
      entity_type: "player",
      entity_id: winnerId,
      action: "merge_players",
      data: { loser_id: loserId, summary: data },
    });
  } catch {
    // don't fail the response on an audit hiccup
  }

  return json({ ok: true, summary: data });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
