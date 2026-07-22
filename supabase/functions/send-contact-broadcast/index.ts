// supabase/functions/send-contact-broadcast/index.ts
//
// Email a club's contact list. Recipients = imported/manual contacts
// (organization_contacts) ∪ the org's registrants (distinct players in the
// org's event_registrations), deduped by player, dropping anyone without an
// email or who has unsubscribed. An optional `playerIds` restricts the send to
// an explicit subset (the UI's filter selection / individual picks).
//
// Delivery uses Resend's BATCH-SEND API (one email id per recipient) rather
// than a Broadcast, so every recipient is individually trackable and any subset
// can be targeted. We own the unsubscribe link (a signed token → the public
// unsubscribe-contact function sets organization_contacts.unsubscribed_at).
//
// Each send is logged: one `contact_broadcasts` row + one
// `contact_broadcast_recipients` row per recipient (correlated to Resend by
// resend_email_id). The resend-webhook function advances delivery status.
//
// ORG-STAFF only. Requires an explicit consent flag.
//
// Body:    { organizationId, subject, body, consent: true, playerIds?: string[] }
// Returns: { broadcastId, recipientCount, sent }
//
// Required secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Required secrets (already set):   RESEND_API_KEY, RESEND_FROM_ADDRESS.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { renderEmailHtml, escapeHtml } from "../_shared/email-layout.ts";
import { makeUnsubToken, unsubscribeUrl } from "../_shared/unsubscribe.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RESEND = "https://api.resend.com";
const MAX_RECIPIENTS = 3000;
const BATCH_SIZE = 100; // Resend /emails/batch caps at 100 per call.
const ACTIVE_REG_STATUSES = ["paid", "pending_payment"];

