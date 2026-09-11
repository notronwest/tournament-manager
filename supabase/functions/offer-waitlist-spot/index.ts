// supabase/functions/offer-waitlist-spot/index.ts
//
// Organizer offers an open spot to a waitlisted player. Flips the registration
// from 'waitlisted' to 'waitlisted_pending_payment' (spot reserved — pay to
// claim, the same state promote_from_waitlist produces) and EMAILS the player a
// link to claim it. Until now a promoted player was never told: the only
// signal was a "pay to claim" line on the public page if they happened to
// visit. This closes that gap for organizer-driven offers.
//
// If the registration has a CONFIRMED doubles partner who is also 'waitlisted',
// the partner is promoted and emailed alongside — mirrors promote_from_waitlist
// (DB), which already carries the confirmed partner along. A team is never left
// half on the waitlist / half pay-to-claim. A partner who is already paid,
// pending payment, or otherwise not 'waitlisted' is left untouched.
//
// Also re-sends the offer email for a registration that is already in
// 'waitlisted_pending_payment' (e.g. promoted automatically by withdraw_self),
// so the organizer can nudge someone who hasn't paid.
//
// ORG-STAFF only (member of the tournament's org, or a platform admin).
//
// Body:    { registrationId: string }
// Returns: {
//   registrationId, status, emailed: boolean, email?: string, detail?: string,
//   partner?: { registrationId: string, promoted: boolean, emailed: boolean, email?: string, detail?: string }
// }
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
        "id, status, player_id, event_id, partner_registration_id, partner_status, events!inner(id, name, tournament_id, tournaments!inner(id, name, slug, organization_id, organizations!inner(id, name, slug, contact_email)))",
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
      event_id: string;
      partner_registration_id: string | null;
      partner_status: string;
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

    const wasFreshOffer = r.status === "waitlisted";

    // ── 3. Reserve the spot (idempotent for an already-offered reg) ──
    if (wasFreshOffer) {
      const { error: upErr } = await admin
        .from("event_registrations")
        .update({ status: "waitlisted_pending_payment", waitlist_position: null, updated_at: new Date().toISOString() })
        .eq("id", r.id)
        .eq("status", "waitlisted");
      if (upErr) throw new Error(`promote: ${upErr.message}`);
    }

    // ── 3b. Carry a CONFIRMED, still-waitlisted partner along ────────
    // Mirrors promote_from_waitlist (DB): a doubles team is never left half
    // promoted. Only on a fresh offer — a partner already paid / pending /
    // otherwise off the waitlist is untouched.
    let partnerRow: { id: string; player_id: string } | null = null;
    if (wasFreshOffer && r.partner_registration_id && r.partner_status === "confirmed") {
      const { data: partnerReg } = await admin
        .from("event_registrations")
        .select("id, player_id, status")
        .eq("id", r.partner_registration_id)
        .eq("event_id", r.event_id)
        .is("deleted_at", null)
        .maybeSingle();
      if (partnerReg && partnerReg.status === "waitlisted") {
        const { error: partnerUpErr } = await admin
          .from("event_registrations")
          .update({ status: "waitlisted_pending_payment", waitlist_position: null, updated_at: new Date().toISOString() })
          .eq("id", partnerReg.id)
          .eq("status", "waitlisted");
        if (partnerUpErr) throw new Error(`promote_partner: ${partnerUpErr.message}`);
        partnerRow = { id: partnerReg.id, player_id: partnerReg.player_id };
      }
    }

    // ── 4. Email the player(s) ────────────────────────────────────────
    const primary = await sendOfferEmail(admin, r.player_id, event, t, org, resendApiKey, rawFrom, userData.user.email);
    const result: Record<string, unknown> = {
      registrationId: r.id,
      status: "waitlisted_pending_payment",
      emailed: primary.emailed,
      ...(primary.email ? { email: primary.email } : {}),
      ...(primary.detail ? { detail: primary.detail } : {}),
    };

    if (partnerRow) {
      const partnerEmail = await sendOfferEmail(admin, partnerRow.player_id, event, t, org, resendApiKey, rawFrom, userData.user.email);
      result.partner = {
        registrationId: partnerRow.id,
        promoted: true,
        emailed: partnerEmail.emailed,
        ...(partnerEmail.email ? { email: partnerEmail.email } : {}),
        ...(partnerEmail.detail ? { detail: partnerEmail.detail } : {}),
      };
    }

    return json(result);
  } catch (e) {
    return json(
      { error: "internal_error", detail: String((e as { message?: string })?.message ?? e) },
      500,
    );
  }
});

type EventInfo = { id: string; name: string };
type TournamentInfo = { id: string; name: string; slug: string };
type OrgInfo = { id: string; name: string; slug: string; contact_email: string | null };

async function sendOfferEmail(
  admin: Db,
  playerId: string,
  event: EventInfo,
  t: TournamentInfo,
  org: OrgInfo,
  resendApiKey: string | undefined,
  rawFrom: string | undefined,
  callerEmail: string | undefined,
): Promise<{ emailed: boolean; email?: string; detail?: string }> {
  const { data: player } = await admin
    .from("players")
    .select("id, first_name, last_name, email")
    .eq("id", playerId)
    .maybeSingle();
  const email = ((player?.email ?? "") as string).trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { emailed: false, detail: "player has no email address" };
  }
  if (!resendApiKey || !rawFrom) {
    return { emailed: false, detail: "email not configured" };
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

  const replyTo = org.contact_email || callerEmail || undefined;
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
    return { emailed: false, email, detail };
  }
  return { emailed: true, email };
}

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
