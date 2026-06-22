// supabase/functions/admin-get-player/index.ts
//
// Platform-admin-only endpoint that returns the full picture for a single
// player: profile, linked auth account (login email + confirmation /
// last-sign-in, which are NOT client-readable), and their cross-org
// tournament history. event_registrations RLS is player-self-or-org-member,
// so a platform admin who isn't in the org can't read another player's
// history client-side — hence this service_role read.
//
// ⚠️  Deploy with: supabase functions deploy admin-get-player
//
// POST { playerId }
//
// Returns { ok: true, player, account, history } or { error: string }.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Body = { playerId: string };

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResp({ error: "Method not allowed" }, 405);
  }

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

  const { data: padmin } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", callerUser.id)
    .maybeSingle();
  if (!padmin) {
    return jsonResp({ error: "Not a platform admin" }, 403);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResp({ error: "Invalid JSON body" }, 400);
  }
  const playerId = (body.playerId || "").trim();
  if (!playerId) return jsonResp({ error: "playerId is required." }, 400);

  // ── Profile ─────────────────────────────────────────────────────
  const { data: player, error: playerErr } = await admin
    .from("players")
    .select(
      "id, first_name, last_name, email, phone, gender, city, state, dob, " +
        "self_rating_doubles, self_rating_mixed, self_rating_singles, " +
        "avatar_path, avatar_hidden, auth_user_id, created_at",
    )
    .eq("id", playerId)
    .is("deleted_at", null)
    .single();
  if (playerErr || !player) {
    return jsonResp({ error: "Player not found." }, 404);
  }

  // ── Linked auth account (login email + status) ──────────────────
  let account: {
    loginEmail: string | null;
    emailConfirmedAt: string | null;
    lastSignInAt: string | null;
  } | null = null;
  if (player.auth_user_id) {
    const { data: au } = await admin.auth.admin.getUserById(
      player.auth_user_id,
    );
    if (au?.user) {
      account = {
        loginEmail: au.user.email ?? null,
        emailConfirmedAt: au.user.email_confirmed_at ?? null,
        lastSignInAt: au.user.last_sign_in_at ?? null,
      };
    }
  }

  // ── Tournament history (cross-org) ──────────────────────────────
  const { data: regs, error: regErr } = await admin
    .from("event_registrations")
    .select(
      `
      id,
      status,
      partner_status,
      registered_at,
      partner_registration_id,
      events (
        id,
        name,
        format,
        gender,
        tournaments (
          name,
          slug,
          starts_at,
          status,
          organizations ( name, slug )
        )
      )
    `,
    )
    .eq("player_id", playerId)
    .is("deleted_at", null)
    .order("registered_at", { ascending: false });

  if (regErr) {
    return jsonResp(
      { error: `Failed to load history: ${regErr.message}` },
      500,
    );
  }

  // Resolve partner names in one extra query (partner_registration_id →
  // that reg's player). Avoids a fragile self-join in the select above.
  const partnerRegIds = (regs ?? [])
    .map((r: Record<string, unknown>) => r.partner_registration_id as string | null)
    .filter((v): v is string => !!v);
  const partnerNameById = new Map<string, string>();
  if (partnerRegIds.length > 0) {
    const { data: partnerRegs } = await admin
      .from("event_registrations")
      .select("id, players ( first_name, last_name )")
      .in("id", partnerRegIds);
    for (const pr of partnerRegs ?? []) {
      const pl = (pr as Record<string, unknown>).players as
        | { first_name: string; last_name: string }
        | null;
      if (pl) {
        partnerNameById.set(
          (pr as { id: string }).id,
          `${pl.first_name} ${pl.last_name}`,
        );
      }
    }
  }

  const history = (regs ?? []).map((r: Record<string, unknown>) => {
    const ev = r.events as Record<string, unknown> | null;
    const t = ev?.tournaments as Record<string, unknown> | null;
    const org = t?.organizations as { name: string; slug: string } | null;
    const partnerRegId = r.partner_registration_id as string | null;
    return {
      regId: r.id as string,
      status: r.status as string,
      partnerStatus: r.partner_status as string,
      registeredAt: r.registered_at as string,
      partnerName: partnerRegId
        ? partnerNameById.get(partnerRegId) ?? null
        : null,
      event: ev
        ? {
            name: ev.name as string,
            format: ev.format as string,
            gender: ev.gender as string,
          }
        : null,
      tournament: t
        ? {
            name: t.name as string,
            slug: t.slug as string,
            startsAt: t.starts_at as string,
            status: t.status as string,
            orgName: org?.name ?? null,
            orgSlug: org?.slug ?? null,
          }
        : null,
    };
  });

  // Public review URL for the avatar (the bucket is public-read). Admins
  // need to SEE the image to decide whether to hide it — so we return it
  // regardless of avatar_hidden.
  const avatarUrl = player.avatar_path
    ? `${supabaseUrl}/storage/v1/object/public/avatars/${player.avatar_path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`
    : null;

  return jsonResp({ ok: true, player, account, history, avatarUrl });
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
