// supabase/functions/send-partner-withdrawal/index.ts
//
// Sends a "your partner withdrew" email to the remaining partner when
// a player withdraws from a doubles event they had a confirmed partner
// for. Called best-effort from both withdrawal paths (My Tournaments
// "Withdraw" and the register-page "Unregister" flow); a send failure
// never blocks or rolls back the withdrawal.
//
// The withdrawal RPC clears partner_registration_id on both regs but
// leaves the accepted partner_invites row intact, so we resolve the
// partner from there regardless of which side initiated the withdrawal.
//
// Required Supabase secrets:
//   RESEND_API_KEY        — re_… key from the Resend dashboard.
//   RESEND_FROM_ADDRESS   — verified sender address.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Body = {
  regId: string;
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

  // Load the withdrawing registration (service role bypasses RLS so we
  // can see soft-deleted rows — the RegisterPage path deletes before calling).
  const { data: reg, error: regErr } = await admin
    .from("event_registrations")
    .select("player_id, event_id")
    .eq("id", body.regId)
    .maybeSingle();

  if (regErr) return jsonResp({ error: regErr.message }, 500);
  if (!reg) return jsonResp({ error: "Registration not found" }, 404);

  // Find the accepted partner_invites row that linked these two players.
  // The RPC does not cancel it, so it persists after the withdrawal and
  // lets us identify the partner regardless of invite direction.
  const { data: invite, error: invErr } = await admin
    .from("partner_invites")
    .select(
      `
      id,
      inviter_player_id,
      invitee_player_id,
      invitee_email,
      inviter:players!inviter_player_id(first_name, last_name, email),
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
    .eq("event_id", reg.event_id)
    .eq("status", "accepted")
    .or(
      `inviter_player_id.eq.${reg.player_id},invitee_player_id.eq.${reg.player_id}`,
    )
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (invErr) return jsonResp({ error: invErr.message }, 500);
  if (!invite) {
    // No accepted invite — either singles or no confirmed partner. Skip silently.
    return jsonResp({ ok: true, skipped: "no_confirmed_partner" });
  }

  type InviteShape = {
    id: string;
    inviter_player_id: string;
    invitee_player_id: string;
    invitee_email: string | null;
    inviter: { first_name: string; last_name: string; email: string | null } | null;
    invitee: { first_name: string; last_name: string; email: string | null } | null;
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

  // Determine which side withdrew and which is the partner to notify.
  const withdrawingIsInviter = inv.inviter_player_id === reg.player_id;

  const withdrawingFirst = withdrawingIsInviter
    ? inv.inviter.first_name
    : inv.invitee.first_name;
  const withdrawingLast = withdrawingIsInviter
    ? inv.inviter.last_name
    : inv.invitee.last_name;
  const withdrawingName = `${withdrawingFirst} ${withdrawingLast}`;

  const partnerFirst = withdrawingIsInviter
    ? inv.invitee.first_name
    : inv.inviter.first_name;

  // Email priority: partner's current player.email beats the invite
  // snapshot (invitee_email), which may be stale if they updated it.
  const toEmail = withdrawingIsInviter
    ? (inv.invitee.email ?? inv.invitee_email)
    : inv.inviter.email;

  if (!toEmail) {
    return jsonResp({ ok: true, skipped: "no_email" });
  }
  if (isObviouslyFakeEmail(toEmail)) {
    return jsonResp({ ok: true, skipped: "fake_email" });
  }

  const eventName = inv.event.name;
  const tournamentName = inv.event.tournament.name;
  const orgName = inv.event.tournament.organization.name;

  const subject = `${withdrawingName} withdrew from ${eventName}`;
  const html = renderHtml({
    partnerFirst,
    withdrawingName,
    eventName,
    tournamentName,
    orgName,
  });
  const text = renderText({
    partnerFirst,
    withdrawingName,
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

function renderHtml(v: {
  partnerFirst: string;
  withdrawingName: string;
  eventName: string;
  tournamentName: string;
  orgName: string;
}): string {
  return `<!doctype html>
<html><body style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #222; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 16px; font-size: 20px;">Hi ${escapeHtml(v.partnerFirst)} —</h2>
  <p style="font-size: 15px; line-height: 1.55;">
    A heads-up: <strong>${escapeHtml(v.withdrawingName)}</strong> withdrew
    from <strong>${escapeHtml(v.eventName)}</strong> at
    <strong>${escapeHtml(v.tournamentName)}</strong>. Your spot in that
    event is now open — you're listed as seeking a new partner.
  </p>
  <p style="font-size: 15px; line-height: 1.55;">
    You can find a new partner by returning to the tournament registration
    page. If you'd prefer not to play the event without them, you can
    withdraw from it there as well.
  </p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;">
  <p style="font-size: 12px; color: #888;">
    Sent by ${escapeHtml(v.orgName)} via Tournament Manager.
  </p>
</body></html>`;
}

function renderText(v: {
  partnerFirst: string;
  withdrawingName: string;
  eventName: string;
  tournamentName: string;
  orgName: string;
}): string {
  return `Hi ${v.partnerFirst},

A heads-up: ${v.withdrawingName} withdrew from ${v.eventName} at ${v.tournamentName}. Your spot in that event is now open — you're listed as seeking a new partner.

You can find a new partner by returning to the tournament registration page. If you'd prefer not to play the event without them, you can withdraw from it there as well.

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
