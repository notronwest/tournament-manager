// supabase/functions/send-tournament-summary/index.ts
//
// End-of-tournament summary — email every player who held a spot in ONE
// tournament the organizer's wrap-up message with the results report attached
// as a PDF. Same email for everyone (the PDF carries the per-event results);
// logged in contact_broadcasts / contact_broadcast_recipients so it shows up
// on the org's Email → History tab with delivery tracking, like the briefing.
//
// This is a service email about a registration the player held, not
// marketing: it goes to every spot-holding registrant whether or not they have
// unsubscribed from the club's list, and it carries no unsubscribe link (same
// rationale as send-tournament-briefing).
//
// WHY ONE POST PER RECIPIENT, IN WINDOWS: this is the first email in the
// codebase with an attachment. Resend's /emails/batch endpoint does not accept
// attachments, so each recipient is a separate POST /emails, paced to stay
// under Resend's default 2 requests/second. A 300-player tournament is ~3
// minutes of sends — longer than we want a single invocation to run — so the
// function sends one WINDOW of recipients per call (`cursor` + `limit`) and
// returns `nextCursor`; the client loops until it is null. Recipients are
// sorted by lowercased email so every window sees the same order.
//
// ORG-STAFF only (member of the tournament's org, or a platform admin).
//
// Body: {
//   tournamentId: string,
//   mode: "preview" | "test" | "send",
//   subject: string,                  required for test/send, max 200 chars
//   message: string,                  plain text; blank line = new paragraph
//   attachment?: { filename: string, contentBase64: string },
//                                     required for test/send; .pdf, <= 5 MB decoded
//   consent?: boolean,                send: must be true
//   cursor?: number,                  send: recipient offset, default 0
//   limit?: number,                   send: window size, default 25, 1..50
//   broadcastId?: string              send: required when cursor > 0
// }
// Returns (preview): { mode, total, missingEmail, sample, fromAddress }
// Returns (test):    { mode, sentTo }
// Returns (send):    { mode, total, sent, failed, nextCursor, broadcastId }
// Errors:            { error: code, detail? } with the HTTP status.
//
// Required secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Required secrets (set per project): RESEND_API_KEY, RESEND_FROM_ADDRESS —
// both already exist for the other Resend functions; nothing new to set.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { renderEmailHtml, escapeHtml } from "../_shared/email-layout.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RESEND = "https://api.resend.com";
const SITE_URL = "https://bertanderne.com";
const PAGE_SIZE = 1000; // PostgREST max_rows — page list queries past it.
const ID_CHUNK = 300; // .in(...) chunk size for player lookups.
// Players who hold (or held) a spot in a bracket. Waitlisted players never got
// in, so a results summary is not about a registration they hold.
// Same set web/src/lib/registrationStatus.ts calls SPOT_HOLDING — the summary page
// counts these players, so they are the ones who get the report.
const SPOT_HOLDING_STATUSES = ["paid", "pending_payment", "waitlisted_pending_payment"];
const MAX_SUBJECT_CHARS = 200;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_FILENAME_CHARS = 120;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
// Resend's default limit is 2 requests/second; ~550 ms between sends keeps a
// window under it with a little headroom for clock jitter.
const SEND_SPACING_MS = 550;
const RATE_LIMIT_RETRY_MS = 1100;
const PREVIEW_SAMPLE = 5;

type Mode = "preview" | "test" | "send";

type Body = {
  tournamentId?: string;
  mode?: Mode;
  subject?: string;
  message?: string;
  attachment?: { filename?: string; contentBase64?: string } | null;
  consent?: boolean;
  cursor?: number;
  limit?: number;
  broadcastId?: string;
};

type Attachment = { filename: string; content: string };

type EventRow = { id: string };

type RegRow = { player_id: string };

type PlayerRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
};

type Recipient = { playerId: string; email: string };

type TournamentRow = { id: string; name: string; slug: string; organization_id: string };

