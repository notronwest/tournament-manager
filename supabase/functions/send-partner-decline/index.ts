// supabase/functions/send-partner-decline/index.ts
//
// Sends a decline notification to the inviter when their doubles
// partner invite is declined. Called fire-and-forget from
// PartnerAcceptPage after decline_partner_invite() succeeds.
//
// The invitee may have left an optional message (stored in
// partner_invites.decline_message); if present it is included
// verbatim in the email body (plain text — never HTML-injected).
//
// Best-effort: if the inviter has no email on file we return a soft
// error (logged, not surfaced to the player who declined).
//
// Required Supabase secrets:
//   RESEND_API_KEY        — re_… key from the Resend dashboard.
//   RESEND_FROM_ADDRESS   — verified sender, same as other partner emails.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Body = {
  inviteId: string;
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
  if (!body.inviteId) {
    return jsonResp({ error: "Missing inviteId" }, 400);
  }

  // @ts-expect-error Deno global
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  // @ts-expect-error Deno global
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // @ts-expect-error Deno global
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  // @ts-expect-error Deno global
  const fromAddress = Deno.env.get("RESEND_FROM_ADDRESS");

  if (!supabaseUrl || !serviceRole) {
    return jsonResp({ error: "Server missing Supabase config" }, 500);
  }
  if (!resendApiKey || !fromAddress) {
    return jsonResp(
      { error: "Server missing RESEND_API_KEY or RESEND_FROM_ADDRESS" },
      500,
    );
  }

  const admin = createClient(supabaseUrl, serviceRole);

  const { data: invite, error: invErr } = await admin
    .from("partner_invites")
    .select(
      `
      id, decline_message,
      inviter:players!inviter_player_id(first_name, last_name, email),
      invitee:players!invitee_player_id(first_name, last_name),
      event:events!event_id(
        name,
        tournament:tournaments!tournament_id(
          name,
          organization:organizations!organization_id(name)
        )
      )
    `,
    )
    .eq("id", body.inviteId)
    .maybeSingle();

  if (invErr) return jsonResp({ error: invErr.message }, 500);
  if (!invite) return jsonResp({ error: "Invite not found" }, 404);

  type InviteShape = {
    id: string;
    decline_message: string | null;
    inviter: {
      first_name: string;
      last_name: string;
      email: string | null;
    } | null;
    invitee: { first_name: string; last_name: string } | null;
    event: {
      name: string;
      tournament: {
        name: string;
        organization: { name: string } | null;
      } | null;
    } | null;
  };
  const inv = invite as unknown as InviteShape;

  if (
    !inv.inviter ||
    !inv.invitee ||
    !inv.event ||
    !inv.event.tournament ||
    !inv.event.tournament.organization
  ) {
    return jsonResp({ error: "Invite is missing required joins" }, 500);
  }

  const toEmail = inv.inviter.email;
  if (!toEmail) {
    // Soft error — inviter has no email on file. Log and move on.
    return jsonResp({ error: "No email on file for inviter" }, 400);
  }

  const inviterFirst = inv.inviter.first_name;
  const inviteeName = `${inv.invitee.first_name} ${inv.invitee.last_name}`;
  const eventName = inv.event.name;
  const tournamentName = inv.event.tournament.name;
  const orgName = inv.event.tournament.organization.name;
  const message = inv.decline_message ?? null;

  const subject = `${inviteeName} declined your partner invite for ${eventName}`;
  const html = renderHtml({
    inviterFirst,
    inviteeName,
    eventName,
    tournamentName,
    orgName,
    message,
  });
  const text = renderText({
    inviterFirst,
    inviteeName,
    eventName,
    tournamentName,
    orgName,
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
      to: toEmail,
      subject,
      html,
      text,
    }),
  });

  if (!resendResp.ok) {
    const errText = await resendResp.text();
    return jsonResp(
      { error: `Resend rejected the send: ${errText}` },
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

function renderHtml(v: {
  inviterFirst: string;
  inviteeName: string;
  eventName: string;
  tournamentName: string;
  orgName: string;
  message: string | null;
}): string {
  const messageBlock = v.message
    ? `<blockquote style="margin: 16px 0; padding: 12px 16px; background: #f9fafb; border-left: 3px solid #d1d5db; font-size: 14px; color: #444; line-height: 1.55;">${escapeHtml(v.message)}</blockquote>`
    : "";

  return `<!doctype html>
<html><body style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #222; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 16px; font-size: 20px;">Hi ${escapeHtml(v.inviterFirst)} —</h2>
  <p style="font-size: 15px; line-height: 1.55;">
    <strong>${escapeHtml(v.inviteeName)}</strong> declined your partner invite
    for <strong>${escapeHtml(v.eventName)}</strong> at
    <strong>${escapeHtml(v.tournamentName)}</strong>.
  </p>
  ${messageBlock}
  <p style="font-size: 15px; line-height: 1.55;">
    You can invite someone else or sign up to find a partner on the
    tournament registration page.
  </p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;">
  <p style="font-size: 12px; color: #888;">
    Sent by ${escapeHtml(v.orgName)} via Tournament Manager.
  </p>
</body></html>`;
}

function renderText(v: {
  inviterFirst: string;
  inviteeName: string;
  eventName: string;
  tournamentName: string;
  orgName: string;
  message: string | null;
}): string {
  const messageSection = v.message ? `\nTheir message:\n\n"${v.message}"\n` : "";

  return `Hi ${v.inviterFirst},

${v.inviteeName} declined your partner invite for ${v.eventName} at ${v.tournamentName}.${messageSection}
You can invite someone else or sign up to find a partner on the tournament registration page.

Sent by ${v.orgName} via Tournament Manager.
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
