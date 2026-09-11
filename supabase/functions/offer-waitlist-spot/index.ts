// supabase/functions/offer-waitlist-spot/index.ts
//
// Organizer offers an open spot to a waitlisted player. Flips the registration
// from 'waitlisted' to 'waitlisted_pending_payment' (spot reserved — pay to
// claim, the same state promote_from_waitlist produces) and EMAILS the player a
// link to claim it. Until now a promoted player was never told: the only
// signal was a "pay to claim" line on the public page if they happened to
// visit. This closes that gap for organizer-driven offers.
//
// Also re-sends the offer email for a registration that is already in
// 'waitlisted_pending_payment' (e.g. promoted automatically by withdraw_self),
// so the organizer can nudge someone who hasn't paid.
//
// ORG-STAFF only (member of the tournament's org, or a platform admin).
//
// Body:    { registrationId: string }
// Returns: { registrationId, status, emailed: boolean, email?: string, detail?: string }
//
// Required secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Required secrets (set per project): RESEND_API_KEY, RESEND_FROM_ADDRESS.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { renderEmailHtml, escapeHtml } from "../_shared/email-layout.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SITE_URL = "https://bertanderne.com";

type Body = { registrationId?: string };

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
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    // @ts-expect-error Deno env
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    // @ts-expect-error Deno env
    const rawFrom = Deno.env.get("RESEND_FROM_ADDRESS");

    // ── 1. Caller ────────────────────────────────────────────────────
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const authUserId = userData.user.id;

    // ── 2. Input + registration ─────────────────────────────────────
    const { registrationId } = (await req.json()) as Body;
    if (!registrationId) return json({ error: "registrationId is required" }, 400);

    const { data: reg, error: regErr } = await admin
      .from("event_registrations")
      .select(
        "id, status, player_id, event_id, events!inner(id, name, tournament_id, tournaments!inner(id, name, slug, organization_id, organizations!inner(id, name, slug, contact_email)))",
      )
      .eq("id", registrationId)
      .is("deleted_at", null)
      .maybeSingle();
    if (regErr) throw new Error(`registration: ${regErr.message}`);
    if (!reg) return json({ error: "registration_not_found" }, 404);

    type Joined = {
      id: string;
      status: string;
      player_id: string;
      events: {
        id: string;
        name: string;
        tournaments: {
          id: string;
          name: string;
          slug: string;
          organization_id: string;
          organizations: { id: string; name: string; slug: string; contact_email: string | null };
        };
      };
    };
    const r = reg as unknown as Joined;
    const event = r.events;
    const t = event.tournaments;
    const org = t.organizations;

    if (!(await isOrgStaff(admin, t.organization_id, authUserId))) {
      return json({ error: "forbidden_org_staff_only" }, 403);
    }
    if (r.status !== "waitlisted" && r.status !== "waitlisted_pending_payment") {
      return json({ error: "not_on_waitlist", status: r.status }, 409);
    }

    // ── 3. Reserve the spot (idempotent for an already-offered reg) ──
    if (r.status === "waitlisted") {
      const { error: upErr } = await admin
        .from("event_registrations")
        .update({ status: "waitlisted_pending_payment", waitlist_position: null, updated_at: new Date().toISOString() })
        .eq("id", r.id)
        .eq("status", "waitlisted");
      if (upErr) throw new Error(`promote: ${upErr.message}`);
    }

    // ── 4. Email the player ─────────────────────────────────────────
    const { data: player } = await admin
      .from("players")
      .select("id, first_name, last_name, email")
      .eq("id", r.player_id)
      .maybeSingle();
    const email = ((player?.email ?? "") as string).trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return json({ registrationId: r.id, status: "waitlisted_pending_payment", emailed: false, detail: "player has no email address" });
    }
    if (!resendApiKey || !rawFrom) {
      return json({ registrationId: r.id, status: "waitlisted_pending_payment", emailed: false, detail: "email not configured" });
    }

    const claimUrl = `${SITE_URL}/t/${org.slug}/${t.slug}`;
    const P = `margin:0 0 14px;font-size:15px;color:#4a5159;line-height:1.6;`;
    const html = renderEmailHtml({
      headingLabel: org.name,
      heading: `A spot opened in ${event.name}`,
      bodyHtml: `
        <p style="${P}">Hi ${escapeHtml(((player?.first_name ?? "") as string).trim() || "there")},</p>
        <p style="${P}">Good news — a spot has opened up for you in <strong>${escapeHtml(event.name)}</strong> at <strong>${escapeHtml(t.name)}</strong>. It's reserved for you right now.</p>
        <p style="${P}">To claim it, open the tournament page, find ${escapeHtml(event.name)} and complete your payment. Please do this as soon as you can — if we don't hear from you, the spot goes to the next player on the waitlist.</p>`,
      ctaLabel: "Claim my spot",
      ctaUrl: claimUrl,
      postBodyHtml: `<p style="${P}margin-top:20px;">Can't make it after all? Just reply to this email and we'll pass the spot along.</p>`,
      footer: `${escapeHtml(org.name)} via bert &amp; erne &mdash; pickleball tournaments<br />You're receiving this because you joined the waitlist for ${escapeHtml(event.name)}.`,
    });

    const replyTo = org.contact_email || userData.user.email || undefined;
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: normalizeFrom(rawFrom),
        to: [email],
        subject: `A spot opened in ${event.name} — ${t.name}`,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      console.error("resend failed", detail);
      return json({ registrationId: r.id, status: "waitlisted_pending_payment", emailed: false, email, detail });
    }
    return json({ registrationId: r.id, status: "waitlisted_pending_payment", emailed: true, email });
  } catch (e) {
    return json(
      { error: "internal_error", detail: String((e as { message?: string })?.message ?? e) },
      500,
    );
  }
});

function normalizeFrom(raw: string): string {
  const s = raw.trim().replace(/[\r\n]+/g, " ");
  const m = s.match(/^(.*?)\s*<\s*([^<>]+?)\s*>\s*$/);
  if (!m) return s;
  const name = m[1].trim().replace(/"/g, "").trim();
  const address = m[2].trim();
  return name ? `"${name}" <${address}>` : address;
}

async function isOrgStaff(admin: Db, organizationId: string, authUserId: string): Promise<boolean> {
  const { data: staffRow } = await admin
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("user_id", authUserId)
    .maybeSingle();
  if (staffRow) return true;
  const { data: padmin } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", authUserId)
    .maybeSingle();
  return !!padmin;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
