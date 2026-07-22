// supabase/functions/send-contact-broadcast/index.ts
//
// Email a club's ENTIRE contact list via Resend Broadcasts. The contact list is
// computed here as:
//     imported/manual contacts (organization_contacts)
//   ∪ the org's registrants      (distinct players in the org's event_registrations)
// deduped by player, dropping anyone without an email or who has unsubscribed.
//
// We use a Resend Audience + Broadcast (not a fan-out of individual emails) so
// Resend owns the unsubscribe link, suppression list, and open/click tracking —
// which keeps our transactional domain reputation cleaner and handles CAN-SPAM
// unsubscribe for us. One Audience per org (created lazily; id stored on
// organizations.resend_audience_id).
//
// ORG-STAFF only. Requires an explicit consent flag (the org attests it has
// permission to email these people).
//
// Body:    { organizationId, subject, body, consent: true }   (body is PLAIN TEXT)
// Returns: { broadcastId, recipientCount, audienceId, synced, syncFailed }
//
// Required secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Required secrets (already set):   RESEND_API_KEY, RESEND_FROM_ADDRESS.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { renderEmailHtml, escapeHtml } from "../_shared/email-layout.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RESEND = "https://api.resend.com";
const MAX_RECIPIENTS = 3000;
const ACTIVE_REG_STATUSES = ["paid", "pending_payment"];

type Body = { organizationId?: string; subject?: string; body?: string; consent?: boolean };
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
    const admin = createClient(
      SUPABASE_URL,
      // @ts-expect-error Deno env
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
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
    const { organizationId, subject, body, consent } = (await req.json()) as Body;
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
      .select("id, name, contact_email, resend_audience_id")
      .eq("id", organizationId)
      .is("deleted_at", null)
      .single();
    if (orgErr || !org) return json({ error: "organization_not_found" }, 404);

    // ── 4. Build the recipient set (contacts ∪ registrants) ──────────
    const recipients = await buildRecipients(admin, organizationId);
    if (recipients.length === 0) return json({ error: "no_recipients" }, 400);
    if (recipients.length > MAX_RECIPIENTS) {
      return json({ error: `too_many_recipients (max ${MAX_RECIPIENTS})` }, 400);
    }

    // ── 5. Ensure the org's Resend Audience ──────────────────────────
    let audienceId: string | null = org.resend_audience_id;
    if (!audienceId) {
      const created = await resend(resendApiKey, "POST", "/audiences", {
        name: `${org.name} — contacts`,
      });
      audienceId = (created as { id?: string })?.id ?? null;
      if (!audienceId) return json({ error: "resend_audience_create_failed" }, 502);
      const { error: updErr } = await admin
        .from("organizations")
        .update({ resend_audience_id: audienceId })
        .eq("id", org.id);
      if (updErr) return json({ error: updErr.message }, 500);
    }

    // ── 6. Sync recipients into the audience (idempotent; dup = ok) ───
    let synced = 0;
    let syncFailed = 0;
    await pool(recipients, 5, async (r) => {
      try {
        await resend(resendApiKey, "POST", `/audiences/${audienceId}/contacts`, {
          email: r.email,
          first_name: r.first,
          last_name: r.last,
          unsubscribed: false,
        });
        synced++;
      } catch {
        // A pre-existing contact returns a 4xx we treat as success-enough; a
        // genuine failure just means Resend already has them or will skip them.
        syncFailed++;
      }
    });

    // ── 7. Create + send the broadcast ───────────────────────────────
    const html = renderEmailHtml({
      headingLabel: org.name ?? undefined,
      heading: subject.trim(),
      bodyHtml: textToHtml(body),
      // Resend replaces this token with the recipient's one-click unsubscribe URL.
      footer: `${escapeHtml(org.name ?? "This club")} via bert &amp; erne &mdash; pickleball tournaments<br /><a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#6b7280;">Unsubscribe</a>`,
    });

    const broadcast = await resend(resendApiKey, "POST", "/broadcasts", {
      // NOTE: Resend is mid-rename audience_id → segment_id. audience_id is the
      // current stable field; revisit if the API version changes.
      audience_id: audienceId,
      from: fromAddress,
      subject: subject.trim(),
      html,
      ...(org.contact_email ? { reply_to: org.contact_email } : {}),
      name: `${org.name} — ${subject.trim()}`.slice(0, 200),
    });
    const broadcastId = (broadcast as { id?: string })?.id ?? null;
    if (!broadcastId) return json({ error: "resend_broadcast_create_failed" }, 502);

    await resend(resendApiKey, "POST", `/broadcasts/${broadcastId}/send`, {});

    return json({
      broadcastId,
      audienceId,
      recipientCount: recipients.length,
      synced,
      syncFailed,
    });
  } catch (e) {
    return json({ error: "internal_error", detail: String((e as { message?: string })?.message ?? e) }, 500);
  }
});

// Contacts ∪ registrants, deduped by player, email-required, unsubscribed removed.
async function buildRecipients(
  admin: Db,
  organizationId: string,
): Promise<Recipient[]> {
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
  //     Two-step (supabase-js has no subqueries): tournaments → events → regs.
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

  // Fetch player contact details for the union.
  const { data: players } = await admin
    .from("players")
    .select("id, email, first_name, last_name")
    .in("id", [...playerIds])
    .is("deleted_at", null);

  const out: Recipient[] = [];
  const seenEmail = new Set<string>();
  for (const p of (players ?? []) as { id: string; email: string | null; first_name: string | null; last_name: string | null }[]) {
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

async function isOrgStaff(
  admin: Db,
  organizationId: string,
  authUserId: string,
): Promise<boolean> {
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

// Minimal Resend REST helper. Throws on non-2xx (callers decide tolerance).
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

// Run `fn` over `items` with at most `concurrency` in flight.
async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
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
