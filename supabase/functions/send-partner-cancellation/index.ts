// supabase/functions/send-partner-cancellation/index.ts
//
// Sends a "you're no longer their partner" email when a registrant
// changes their doubles partner mid-tournament. The client invokes
// this with the cancelled partner_invites row's id; we load enough
// context (the dropped partner's name + email, the event name, the
// inviter's name) to write a polite, non-accusatory message.
//
// The cancellation email is intentionally calm: there are many
// legitimate reasons to swap partners (work conflict, injury, just
// found a stronger match) and we don't want the dropped partner to
// feel ambushed. The message includes the inviter's name so the
// recipient knows who to contact if they think this was a mistake.
//
// Required Supabase secrets:
//   RESEND_API_KEY        — re_… key from the Resend dashboard.
//   RESEND_FROM_ADDRESS   — verified sender, same format as
//                           send-partner-invite.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "npm:@supabase/supabase-js@2";
import { renderEmailHtml, escapeHtml } from "../_shared/email-layout.ts";

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
      id, invitee_email,
      inviter:players!inviter_player_id(first_name, last_name),
      invitee:players!invitee_player_id(first_name, last_name, email),
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
    invitee_email: string | null;
    inviter: { first_name: string; last_name: string } | null;
    invitee: {
      first_name: string;
      last_name: string;
      email: string | null;
    } | null;
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

  // Email priority: the invitee's player.email beats the snapshotted
  // invitee_email on the invite row, since the player may have
  // updated their address since the invite was sent.
  const toEmail = inv.invitee.email ?? inv.invitee_email;
  if (!toEmail) {
    return jsonResp({ error: "No email on file for invitee" }, 400);
  }

  const inviterName = `${inv.inviter.first_name} ${inv.inviter.last_name}`;
  const inviteeFirst = inv.invitee.first_name;
  const eventName = inv.event.name;
  const tournamentName = inv.event.tournament.name;
  const orgName = inv.event.tournament.organization.name;

  const subject = `${inviterName} changed partners for ${eventName}`;
  const html = renderEmailHtml({
    heading: `Hi ${inviteeFirst} —`,
    bodyHtml: `<p style="margin:0 0 16px;font-size:15px;color:#4a5159;line-height:1.6;">
      A heads-up: <strong>${escapeHtml(inviterName)}</strong> changed
      partners for <strong>${escapeHtml(eventName)}</strong> at
      <strong>${escapeHtml(tournamentName)}</strong>, so your spot in
      that event has been released.
    </p>
    <p style="margin:0;font-size:15px;color:#4a5159;line-height:1.6;">
      No action needed from you. If you think this was a mistake or
      you'd like to play that event, reach out to
      ${escapeHtml(inviterName)} directly or sign up for the event
      with a different partner.
    </p>`,
    footer: `Sent by ${escapeHtml(orgName)} via bert &amp; erne tournaments.`,
  });
  const text = renderText({
    inviteeFirst,
    inviterName,
    eventName,
    tournamentName,
    orgName,
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

function renderText(v: {
  inviteeFirst: string;
  inviterName: string;
  eventName: string;
  tournamentName: string;
  orgName: string;
}): string {
  return `Hi ${v.inviteeFirst},

A heads-up: ${v.inviterName} changed partners for ${v.eventName} at ${v.tournamentName}, so your spot in that event has been released.

No action needed from you. If you think this was a mistake or you'd like to play that event, reach out to ${v.inviterName} directly or sign up for the event with a different partner.

Sent by ${v.orgName} via bert & erne tournaments.
`;
}
