// supabase/functions/send-waitlist-promotion/index.ts
//
// Sends a "you've been promoted off the waitlist" email via Resend.
// Invoked by stripe-refund (resolve/self) immediately after
// promote_from_waitlist() returns a promoted row. Best-effort:
// a send failure must not fail the withdrawal that triggered it.
//
// Required secrets (same set as send-partner-invite):
//   RESEND_API_KEY        — re_… key from the Resend dashboard.
//   RESEND_FROM_ADDRESS   — verified sender address.
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — auto-injected.

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
  if (!body.regId || !body.baseUrl) {
    return jsonResp({ error: "Missing regId or baseUrl" }, 400);
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

  const { data: reg, error: regErr } = await admin
    .from("event_registrations")
    .select(
      `
      id, status,
      player:players!player_id(first_name, last_name, email),
      event:events!event_id(
        name,
        tournament:tournaments!tournament_id(
          name, slug,
          organization:organizations!organization_id(slug, name)
        )
      )
    `,
    )
    .eq("id", body.regId)
    .maybeSingle();

  if (regErr) return jsonResp({ error: regErr.message }, 500);
  if (!reg) return jsonResp({ error: "Registration not found" }, 404);

  type RegShape = {
    id: string;
    status: string;
    player: { first_name: string; last_name: string; email: string | null } | null;
    event: {
      name: string;
      tournament: {
        name: string;
        slug: string;
        organization: { slug: string; name: string } | null;
      } | null;
    } | null;
  };
  const r = reg as unknown as RegShape;

  if (
    !r.player ||
    !r.player.email ||
    !r.event ||
    !r.event.tournament ||
    !r.event.tournament.organization
  ) {
    return jsonResp({ error: "Registration is missing required joins" }, 500);
  }

  const playerFirst = r.player.first_name;
  const playerEmail = r.player.email;
  const eventName = r.event.name;
  const tournamentName = r.event.tournament.name;
  const orgName = r.event.tournament.organization.name;
  const checkoutUrl = `${baseUrl}/t/${r.event.tournament.organization.slug}/${r.event.tournament.slug}/checkout`;

  const subject = `You're off the waitlist — complete your registration for ${eventName}`;
  const html = renderHtml({ playerFirst, eventName, tournamentName, orgName, checkoutUrl });
  const text = renderText({ playerFirst, eventName, tournamentName, orgName, checkoutUrl });

  const resendResp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: playerEmail,
      subject,
      html,
      text,
    }),
  });

  if (!resendResp.ok) {
    const errText = await resendResp.text();
    return jsonResp({ error: `Resend rejected the send: ${errText}` }, 502);
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
  playerFirst: string;
  eventName: string;
  tournamentName: string;
  orgName: string;
  checkoutUrl: string;
}): string {
  return `<!doctype html>
<html><body style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #222; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 16px; font-size: 20px;">Hi ${escapeHtml(v.playerFirst)} —</h2>
  <p style="font-size: 15px; line-height: 1.5;">
    Good news! A spot has opened up in
    <strong>${escapeHtml(v.eventName)}</strong> at
    <strong>${escapeHtml(v.tournamentName)}</strong>.
    You've been promoted from the waitlist — complete your checkout to
    confirm your spot.
  </p>
  <p style="font-size: 14px; color: #b45309; background: #fef9c3; border: 1px solid #fde68a; border-radius: 6px; padding: 12px;">
    Act quickly — if you don't complete checkout promptly, the spot
    may be offered to the next player on the waitlist.
  </p>
  <p style="margin: 24px 0;">
    <a href="${v.checkoutUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
      Complete my registration
    </a>
  </p>
  <p style="font-size: 13px; color: #666; line-height: 1.5;">
    Or copy this link into a browser: <br>
    <a href="${v.checkoutUrl}" style="color: #2563eb; word-break: break-all;">${v.checkoutUrl}</a>
  </p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;">
  <p style="font-size: 12px; color: #888;">
    Sent by ${escapeHtml(v.orgName)}.
  </p>
</body></html>`;
}

function renderText(v: {
  playerFirst: string;
  eventName: string;
  tournamentName: string;
  orgName: string;
  checkoutUrl: string;
}): string {
  return `Hi ${v.playerFirst},

Good news! A spot has opened up in ${v.eventName} at ${v.tournamentName}. You've been promoted from the waitlist — complete your checkout to confirm your spot.

Act quickly — if you don't complete checkout promptly, the spot may be offered to the next player on the waitlist.

Complete your registration: ${v.checkoutUrl}

Sent by ${v.orgName}.
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
