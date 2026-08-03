// supabase/functions/admin-onboard-player/index.ts
//
// Admin onboarding actions for a player (attendee):
//   action 'login_link' — email the player a branded magic link that logs them
//                          in. If they have no auth account yet, one is created
//                          and LINKED to their player row server-side (so their
//                          balance / profile resolve immediately on login).
//   action 'welcome'     — re-send the branded welcome email (force-bypasses the
//                          one-time welcomed_at guard). Requires a confirmed
//                          account.
//
// generateLink only GENERATES a token — no email is sent by Supabase. We email
// the /auth/confirm link ourselves via Resend (matches the magic-link template
// that AuthConfirmPage already verifies).
//
// Authorization: platform admin OR org-staff of a provided organizationId who
// owns this attendee (a contact or a registrant of that org). Every call is
// audited.
//
// ⚠️ Deploy: supabase functions deploy admin-onboard-player
//
// POST { playerId, action: 'login_link' | 'welcome', organizationId?, next? }
// Returns { ok: true, sent: 'login_link' | 'welcome', createdAccount?: boolean }
//        | { error, code? }

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "npm:@supabase/supabase-js@2";
import { renderEmailHtml, escapeHtml } from "../_shared/email-layout.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SITE_URL = "https://bertanderne.com";

type Action = "login_link" | "welcome";
type Body = {
  playerId?: string;
  action?: Action;
  organizationId?: string;
  next?: string; // app path to land on after login (default /my-tournaments)
};

// The remote-imported supabase client is untyped in the Deno runtime.
// deno-lint-ignore no-explicit-any
type Db = any;

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    // @ts-expect-error Deno env
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    // @ts-expect-error Deno env
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    // @ts-expect-error Deno env
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    // @ts-expect-error Deno env
    const fromAddress = Deno.env.get("RESEND_FROM_ADDRESS");
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // ── 1. Authenticate ──────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const authUserId = userData.user.id;

    // ── 2. Input ─────────────────────────────────────────────────────
    const { playerId, action, organizationId, next } = (await req.json()) as Body;
    if (!playerId) return json({ error: "playerId is required" }, 400);
    if (action !== "login_link" && action !== "welcome") {
      return json({ error: "action must be 'login_link' or 'welcome'" }, 400);
    }
    if (!resendApiKey || !fromAddress) return json({ error: "server_misconfigured" }, 500);

    // ── 3. Authorize: platform admin, or org-staff who owns this attendee ─
    const isPlatform = await isPlatformAdmin(admin, authUserId);
    if (!isPlatform) {
      if (!organizationId) return json({ error: "forbidden" }, 403);
      const staff = await isOrgStaff(admin, organizationId, authUserId);
      const owns = staff && (await isOrgAttendee(admin, organizationId, playerId));
      if (!owns) return json({ error: "forbidden" }, 403);
    }

    // ── 4. Load the player ───────────────────────────────────────────
    const { data: player, error: pErr } = await admin
      .from("players")
      .select("id, first_name, last_name, email, auth_user_id")
      .eq("id", playerId)
      .is("deleted_at", null)
      .single();
    if (pErr || !player) return json({ error: "player_not_found" }, 404);
    const email = (player.email ?? "").trim();
    if (!email) {
      return json({ error: "This attendee has no email on file.", code: "no_email" }, 400);
    }

    if (action === "welcome") {
      return await doWelcome(admin, SUPABASE_URL, player, authUserId);
    }
    return await doLoginLink(admin, resendApiKey, fromAddress, player, email, next, authUserId);
  } catch (e) {
    return json({ error: "internal_error", detail: String((e as { message?: string })?.message ?? e) }, 500);
  }
});

// ── login_link: provision+link an account if needed, then email a magic link ─
async function doLoginLink(
  admin: Db,
  resendApiKey: string,
  fromAddress: string,
  player: { id: string; first_name: string | null; last_name: string | null; auth_user_id: string | null },
  email: string,
  next: string | undefined,
  actorUserId: string,
): Promise<Response> {
  let authUserId = player.auth_user_id as string | null;
  let createdAccount = false;

  // No linked account → find or create an auth user for this email, then link
  // the player row (deterministic; beats relying on the client email-match claim).
  if (!authUserId) {
    const existingId = await findAuthUserByEmail(admin, email);
    if (existingId) {
      authUserId = existingId;
    } else {
      // email_confirm:true so generateLink('magiclink') works immediately and
      // login is frictionless — the person still must receive + click the link
      // (ownership proof). Note: this fires the welcome-email trigger, so a new
      // attendee also gets the welcome email — acceptable during onboarding.
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
      });
      if (cErr || !created?.user?.id) {
        return json({ error: `Could not create an account: ${cErr?.message ?? "unknown"}` }, 502);
      }
      authUserId = created.user.id;
      createdAccount = true;
    }
    // Link the player row (only if still unlinked and emails match — safe).
    const { error: linkErr } = await admin
      .from("players")
      .update({ auth_user_id: authUserId })
      .eq("id", player.id)
      .is("auth_user_id", null);
    if (linkErr) return json({ error: `Could not link the account: ${linkErr.message}` }, 500);
  }

  // Mint a magic-link token (no email delivered by Supabase).
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: SITE_URL },
  });
  const tokenHash = (linkData?.properties as { hashed_token?: string } | undefined)?.hashed_token;
  if (linkErr || !tokenHash) {
    return json({ error: linkErr?.message ?? "Could not generate a login link." }, 502);
  }

  const nextPath = sanitizeNext(next);
  const loginUrl =
    `${SITE_URL}/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}` +
    `&type=magiclink&next=${encodeURIComponent(nextPath)}`;

  const firstName = (player.first_name ?? "").trim();
  const html = renderEmailHtml({
    heading: firstName ? `Hi ${escapeHtml(firstName)} —` : "Your login link",
    bodyHtml: `<p style="margin:0 0 16px;font-size:15px;color:#4a5159;line-height:1.6;">
      Tap the button below to sign in to your bert &amp; erne account — no password needed.
      You'll land right where you need to be to register and pay.
    </p>
    <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.6;">
      This link is single-use and expires shortly. If you didn't expect it, you can ignore this email.
    </p>`,
    ctaLabel: "Log in",
    ctaUrl: loginUrl,
  });

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: fromAddress,
      to: email,
      subject: "Your bert & erne login link",
      html,
      text: `Sign in to bert & erne: ${loginUrl}\n\nThis link is single-use and expires shortly.`,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    return json({ error: `Email send failed: ${t}` }, 502);
  }

  await audit(admin, actorUserId, player.id, "onboard_login_link", { email, created_account: createdAccount });
  return json({ ok: true, sent: "login_link", createdAccount });
}