type OrgRow = { id: string; name: string; slug: string; contact_email: string | null };

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
    const resendApiKey: string | undefined = Deno.env.get("RESEND_API_KEY");
    // @ts-expect-error Deno env
    const rawFrom: string | undefined = Deno.env.get("RESEND_FROM_ADDRESS");

    // ── 1. Caller ────────────────────────────────────────────────────
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const authUserId: string = userData.user.id;
    const senderEmail = (userData.user.email ?? "").trim() || null;

    // ── 2. Input ─────────────────────────────────────────────────────
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (body.mode !== "preview" && body.mode !== "test" && body.mode !== "send") {
      return json({ error: "invalid_mode" }, 400);
    }
    const mode: Mode = body.mode;
    if (typeof body.tournamentId !== "string" || !body.tournamentId.trim()) {
      return json({ error: "tournament_id_required" }, 400);
    }
    // The preview reports the From address, so the Resend config is needed in
    // every mode — better to surface a misconfiguration before the organizer
    // has written the message than on the send.
    if (!resendApiKey || !rawFrom || !rawFrom.trim()) {
      return json({ error: "missing_resend_config" }, 500);
    }
    const fromAddress = normalizeFrom(rawFrom);

    const subject = typeof body.subject === "string" ? body.subject.trim().replace(/[\r\n]+/g, " ") : "";
    const message = typeof body.message === "string" ? body.message.replace(/\r\n/g, "\n").trim() : "";

    let attachment: Attachment | null = null;
    if (mode !== "preview") {
      if (!subject) return json({ error: "subject_required" }, 400);
      if (subject.length > MAX_SUBJECT_CHARS) return json({ error: "subject_too_long" }, 400);
      const parsed = parseAttachment(body.attachment);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      attachment = parsed.attachment;
    }

    let cursor = 0;
    let limit = DEFAULT_LIMIT;
    let broadcastIdIn: string | null = null;
    if (mode === "send") {
      if (body.consent !== true) return json({ error: "consent_required" }, 400);
      cursor = clampInt(body.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
      limit = clampInt(body.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
      broadcastIdIn = typeof body.broadcastId === "string" && body.broadcastId.trim() ? body.broadcastId.trim() : null;
      if (cursor > 0 && !broadcastIdIn) return json({ error: "broadcast_id_required" }, 400);
    }

    // ── 3. Tournament + authorization ───────────────────────────────
    const { data: tRow, error: tErr } = await admin
      .from("tournaments")
      .select("id, name, slug, organization_id")
      .eq("id", body.tournamentId.trim())
      .is("deleted_at", null)
      .maybeSingle();
    if (tErr) throw new Error(`tournament: ${tErr.message}`);
    if (!tRow) return json({ error: "tournament_not_found" }, 404);
    const t = tRow as TournamentRow;
    if (!(await isOrgStaff(admin, t.organization_id, authUserId))) {
      return json({ error: "forbidden_org_staff_only" }, 403);
    }
    const { data: orgRow, error: orgErr } = await admin
      .from("organizations")
      .select("id, name, slug, contact_email")
      .eq("id", t.organization_id)
      .single();
    if (orgErr || !orgRow) return json({ error: "organization_not_found" }, 404);
    const org = orgRow as OrgRow;
    // Same reply-to rule as the briefing: the org's contact address, else the
    // organizer who pressed send.
    const replyTo: string | null = org.contact_email || senderEmail;

    // A continuation window must append to a broadcast this org owns — never
    // to a row from another tenant.
    if (broadcastIdIn) {
      const { data: bcRow, error: bcLookupErr } = await admin
        .from("contact_broadcasts")
        .select("id")
        .eq("id", broadcastIdIn)
        .eq("organization_id", org.id)
        .maybeSingle();
      if (bcLookupErr) throw new Error(`broadcast lookup: ${bcLookupErr.message}`);
      if (!bcRow) return json({ error: "broadcast_not_found" }, 404);
    }

    // ── 4. Recipients: one per player, deterministic order ───────────
    const { recipients, missingEmail } = await collectRecipients(admin, t.id);

    // ── 5a. Preview: counts + a sample of addresses, no send ─────────
    if (mode === "preview") {
      return json({
        mode,
        total: recipients.length,
        missingEmail,
        sample: recipients.slice(0, PREVIEW_SAMPLE).map((r) => r.email),
        fromAddress,
      });
    }

    const html = renderSummary({ tournamentName: t.name, org, tournamentSlug: t.slug, message, filename: attachment!.filename, replyTo });
    const text = renderSummaryText({ tournamentName: t.name, message, filename: attachment!.filename });
    const emailFor = (to: string, subj: string) => ({
      from: fromAddress,
      to: [to],
      subject: subj,
      html,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
      attachments: [{ filename: attachment!.filename, content: attachment!.content }],
    });

    // ── 5b. Test: the real email, attachment included, to the caller ─
    if (mode === "test") {
      if (!senderEmail) return json({ error: "no_sender_email" }, 400);
      const result = await sendOne(resendApiKey, emailFor(senderEmail, `[TEST] ${subject}`));
      if (!result.ok) return json({ error: "send_failed", detail: result.error }, 502);
      return json({ mode, sentTo: senderEmail });
    }

    // ── 5c. Send one window ──────────────────────────────────────────
    const total = recipients.length;
    if (total === 0) return json({ error: "no_recipients" }, 400);

    let broadcastId: string;
    if (cursor === 0) {
      const { data: bc, error: bcErr } = await admin
        .from("contact_broadcasts")
        .insert({
          organization_id: org.id,
          subject,
          body: message,
          recipient_count: total,
          sent_by: authUserId,
        })
        .select("id")
        .single();
      if (bcErr || !bc) throw new Error(`broadcast log: ${bcErr?.message ?? "no row"}`);
      broadcastId = bc.id as string;
    } else {
      broadcastId = broadcastIdIn as string;
    }

    const start = Math.min(cursor, total);
    const end = Math.min(start + limit, total);
    const batch = recipients.slice(start, end);

    let sent = 0;
    let failed = 0;
    const logRows: { broadcast_id: string; player_id: string; email: string; resend_email_id: string | null }[] = [];
    for (let i = 0; i < batch.length; i++) {
      const r = batch[i];
      const result = await sendOne(resendApiKey, emailFor(r.email, subject));
      if (result.ok) {
        sent++;
        logRows.push({ broadcast_id: broadcastId, player_id: r.playerId, email: r.email, resend_email_id: result.id });
      } else {
        failed++;
        console.error(`summary send failed for ${r.email}: ${result.error}`);
      }
      if (i < batch.length - 1) await sleep(SEND_SPACING_MS);
    }

    if (logRows.length > 0) {
      const { error: recErr } = await admin.from("contact_broadcast_recipients").insert(logRows);
      if (recErr) console.error("recipient log failed", recErr.message);
    }

    return json({
      mode,
      total,
      sent,
      failed,
      nextCursor: end < total ? end : null,
      broadcastId,
    });
  } catch (e) {
    return json(
      { error: "internal_error", detail: String((e as { message?: string })?.message ?? e) },
      500,
    );
  }
});

