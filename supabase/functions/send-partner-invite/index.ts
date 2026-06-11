// supabase/functions/send-partner-invite/index.ts
//
// Sends the doubles-partner invite email via Resend after the
// RegisterPage inserts a partner_invites row. The client invokes
// this function with the invite's id; the function loads enough
// context (inviter, invitee, event, tournament, org) to compose a
// useful email and POSTs it to the Resend API.
//
// Required Supabase secrets:
//   RESEND_API_KEY        — re_… key from the Resend dashboard.
//   RESEND_FROM_ADDRESS   — verified sender, e.g.
//                           "WMPC Tournaments <invites@whitemountainpickleball.com>".
//                           Resend's onboarding sandbox sender
//                           (onboarding@resend.dev) works for
//                           testing before you've verified a domain.
//
// The function uses the service_role key (auto-injected by the
// Edge Functions runtime) to read across tables — partner_invites'
// RLS would otherwise block reads issued from this anon context.
// We never expose the row back to the caller; we only echo
// {ok:true} or {error:…}.
//
// Auth: the function trusts whoever invokes it (no explicit caller
// check). The only way to abuse it is to enumerate invite IDs you
// shouldn't know — which would just send the legitimate invite
// email to the legitimate recipient. Low blast radius; we can add
// a "caller must equal inviter_player_id" check if it ever
// matters.

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
  // The browser passes its origin so the same edge function works
  // for localhost (dev) and tournaments.wmpc.app (prod) without
  // re-deploying or environment-juggling.
  baseUrl: string;
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
  if (!body.inviteId || !body.baseUrl) {
    return jsonResp({ error: "Missing inviteId or baseUrl" }, 400);
  }
  const baseUrl = body.baseUrl.replace(/\/+$/, "");

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

  // Pull every field we want to mention in the email in one round
  // trip. The nested `tournaments` → `organizations` join lets us
  // build the accept URL deterministically server-side.
  const { data: invite, error: invErr } = await admin
    .from("partner_invites")
    .select(
      `
      id, token, invitee_email,
      inviter:players!inviter_player_id(first_name, last_name),
      invitee:players!invitee_player_id(first_name, last_name),
      event:events!event_id(
        name, format,
        tournament:tournaments!tournament_id(
          name, slug,
          organization:organizations!organization_id(slug, name)
        )
      )
    `,
    )
    .eq("id", body.inviteId)
    .maybeSingle();

  if (invErr) return jsonResp({ error: invErr.message }, 500);
  if (!invite) return jsonResp({ error: "Invite not found" }, 404);

  // Drill into the joined shape with explicit unknowns so TS in the
  // function runtime is happy.
  type InviteShape = {
    id: string;
    token: string;
    invitee_email: string | null;
    inviter: { first_name: string; last_name: string } | null;
    invitee: { first_name: string; last_name: string } | null;
    event: {
      name: string;
      format: string;
      tournament: {
        name: string;
        slug: string;
        organization: { slug: string; name: string } | null;
      } | null;
    } | null;
  };
  const inv = invite as unknown as InviteShape;
  if (
    !inv.invitee_email ||
    !inv.inviter ||
    !inv.invitee ||
    !inv.event ||
    !inv.event.tournament ||
    !inv.event.tournament.organization
  ) {
    return jsonResp({ error: "Invite is missing required joins" }, 500);
  }

  const inviterName = `${inv.inviter.first_name} ${inv.inviter.last_name}`;
  const inviteeFirst = inv.invitee.first_name;
  const eventName = inv.event.name;
  const tournamentName = inv.event.tournament.name;
  const orgName = inv.event.tournament.organization.name;
  const acceptUrl = `${baseUrl}/t/${inv.event.tournament.organization.slug}/${inv.event.tournament.slug}/invites/${inv.token}`;

  const subject = `${inviterName} wants you as their partner for ${eventName}`;
  const html = renderHtml({
    inviteeFirst,
    inviterName,
    eventName,
    tournamentName,
    orgName,
    acceptUrl,
  });
  const text = renderText({
    inviteeFirst,
    inviterName,
    eventName,
    tournamentName,
    orgName,
    acceptUrl,
  });

  const resendResp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: inv.invitee_email,
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

// Plain-string HTML keeps the function small — no template engine
// dependency. Inline styles only (most email clients strip <style>
// tags).
function renderHtml(v: {
  inviteeFirst: string;
  inviterName: string;
  eventName: string;
  tournamentName: string;
  orgName: string;
  acceptUrl: string;
}): string {
  return `<!doctype html>
<html><body style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #222; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 16px; font-size: 20px;">Hi ${escapeHtml(v.inviteeFirst)} —</h2>
  <p style="font-size: 15px; line-height: 1.5;">
    <strong>${escapeHtml(v.inviterName)}</strong> just registered for
    <strong>${escapeHtml(v.eventName)}</strong> at
    <strong>${escapeHtml(v.tournamentName)}</strong> and asked you to
    be their doubles partner.
  </p>
  <p style="margin: 24px 0;">
    <a href="${v.acceptUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
      Accept the invite
    </a>
  </p>
  <p style="font-size: 13px; color: #666; line-height: 1.5;">
    Or copy this link into a browser: <br>
    <a href="${v.acceptUrl}" style="color: #2563eb; word-break: break-all;">${v.acceptUrl}</a>
  </p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;">
  <p style="font-size: 12px; color: #888;">
    Sent by ${escapeHtml(v.orgName)}. If this looks like a mistake,
    you can ignore this email — nothing happens until you click the
    link above.
  </p>
</body></html>`;
}

function renderText(v: {
  inviteeFirst: string;
  inviterName: string;
  eventName: string;
  tournamentName: string;
  orgName: string;
  acceptUrl: string;
}): string {
  return `Hi ${v.inviteeFirst},

${v.inviterName} just registered for ${v.eventName} at ${v.tournamentName} and asked you to be their doubles partner.

Accept the invite: ${v.acceptUrl}

Sent by ${v.orgName}. If this looks like a mistake, you can ignore this email — nothing happens until you click the link above.
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
