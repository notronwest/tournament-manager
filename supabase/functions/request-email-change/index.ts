// supabase/functions/request-email-change/index.ts
//
// Notifies the site administrator that a signed-in user wants their
// login email changed (issue #154). The user cannot change their own
// auth email directly; this function routes the request to the admin
// who processes it via the Supabase dashboard.
//
// Required Supabase secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — auto-injected at runtime.
//   RESEND_API_KEY, RESEND_FROM_ADDRESS      — already set (partner invites use them).
//   SITE_ADMIN_EMAIL                         — recipient for admin notifications.
//
// Auth: caller must supply a valid Bearer JWT (forwarded automatically
// by supabase.functions.invoke with the user's session). The user's
// current email is read from auth via the JWT — callers cannot forge
// their own identity.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_EMAIL = 200;

type Body = {
  requestedEmail: string;
};

// @ts-expect-error Deno global in edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResp({ error: "Method not allowed" }, 405);
  }

  // ── Verify caller identity ───────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResp({ error: "Unauthorized" }, 401);
  const token = authHeader.replace("Bearer ", "");

  // @ts-expect-error Deno global
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  // @ts-expect-error Deno global
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // @ts-expect-error Deno global
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  // @ts-expect-error Deno global
  const fromAddress = Deno.env.get("RESEND_FROM_ADDRESS");
  // @ts-expect-error Deno global
  const adminEmail = Deno.env.get("SITE_ADMIN_EMAIL");

  if (!supabaseUrl || !serviceRole) {
    return jsonResp({ error: "Server missing Supabase config" }, 500);
  }
  if (!resendApiKey || !fromAddress) {
    return jsonResp({ error: "Server missing RESEND config" }, 500);
  }
  if (!adminEmail) {
    return jsonResp({ error: "Server missing SITE_ADMIN_EMAIL" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRole);

  const {
    data: { user },
    error: authErr,
  } = await admin.auth.getUser(token);
  if (authErr || !user) return jsonResp({ error: "Unauthorized" }, 401);

  // ── Parse + validate body ────────────────────────────────────────
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResp({ error: "Invalid JSON body" }, 400);
  }

  const requestedEmail = (body.requestedEmail || "").trim().toLowerCase();
  if (!requestedEmail) {
    return jsonResp({ error: "New email address is required." }, 400);
  }
  if (requestedEmail.length > MAX_EMAIL) {
    return jsonResp({ error: "Email address is too long." }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requestedEmail)) {
    return jsonResp(
      { error: "That email address doesn't look right." },
      400,
    );
  }

  const currentEmail = (user.email ?? "").toLowerCase();
  if (requestedEmail === currentEmail) {
    return jsonResp(
      { error: "The new address matches your current email." },
      400,
    );
  }

  // ── Send notification to admin ───────────────────────────────────
  const html = `<!doctype html>
<html><body style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #222; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 8px; font-size: 20px;">Email change request</h2>
  <p style="font-size: 13px; color: #666; margin: 0 0 16px;">A signed-in user has requested a change to their login email address.</p>
  <table style="font-size: 14px; line-height: 1.8; margin-bottom: 16px;">
    <tr><td style="color:#666; padding-right: 12px; white-space: nowrap;">User ID</td><td style="font-family: monospace; font-size: 13px;">${escapeHtml(user.id)}</td></tr>
    <tr><td style="color:#666; padding-right: 12px; white-space: nowrap;">Current email</td><td>${escapeHtml(user.email ?? "(none)")}</td></tr>
    <tr><td style="color:#666; padding-right: 12px; white-space: nowrap;">Requested email</td><td><strong>${escapeHtml(requestedEmail)}</strong></td></tr>
  </table>
  <p style="font-size: 13px; color: #888; border-top: 1px solid #e5e7eb; padding-top: 16px; margin-top: 0;">
    To process: Supabase dashboard → Authentication → Users → find by User ID → update email.
  </p>
</body></html>`;

  const text = `Email change request

User ID:        ${user.id}
Current email:  ${user.email ?? "(none)"}
Requested:      ${requestedEmail}

To process: Supabase dashboard → Authentication → Users → find by User ID → update email.
`;

  const resendResp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [adminEmail],
      subject: "Email change request",
      html,
      text,
    }),
  });

  if (!resendResp.ok) {
    const errText = await resendResp.text();
    return jsonResp(
      { error: `Failed to send notification: ${errText}` },
      502,
    );
  }

  return jsonResp({ ok: true });
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