// ── Recipients ──────────────────────────────────────────────────────

async function collectRecipients(
  admin: Db,
  tournamentId: string,
): Promise<{ recipients: Recipient[]; missingEmail: number }> {
  const { data: evData, error: evErr } = await admin
    .from("events")
    .select("id")
    .eq("tournament_id", tournamentId)
    .is("deleted_at", null);
  if (evErr) throw new Error(`events: ${evErr.message}`);
  const eventIds = ((evData ?? []) as EventRow[]).map((e) => e.id);

  const playerIds = new Set<string>();
  if (eventIds.length > 0) {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await admin
        .from("event_registrations")
        .select("player_id")
        .in("event_id", eventIds)
        .in("status", SPOT_HOLDING_STATUSES)
        .is("deleted_at", null)
        .order("id")
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw new Error(`registrations: ${error.message}`);
      const page = (data ?? []) as RegRow[];
      for (const r of page) playerIds.add(r.player_id);
      if (page.length < PAGE_SIZE) break;
    }
  }

  const players: PlayerRow[] = [];
  const allPlayerIds = [...playerIds];
  for (let i = 0; i < allPlayerIds.length; i += ID_CHUNK) {
    const { data, error } = await admin
      .from("players")
      .select("id, first_name, last_name, email")
      .in("id", allPlayerIds.slice(i, i + ID_CHUNK))
      .is("deleted_at", null);
    if (error) throw new Error(`players: ${error.message}`);
    players.push(...((data ?? []) as PlayerRow[]));
  }

  // One email per player AND per address (a parent + child sharing an inbox
  // get one copy). Sorted by address so successive windows never overlap.
  let missingEmail = 0;
  const seenPlayer = new Set<string>();
  const seenEmail = new Set<string>();
  const recipients: Recipient[] = [];
  for (const p of players) {
    if (seenPlayer.has(p.id)) continue;
    seenPlayer.add(p.id);
    const email = (p.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      missingEmail++;
      continue;
    }
    if (seenEmail.has(email)) continue;
    seenEmail.add(email);
    recipients.push({ playerId: p.id, email });
  }
  recipients.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  return { recipients, missingEmail };
}

// ── Attachment validation ───────────────────────────────────────────

type ParsedAttachment = { ok: true; attachment: Attachment } | { ok: false; error: string };

