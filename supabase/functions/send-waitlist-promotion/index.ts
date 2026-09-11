// supabase/functions/send-waitlist-promotion/index.ts
//
// Emails a player that a reserved spot is waiting for them after they were
// AUTOMATICALLY promoted off the waitlist — the DB has already flipped
// their registration to 'waitlisted_pending_payment' (via
// cancel_registration or withdraw_self calling promote_from_waitlist).
// This function only sends the notification; it never changes any status.
//
// Invoked best-effort, fire-and-forget, straight from the client right
// after a promoting RPC call returns a promoted_reg_id — same pattern as
// send-partner-withdrawal. No ownership check on the caller (matches that
// function's bar): the worst a malformed regId can do is re-send an email
// the player is already entitled to receive.
//
// Body:    { regId: string }
// Returns: { ok: true, emailed: boolean, skipped?: string }
//
// Required secrets: RESEND_API_KEY, RESEND_FROM_ADDRESS.

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

type Body = { regId?: string };

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResp({ error: "Method not allowed" }, 405);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResp({ error: "Invalid JSON body" }, 400);
  }
  if (!body.regId) {
    return jsonResp({ error: "Missing regId" }, 400);
  }

  // @ts-expect-error Deno global
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  // @ts-expect-error Deno global
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // @ts-expect-error Deno global
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  // @ts-expect-error Deno global
  const rawFrom = Deno.env.get("RESEND_FROM_ADDRESS");

  if (!supabaseUrl || !serviceRole) {
    return jsonResp({ error: "Server missing Supabase config" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRole);

  const { data: reg, error: regErr } = await admin
    .from("event_registrations")
    .select(
      `
      id,
      status,
      player_id,
      event_id,
      events!inner (
        id,
        name,
        tournaments!inner (
          id,
          name,
          slug,
          organizations!inner ( id, name, slug, contact_email )
        )
      )
    `,
    )
    .eq("id", body.regId)
    .maybeSingle();

  if (regErr) return jsonResp({ error: regErr.message }, 500);
  if (!reg) return jsonResp({ ok: true, emailed: false, skipped: "not_found" });

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
        organizations: { id: string; name: string; slug: string; contact_email: string | null };
      };
    };
  };
  const r = reg as unknown as Joined;

  // Defensive: only email while the reg is genuinely sitting in the
  // reserved-but-unpaid state — never spam a since-paid or since-cancelled
  // registration.
  if (r.status !== "waitlisted_pending_payment") {
    return jsonResp({ ok: true, emailed: false, skipped: "not_promoted" });
  }

  const event = r.events;
  const t = event.tournaments;
  const org = t.organizations;

  if (!resendApiKey || !rawFrom) {
    return jsonResp({ ok: true, emailed: false, skipped: "email_not_configured" });
  }

  const { data: player } = await admin
    .from("players")
    .select("first_name, email")
    .eq("id", r.player_id)
    .maybeSingle();

  const email = ((player?.email ?? "") as string).trim().toLowerCase();
  if (!email || !email.includes("@") || isObviouslyFakeEmail(email)) {
    return jsonResp({ ok: true, emailed: false, skipped: "no_usable_email" });
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
    postBodyHtml: `<p style="${P}margin-top:20px;">Can't make it after all? You can decline from the tournament page and we'll pass the spot along.</p>`,
    footer: `${escapeHtml(org.name)} via bert &amp; erne &mdash; pickleball tournaments<br />You're receiving this because you joined the waitlist for ${escapeHtml(event.name)}.`,
  });

  const replyTo = org.contact_email || undefined;
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
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
    return jsonResp({ ok: true, emailed: false, skipped: "resend_error", detail }, 200);
  }

  return jsonResp({ ok: true, emailed: true });
});

function normalizeFrom(raw: string): string {
  const s = raw.trim().replace(/[\r\n]+/g, " ");
  const m = s.match(/^(.*?)\s*<\s*([^<>]+?)\s*>\s*$/);
  if (!m) return s;
  const name = m[1].trim().replace(/"/g, "").trim();
  const address = m[2].trim();
  return name ? `"${name}" <${address}>` : address;
}

function isObviouslyFakeEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  if (e.endsWith(".test")) return true;
  if (
    e.endsWith("@example.com") ||
    e.endsWith("@example.net") ||
    e.endsWith("@example.org")
  ) {
    return true;
  }
  return false;
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
