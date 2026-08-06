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
  // commit only: per-field values to force onto the kept record (the admin's
  // field-by-field picks). Whitelisted server-side — anything else is ignored.
  overrides?: Record<string, unknown>;
};

// Profile fields the admin can pick between the two records on merge. Kept in
// sync with the UI's field picker and the players columns.
const PICK_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "gender",
  "dob",
  "city",
  "state",
  "self_rating_doubles",
  "self_rating_mixed",
  "self_rating_singles",
] as const;

const PROFILE_SELECT = `id, ${PICK_FIELDS.join(", ")}, auth_user_id, deleted_at`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function party(p: any) {
  const out: Record<string, unknown> = { id: p.id };
  for (const k of PICK_FIELDS) out[k] = p[k] ?? null;
  out.has_account = p.auth_user_id != null;
  out.deleted = p.deleted_at != null;
  return out;
}

// Flatten a player's non-deleted event registrations with event + tournament
// context, tagging each current (tournament not yet ended) vs previous.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchRegistrations(admin: any, playerId: string) {
  const { data } = await admin
    .from("event_registrations")
    .select(
      "status, event:events(name, format, tournament:tournaments(name, ends_at))",
    )
    .eq("player_id", playerId)
    .is("deleted_at", null);
  const today = new Date().toISOString().slice(0, 10);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data ?? []) as any[]).map((r) => {
    const ev = r.event ?? {};
    const t = ev.tournament ?? {};
    return {
      event_name: ev.name ?? "(event)",
      format: ev.format ?? null,
      tournament: t.name ?? "(tournament)",
      status: r.status,
      ends_at: t.ends_at ?? null,
      is_current: t.ends_at ? t.ends_at >= today : true,
    };
  });
}

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
    // moves + conflicts from the RPC; full profiles + registrations fetched
    // here (service-role reads past RLS) so the UI can offer a field-by-field
    // pick and show each side's registration history.
    const [rpc, wProfile, lProfile, wRegs, lRegs] = await Promise.all([
      admin.rpc("merge_players_preview", { p_winner: winnerId, p_loser: loserId }),
      admin.from("players").select(PROFILE_SELECT).eq("id", winnerId).single(),
      admin.from("players").select(PROFILE_SELECT).eq("id", loserId).single(),
      fetchRegistrations(admin, winnerId),
      fetchRegistrations(admin, loserId),
    ]);
    if (rpc.error) return json({ error: rpc.error.message }, 400);
    if (wProfile.error || lProfile.error) {
      return json({ error: (wProfile.error ?? lProfile.error)!.message }, 400);
    }
    return json({
      winner: party(wProfile.data),
      loser: party(lProfile.data),
      moves: rpc.data.moves,
      conflicts: rpc.data.conflicts,
      winner_registrations: wRegs,
      loser_registrations: lRegs,
    });
  }

  // ── Commit ───────────────────────────────────────────────────────────
  const { data, error } = await admin.rpc("merge_players", {
    p_winner: winnerId,
    p_loser: loserId,
  });
  if (error) return json({ error: error.message }, 400);

  // Apply the admin's field picks onto the kept record. Whitelisted to
  // PICK_FIELDS; first/last name are NOT NULL so a blank pick is ignored.
  const overrides: Record<string, unknown> = {};
  const raw = body.overrides;
  if (raw && typeof raw === "object") {
    for (const k of PICK_FIELDS) {
      if (!(k in raw)) continue;
      const v = (raw as Record<string, unknown>)[k];
      if ((k === "first_name" || k === "last_name") && (v == null || `${v}`.trim() === "")) {
        continue;
      }
      overrides[k] = v;
    }
  }
  if (Object.keys(overrides).length > 0) {
    const { error: upErr } = await admin.from("players").update(overrides).eq("id", winnerId);
    if (upErr) return json({ error: upErr.message }, 400);
  }

  // Audit (best-effort; the merge already committed atomically in the RPC).
  try {
    await admin.from("audit_log").insert({
      actor_user_id: callerUser.id,
      entity_type: "player",
      entity_id: winnerId,
      action: "merge_players",
      data: { loser_id: loserId, summary: data, field_overrides: overrides },
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