type Body = {
  organizationId?: string;
  subject?: string;
  body?: string;
  consent?: boolean;
  playerIds?: string[];
  // When true, `body` is raw HTML authored by the org admin — sent as-is inside
  // the branded layout. When false/omitted, `body` is plain text (escaped, blank
  // lines → paragraphs).
  bodyIsHtml?: boolean;
};
type Recipient = { playerId: string; email: string; first: string; last: string };

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
    const fromAddress = Deno.env.get("RESEND_FROM_ADDRESS");
    if (!resendApiKey || !fromAddress) {
      return json({ error: "server_misconfigured" }, 500);
    }

    // ── 1. Authenticate ──────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const authUserId = userData.user.id;

    // ── 2. Input ─────────────────────────────────────────────────────
    const { organizationId, subject, body, consent, playerIds, bodyIsHtml } =
      (await req.json()) as Body;
    if (!organizationId) return json({ error: "organizationId is required" }, 400);
    if (!subject || !subject.trim()) return json({ error: "subject is required" }, 400);
    if (!body || !body.trim()) return json({ error: "body is required" }, 400);
    if (consent !== true) return json({ error: "consent_required" }, 400);

    // ── 3. Authorize + load org ──────────────────────────────────────
    if (!(await isOrgStaff(admin, organizationId, authUserId))) {
      return json({ error: "forbidden_org_staff_only" }, 403);
    }
    const { data: org, error: orgErr } = await admin
      .from("organizations")
      .select("id, name, contact_email")
      .eq("id", organizationId)
      .is("deleted_at", null)
      .single();
    if (orgErr || !org) return json({ error: "organization_not_found" }, 404);

    // ── 4. Build the recipient set (contacts ∪ registrants), then narrow
    //     to the selected subset if playerIds was provided. Unsubscribed and
    //     no-email people are already excluded, so a selected-but-unsubscribed
    //     player is dropped here regardless of what the client sent. ─────
    let recipients = await buildRecipients(admin, organizationId);
    if (Array.isArray(playerIds) && playerIds.length > 0) {
      const wanted = new Set(playerIds);
      recipients = recipients.filter((r) => wanted.has(r.playerId));
    }
    if (recipients.length === 0) return json({ error: "no_recipients" }, 400);
    if (recipients.length > MAX_RECIPIENTS) {
      return json({ error: `too_many_recipients (max ${MAX_RECIPIENTS})` }, 400);
    }

    // ── 5. Log the broadcast (one row per send) ──────────────────────
    const { data: bc, error: bcErr } = await admin
      .from("contact_broadcasts")
      .insert({
        organization_id: organizationId,
        subject: subject.trim(),
        body: body,
        recipient_count: recipients.length,
        sent_by: authUserId,
      })
      .select("id")
      .single();
    if (bcErr || !bc) return json({ error: bcErr?.message ?? "broadcast_log_failed" }, 500);
    const broadcastId: string = bc.id;

    // ── 6. Batch-send via Resend, then record per-recipient rows ──────
    let sent = 0;
    for (let start = 0; start < recipients.length; start += BATCH_SIZE) {
      const chunk = recipients.slice(start, start + BATCH_SIZE);

      // One email object per recipient, each with its own unsubscribe link.
      const emails = await Promise.all(
        chunk.map(async (r) => {
          const token = await makeUnsubToken(SERVICE_KEY, organizationId, r.playerId, broadcastId);
          const unsubUrl = unsubscribeUrl(SUPABASE_URL, token);
          const html = renderEmailHtml({
            headingLabel: org.name ?? undefined,
            heading: subject.trim(),
            bodyHtml: bodyIsHtml ? body : textToHtml(body),
            footer: `${escapeHtml(org.name ?? "This club")} via bert &amp; erne &mdash; pickleball tournaments<br /><a href="${unsubUrl}" style="color:#6b7280;">Unsubscribe</a>`,
          });
          return {
            from: fromAddress,
            to: [r.email],
            subject: subject.trim(),
            html,
            ...(org.contact_email ? { reply_to: org.contact_email } : {}),
            headers: {
              "List-Unsubscribe": `<${unsubUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          };
        }),
      );

      let ids: (string | null)[] = chunk.map(() => null);
      try {
        const resp = (await resend(resendApiKey, "POST", "/emails/batch", emails)) as {
          data?: { id?: string }[];
        };
        const returned = resp?.data ?? [];
        ids = chunk.map((_, i) => returned[i]?.id ?? null);
        sent += returned.length;
      } catch (e) {
        // Record the recipient rows anyway (status stays 'sent', no id) so the
        // audit trail survives a partial Resend failure.
        console.error("resend batch failed", String((e as { message?: string })?.message ?? e));
      }

      const rows = chunk.map((r, i) => ({
        broadcast_id: broadcastId,
        player_id: r.playerId,
        email: r.email,
        resend_email_id: ids[i],
      }));
      const { error: recErr } = await admin.from("contact_broadcast_recipients").insert(rows);
      if (recErr) console.error("recipient log failed", recErr.message);
    }

    return json({ broadcastId, recipientCount: recipients.length, sent });
  } catch (e) {
    return json(
      { error: "internal_error", detail: String((e as { message?: string })?.message ?? e) },
      500,
    );
  }
});

// Contacts ∪ registrants, deduped by player, email-required, unsubscribed removed.
async function buildRecipients(admin: Db, organizationId: string): Promise<Recipient[]> {
  const playerIds = new Set<string>();
  const unsubscribed = new Set<string>();

  // (a) imported/manual contacts
  const { data: contacts } = await admin
    .from("organization_contacts")
    .select("player_id, unsubscribed_at")
    .eq("organization_id", organizationId)
    .is("deleted_at", null);
  for (const c of (contacts ?? []) as { player_id: string; unsubscribed_at: string | null }[]) {
    if (c.unsubscribed_at) unsubscribed.add(c.player_id);
    else playerIds.add(c.player_id);
  }

  // (b) registrants — distinct players in the org's event_registrations.
  const { data: tourneys } = await admin
    .from("tournaments")
    .select("id")
    .eq("organization_id", organizationId)
    .is("deleted_at", null);
  const tournamentIds = (tourneys ?? []).map((t: { id: string }) => t.id);
  if (tournamentIds.length > 0) {
    const { data: events } = await admin
      .from("events")
      .select("id")
      .in("tournament_id", tournamentIds)
      .is("deleted_at", null);
    const eventIds = (events ?? []).map((e: { id: string }) => e.id);
    if (eventIds.length > 0) {
      const { data: regs } = await admin
        .from("event_registrations")
        .select("player_id")
        .in("event_id", eventIds)
        .in("status", ACTIVE_REG_STATUSES)
        .is("deleted_at", null);
      for (const r of (regs ?? []) as { player_id: string }[]) {
        if (!unsubscribed.has(r.player_id)) playerIds.add(r.player_id);
      }
    }
  }

  if (playerIds.size === 0) return [];

  const { data: players } = await admin
    .from("players")
    .select("id, email, first_name, last_name")
    .in("id", [...playerIds])
    .is("deleted_at", null);

  const out: Recipient[] = [];
  const seenEmail = new Set<string>();
  for (const p of (players ?? []) as {
    id: string;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
  }[]) {
    const email = (p.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) continue;
    if (seenEmail.has(email)) continue; // one send per address
    seenEmail.add(email);
    out.push({
      playerId: p.id,
      email,
      first: (p.first_name ?? "").trim(),
      last: (p.last_name ?? "").trim(),
    });
  }
  return out;
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

// Minimal Resend REST helper. Throws on non-2xx.
async function resend(apiKey: string, method: string, path: string, body: unknown): Promise<unknown> {
  const resp = await fetch(`${RESEND}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`resend ${method} ${path} → ${resp.status}: ${text}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

// Plain text → safe HTML paragraphs (blank line = new <p>, single newline = <br>).
function textToHtml(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map(
      (para) =>
        `<p style="margin:0 0 16px;font-size:15px;color:#4a5159;line-height:1.6;">${escapeHtml(para).replace(/\n/g, "<br />")}</p>`,
    )
    .join("");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