// ── welcome: force-resend the branded welcome email ──────────────────
async function doWelcome(
  admin: Db,
  supabaseUrl: string,
  player: { id: string; auth_user_id: string | null },
  actorUserId: string,
): Promise<Response> {
  const authUserId = player.auth_user_id as string | null;
  if (!authUserId) {
    return json(
      { error: "This attendee hasn't signed up yet — send a login link instead.", code: "no_account" },
      400,
    );
  }
  const { data: u } = await admin.auth.admin.getUserById(authUserId);
  if (!u?.user?.email_confirmed_at) {
    return json(
      { error: "This attendee's email isn't confirmed yet — send a login link instead.", code: "not_confirmed" },
      400,
    );
  }
  // Reuse the single source of welcome content. send-welcome-email is deployed
  // --no-verify-jwt; force bypasses its one-time guard.
  const resp = await fetch(`${supabaseUrl}/functions/v1/send-welcome-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: authUserId, force: true }),
  });
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok || (out && out.sent !== true)) {
    return json({ error: `Welcome email not sent: ${out?.skipped ?? out?.error ?? `http_${resp.status}`}` }, 502);
  }
  await audit(admin, actorUserId, player.id, "onboard_welcome", {});
  return json({ ok: true, sent: "welcome" });
}

// ── helpers ──────────────────────────────────────────────────────────
async function findAuthUserByEmail(admin: Db, email: string): Promise<string | null> {
  // getUserById-by-email isn't available; scan the first page (admin-created
  // attendees are rare enough that the exact-email match here is sufficient).
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const target = email.toLowerCase();
  const match = (data?.users ?? []).find(
    (u: { id: string; email?: string | null }) => (u.email ?? "").toLowerCase() === target,
  );
  return match?.id ?? null;
}

async function isPlatformAdmin(admin: Db, authUserId: string): Promise<boolean> {
  const { data } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", authUserId)
    .maybeSingle();
  return !!data;
}

async function isOrgStaff(admin: Db, organizationId: string, authUserId: string): Promise<boolean> {
  const { data } = await admin
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("user_id", authUserId)
    .maybeSingle();
  return !!data;
}

// The player must belong to this org: a contact of it, or a registrant in one
// of its tournaments — so org staff can't onboard arbitrary platform players.
async function isOrgAttendee(admin: Db, organizationId: string, playerId: string): Promise<boolean> {
  const { data: contact } = await admin
    .from("organization_contacts")
    .select("player_id")
    .eq("organization_id", organizationId)
    .eq("player_id", playerId)
    .is("deleted_at", null)
    .maybeSingle();
  if (contact) return true;

  const { data: tourneys } = await admin
    .from("tournaments")
    .select("id")
    .eq("organization_id", organizationId)
    .is("deleted_at", null);
  const tids = (tourneys ?? []).map((t: { id: string }) => t.id);
  if (tids.length === 0) return false;
  const { data: events } = await admin
    .from("events")
    .select("id")
    .in("tournament_id", tids)
    .is("deleted_at", null);
  const eids = (events ?? []).map((e: { id: string }) => e.id);
  if (eids.length === 0) return false;
  const { data: reg } = await admin
    .from("event_registrations")
    .select("id")
    .in("event_id", eids)
    .eq("player_id", playerId)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  return !!reg;
}

// Only allow an in-app relative path as the post-login landing (never an
// external URL) — this becomes ?next= that AuthConfirmPage navigates to.
function sanitizeNext(next: string | undefined): string {
  const n = (next ?? "").trim();
  if (n.startsWith("/") && !n.startsWith("//")) return n;
  return "/my-tournaments";
}

async function audit(admin: Db, actorUserId: string, playerId: string, action: string, data: unknown): Promise<void> {
  try {
    await admin.from("audit_log").insert({
      actor_user_id: actorUserId,
      entity_type: "player",
      entity_id: playerId,
      action,
      data,
    });
  } catch {
    // audit failure shouldn't block a legitimate admin action
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