function parseAttachment(raw: Body["attachment"]): ParsedAttachment {
  if (!raw || typeof raw !== "object") return { ok: false, error: "attachment_required" };
  const filename = typeof raw.filename === "string" ? sanitizeFilename(raw.filename) : "";
  if (!filename) return { ok: false, error: "attachment_required" };
  if (!/\.pdf$/i.test(filename) || filename.length <= 4) return { ok: false, error: "attachment_invalid" };

  if (typeof raw.contentBase64 !== "string" || !raw.contentBase64.trim()) {
    return { ok: false, error: "attachment_required" };
  }
  // Tolerate a data-URL prefix and line-wrapped base64; Resend wants the bare string.
  let b64 = raw.contentBase64.trim();
  const comma = b64.indexOf(",");
  if (/^data:/i.test(b64) && comma !== -1) b64 = b64.slice(comma + 1);
  b64 = b64.replace(/\s+/g, "");
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return { ok: false, error: "attachment_invalid" };
  }
  // Decoded size from the encoded length — no need to decode 5 MB to know it's too big.
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const decodedBytes = (b64.length / 4) * 3 - padding;
  if (decodedBytes > MAX_ATTACHMENT_BYTES) return { ok: false, error: "attachment_too_large" };
  // Decode the first bytes to confirm this is really a PDF (every PDF starts
  // with "%PDF") and that the base64 is well-formed.
  try {
    const head = atob(b64.slice(0, 8));
    if (!head.startsWith("%PDF")) return { ok: false, error: "attachment_invalid" };
  } catch {
    return { ok: false, error: "attachment_invalid" };
  }
  return { ok: true, attachment: { filename, content: b64 } };
}

// Strip path separators and control characters so the name is safe as a
// mail attachment; keep it short enough for every mail client.
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  return cleaned.length > MAX_FILENAME_CHARS ? cleaned.slice(cleaned.length - MAX_FILENAME_CHARS) : cleaned;
}

// ── Rendering ───────────────────────────────────────────────────────

const P = `margin:0 0 14px;font-size:15px;color:#4a5159;line-height:1.6;`;

function renderSummary(args: {
  tournamentName: string;
  tournamentSlug: string;
  org: { name: string; slug: string };
  message: string;
  filename: string;
  replyTo: string | null;
}): string {
  const { tournamentName, tournamentSlug, org, message, filename, replyTo } = args;
  const bodyHtml = `
    ${textToHtml(message)}
    <p style="${P}">The full results report is attached to this email as a PDF (<strong>${escapeHtml(filename)}</strong>).</p>
    <p style="${P}margin-top:20px;">Questions? ${replyTo ? "Just reply to this email." : `Contact ${escapeHtml(org.name)}.`} Thanks for playing!</p>
  `;
  return renderEmailHtml({
    headingLabel: org.name,
    heading: `${tournamentName} — results & summary`,
    bodyHtml,
    ctaLabel: "View the tournament page",
    ctaUrl: `${SITE_URL}/t/${org.slug}/${tournamentSlug}`,
    footer: `${escapeHtml(org.name)} via bert &amp; erne &mdash; pickleball tournaments<br />You're receiving this because you played in ${escapeHtml(tournamentName)}.`,
  });
}

function renderSummaryText(args: { tournamentName: string; message: string; filename: string }): string {
  const parts = [`${args.tournamentName} — results & summary`];
  if (args.message) parts.push(args.message);
  parts.push(`The full results report is attached to this email as a PDF (${args.filename}).`);
  return parts.join("\n\n");
}

// Plain text → safe HTML paragraphs (blank line = new <p>, single newline = <br>).
function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p style="${P}">${escapeHtml(para).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

// ── Resend ──────────────────────────────────────────────────────────

type SendResult = { ok: true; id: string | null } | { ok: false; error: string };

// One POST /emails. Never throws — a failure inside a window must not lose
// the sent/failed count. A 429 gets exactly one retry after a pause.
async function sendOne(apiKey: string, email: unknown): Promise<SendResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let resp: Response;
    let bodyText: string;
    try {
      resp = await fetch(`${RESEND}/emails`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(email),
      });
      bodyText = await resp.text();
    } catch (e) {
      return { ok: false, error: `resend POST /emails network error: ${String((e as { message?: string })?.message ?? e)}` };
    }
    if (resp.ok) {
      try {
        const parsed = bodyText ? (JSON.parse(bodyText) as { id?: string }) : {};
        return { ok: true, id: typeof parsed.id === "string" ? parsed.id : null };
      } catch {
        return { ok: true, id: null };
      }
    }
    if (resp.status === 429 && attempt === 0) {
      await sleep(RATE_LIMIT_RETRY_MS);
      continue;
    }
    return { ok: false, error: `resend POST /emails → ${resp.status}: ${bodyText.slice(0, 500)}` };
  }
  return { ok: false, error: "resend POST /emails → rate limited" };
}

// ── Helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.min(max, Math.max(min, n));
}

function normalizeFrom(raw: string): string {
  const s = raw.trim().replace(/[\r\n]+/g, " ");
  const m = s.match(/^(.*?)\s*<\s*([^<>]+?)\s*>\s*$/);
  if (!m) return s;
  const name = m[1].trim().replace(/"/g, "").trim();
  const email = m[2].trim();
  return name ? `"${name}" <${email}>` : email;
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
