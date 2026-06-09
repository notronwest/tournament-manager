// supabase/functions/submit-contact-form/index.ts
//
// Public "Contact the organizers" form for a tournament (issue #38).
// Anyone viewing a tournament can send a question; this function:
//   1. salted-hashes the caller's IP,
//   2. throttles to 3 submissions per IP per 10 minutes (DB-backed,
//      counting recent contact_form_submissions rows),
//   3. records the submission (service_role — there is no client
//      INSERT policy, so this is the only write path / audit trail),
//   4. emails every contact flagged receives_form_messages via Resend,
//      with Reply-To set to the sender so the organizer can reply.
//
// Required Supabase secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — auto-injected at runtime.
//   RESEND_API_KEY, RESEND_FROM_ADDRESS      — already set (partner invites use them).
//   CONTACT_FORM_IP_SALT                     — random string; salts the IP hash
//                                              so raw IPs are never stored.
//
// This function is invoked anonymously (no auth) by design — it's a
// public form. The throttle + input limits are the abuse guard.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PER_WINDOW = 3; // per IP per window

const MAX_NAME = 120;
const MAX_EMAIL = 200;
const MAX_MESSAGE = 5000;

type Body = {
  tournamentId: string;
  senderName: string;
  senderEmail: string;
  message: string;
};

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

  // ── Validate input ───────────────────────────────────────────────
  const tournamentId = (body.tournamentId || "").trim();
  const senderName = (body.senderName || "").trim();
  const senderEmail = (body.senderEmail || "").trim();
  const message = (body.message || "").trim();

  if (!tournamentId || !senderName || !senderEmail || !message) {
    return jsonResp(
      { error: "Name, email, and message are all required." },
      400,
    );
  }
  if (
    senderName.length > MAX_NAME ||
    senderEmail.length > MAX_EMAIL ||
    message.length > MAX_MESSAGE
  ) {
    return jsonResp({ error: "One of your fields is too long." }, 400);
  }
  // Light email shape check — the real validation is whether a reply lands.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
    return jsonResp({ error: "That email address doesn't look right." }, 400);
  }

  // @ts-expect-error Deno global
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  // @ts-expect-error Deno global
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // @ts-expect-error Deno global
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  // @ts-expect-error Deno global
  const fromAddress = Deno.env.get("RESEND_FROM_ADDRESS");
  // @ts-expect-error Deno global
  const ipSalt = Deno.env.get("CONTACT_FORM_IP_SALT");

  if (!supabaseUrl || !serviceRole) {
    return jsonResp({ error: "Server missing Supabase config" }, 500);
  }
  if (!ipSalt) {
    return jsonResp({ error: "Server missing CONTACT_FORM_IP_SALT" }, 500);
  }
  if (!resendApiKey || !fromAddress) {
    return jsonResp(
      { error: "Server missing RESEND_API_KEY or RESEND_FROM_ADDRESS" },
      500,
    );
  }

  const admin = createClient(supabaseUrl, serviceRole);

  // ── Salted IP hash (raw IP never stored) ─────────────────────────
  const rawIp =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const ipHash = await sha256Hex(`${ipSalt}:${rawIp}`);

  // ── Throttle: count this IP's recent submissions ─────────────────
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  const { count, error: countErr } = await admin
    .from("contact_form_submissions")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash)
    .gte("created_at", cutoff);

  if (countErr) return jsonResp({ error: countErr.message }, 500);
  if ((count ?? 0) >= MAX_PER_WINDOW) {
    return jsonResp(
      {
        error:
          "You've sent a few messages in a short window. Please wait a few minutes and try again.",
      },
      429,
    );
  }

  // ── Load tournament + recipient contacts in one round trip ───────
  const { data: tournament, error: tErr } = await admin
    .from("tournaments")
    .select(
      `
      id, name,
      organization:organizations!organization_id(name),
      contacts:tournament_contacts(name, email, receives_form_messages, deleted_at)
    `,
    )
    .eq("id", tournamentId)
    .is("deleted_at", null)
    .maybeSingle();

  if (tErr) return jsonResp({ error: tErr.message }, 500);
  if (!tournament) return jsonResp({ error: "Tournament not found." }, 404);

  type TournamentShape = {
    id: string;
    name: string;
    organization: { name: string } | null;
    contacts: Array<{
      name: string;
      email: string | null;
      receives_form_messages: boolean;
      deleted_at: string | null;
    }> | null;
  };
  const t = tournament as unknown as TournamentShape;

  const recipients = (t.contacts ?? [])
    .filter((c) => c.receives_form_messages && !c.deleted_at && c.email)
    .map((c) => c.email as string);

  // ── Record the submission (audit + throttle source of truth) ─────
  const { error: insErr } = await admin
    .from("contact_form_submissions")
    .insert({
      tournament_id: t.id,
      sender_name: senderName,
      sender_email: senderEmail,
      message,
      ip_hash: ipHash,
    });
  if (insErr) return jsonResp({ error: insErr.message }, 500);

  // No recipient configured → the message is logged for the organizer,
  // but there's no one to email. Succeed quietly; they'll see it once
  // an admin queue exists, and the org just needs to flag a contact.
  if (recipients.length === 0) {
    return jsonResp({ ok: true, emailed: 0 });
  }

  // ── Fan out the email ────────────────────────────────────────────
  const orgName = t.organization?.name ?? "the organizers";
  const subject = `Contact form: ${t.name}`;
  const html = renderHtml({
    tournamentName: t.name,
    orgName,
    senderName,
    senderEmail,
    message,
  });
  const text = renderText({
    tournamentName: t.name,
    senderName,
    senderEmail,
    message,
  });

  const resendResp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: recipients,
      reply_to: senderEmail,
      subject,
      html,
      text,
    }),
  });

  if (!resendResp.ok) {
    const errText = await resendResp.text();
    // The submission is already recorded; report the email failure so
    // the client can tell the user their message was saved but the
    // notification may be delayed.
    return jsonResp(
      { error: `Saved, but the notification email failed: ${errText}` },
      502,
    );
  }

  return jsonResp({ ok: true, emailed: recipients.length });
});

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  // @ts-expect-error Web Crypto available in Deno runtime
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function renderHtml(v: {
  tournamentName: string;
  orgName: string;
  senderName: string;
  senderEmail: string;
  message: string;
}): string {
  return `<!doctype html>
<html><body style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #222; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 8px; font-size: 20px;">New message about ${escapeHtml(v.tournamentName)}</h2>
  <p style="font-size: 13px; color: #666; margin: 0 0 16px;">Sent via the public contact form.</p>
  <table style="font-size: 14px; line-height: 1.5; margin-bottom: 16px;">
    <tr><td style="color:#666; padding-right: 10px;">From</td><td><strong>${escapeHtml(v.senderName)}</strong></td></tr>
    <tr><td style="color:#666; padding-right: 10px;">Email</td><td><a href="mailto:${escapeHtml(v.senderEmail)}" style="color:#2563eb;">${escapeHtml(v.senderEmail)}</a></td></tr>
  </table>
  <div style="font-size: 15px; line-height: 1.6; white-space: pre-wrap; border-left: 3px solid #e5e7eb; padding-left: 14px;">${escapeHtml(v.message)}</div>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0;">
  <p style="font-size: 12px; color: #888;">Reply directly to this email to respond to ${escapeHtml(v.senderName)} — it's addressed to them. Sent on behalf of ${escapeHtml(v.orgName)}.</p>
</body></html>`;
}

function renderText(v: {
  tournamentName: string;
  senderName: string;
  senderEmail: string;
  message: string;
}): string {
  return `New message about ${v.tournamentName} (via the public contact form)

From: ${v.senderName}
Email: ${v.senderEmail}

${v.message}

— Reply directly to this email to respond; it's addressed to the sender.
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
