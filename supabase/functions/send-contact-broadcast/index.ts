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
// WITH ATTACHMENTS the send takes a different road: Resend's /emails/batch
// cannot carry attachments, so each recipient becomes its own POST /emails,
// paced under Resend's 2 req/s (see _shared/attachments.ts). That is too slow
// for one invocation on a big list, so the function sends one WINDOW of
// recipients per call (`cursor` + `limit`) and returns `nextCursor`; the client
// loops until it is null. The recipient set is computed the same way on every
// call and sorted (lowercased email, then playerId) so windows never overlap
// or skip. Cursor 0 creates the contact_broadcasts row; later windows pass its
// id back. The email itself — html, reply-to, unsubscribe link + headers — is
// identical to the batch path, plus the files.
//
// Each send is logged: one `contact_broadcasts` row + one
// `contact_broadcast_recipients` row per recipient (correlated to Resend by
// resend_email_id). The resend-webhook function advances delivery status.
//
// ORG-STAFF only. Requires an explicit consent flag.
//
// Body: {
//   organizationId, subject, body, consent: true,
//   playerIds?: string[],             restrict to this subset
//   bodyIsHtml?: boolean, replyTo?: string,
//   attachments?: { filename, contentBase64 }[],
//                                     PDF only; max 3 files, 5 MB total decoded
//   cursor?: number, limit?: number,  attachments only: window offset (default 0)
//                                     and size (default 25, clamped 1..50)
//   broadcastId?: string              attachments only: required when cursor > 0
// }
// Returns (no attachments): { broadcastId, recipientCount, sent, failed?, detail? }
//                           — the whole list in one call; cursor/limit/broadcastId ignored.
// Returns (attachments):    { broadcastId, recipientCount, sent, failed, nextCursor, detail? }
//                           — sent/failed are for THIS window; nextCursor null on the last.
// Errors: { error: code, detail? } — 400 attachment_invalid / attachment_too_large /
//         too_many_attachments / broadcast_id_required, 404 broadcast_not_found,
//         502 when Resend accepted nothing (the broadcast row is removed).
//
// Required secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Required secrets (already set):   RESEND_API_KEY, RESEND_FROM_ADDRESS.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { renderEmailHtml, escapeHtml } from "../_shared/email-layout.ts";
import { makeUnsubToken, unsubscribeUrl } from "../_shared/unsubscribe.ts";
import { parseAttachments, sendOneEmail, sleep, clampInt, SEND_SPACING_MS } from "../_shared/attachments.ts";
import type { Attachment } from "../_shared/attachments.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RESEND = "https://api.resend.com";
const MAX_RECIPIENTS = 3000;
const BATCH_SIZE = 100; // Resend /emails/batch caps at 100 per call.
// Anyone whose registration isn't over (cancelled / refunded / withdrawn),
// waitlisted players included. Must match lib/orgContacts on the client.
const ACTIVE_REG_STATUSES = ["paid", "pending_payment", "waitlisted", "waitlisted_pending_payment"];
const PAGE_SIZE = 1000; // PostgREST max_rows — page every list query past it.
// Attachments: PDF only, a few files, small enough for every inbox.
const MAX_ATTACHMENT_FILES = 3;
const MAX_ATTACHMENT_TOTAL_BYTES = 5 * 1024 * 1024;
// Per-recipient window (attachments only) — same defaults as send-tournament-summary.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

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
  // Per-send Reply-To override. When omitted, we fall back to the org's saved
  // default (organizations.contact_email) and then to the sending admin's email.
  replyTo?: string;
  // PDF attachments. Present and non-empty → the per-recipient windowed send
  // (see header); absent/empty → the batch send, exactly as before.
  attachments?: { filename?: string; contentBase64?: string }[];
  // Windowing — only read when attachments are present.
  cursor?: number;
  limit?: number;
  broadcastId?: string;
};
type Recipient = { playerId: string; email: string; first: string; last: string };

// Lightweight email shape check — enough to reject obvious garbage in a
// user-supplied reply-to without pulling in a validation library.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    const rawFrom = Deno.env.get("RESEND_FROM_ADDRESS");
    if (!resendApiKey || !rawFrom) {
      return json({ error: "server_misconfigured" }, 500);
    }
    // Resend's /emails/batch validates `from` more strictly than /emails: an
    // UNQUOTED display name with a special char (e.g. the "&" in "bert & erne")
    // is rejected with a 422. Normalize to always-quote the display name so a
    // slightly-off RESEND_FROM_ADDRESS can't silently fail the whole send.
    const fromAddress = normalizeFrom(rawFrom);

    // ── 1. Authenticate ──────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const authUserId = userData.user.id;
    // The sending admin's email — used as the reply-to default so replies reach
    // a real person at the club (not our no-reply from-address).
    const senderEmail = (userData.user.email ?? "").trim() || null;

    // ── 2. Input ─────────────────────────────────────────────────────
    const input = (await req.json()) as Body;
    const { organizationId, subject, body, consent, playerIds, bodyIsHtml, replyTo } = input;
    if (!organizationId) return json({ error: "organizationId is required" }, 400);
    if (!subject || !subject.trim()) return json({ error: "subject is required" }, 400);
    if (!body || !body.trim()) return json({ error: "body is required" }, 400);
    if (consent !== true) return json({ error: "consent_required" }, 400);
    // Per-send reply-to override (optional). Validate its shape if present.
    const replyToOverride = typeof replyTo === "string" ? replyTo.trim() : "";
    if (replyToOverride && !EMAIL_RE.test(replyToOverride)) {
      return json({ error: "invalid_reply_to" }, 400);
    }
    // Attachments (optional). Absent or an empty array → the batch path below,
    // untouched. Anything else must parse as PDFs, and switches the send to
    // one POST per recipient in windows.
    let attachments: Attachment[] = [];
    if (input.attachments !== undefined && input.attachments !== null) {
      const parsed = parseAttachments(input.attachments, {
        maxFiles: MAX_ATTACHMENT_FILES,
        maxTotalBytes: MAX_ATTACHMENT_TOTAL_BYTES,
      });
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      attachments = parsed.files;
    }
    const windowed = attachments.length > 0;
    let cursor = 0;
    let limit = DEFAULT_LIMIT;
    let broadcastIdIn: string | null = null;
    if (windowed) {
      cursor = clampInt(input.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
      limit = clampInt(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
      broadcastIdIn =
        typeof input.broadcastId === "string" && input.broadcastId.trim() ? input.broadcastId.trim() : null;
      if (cursor > 0 && !broadcastIdIn) return json({ error: "broadcast_id_required" }, 400);
    }

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

    // Reply-to precedence: this send's explicit override → the org's saved
    // default (organizations.contact_email) → the admin who's sending. Any of
    // these puts recipient replies in front of a real person at the club rather
    // than our no-reply from-address.
    const effectiveReplyTo: string | null =
      replyToOverride || org.contact_email || senderEmail;

    // A continuation window must append to a broadcast this org owns — never
    // to a row from another tenant. (Only reachable on the attachments path.)
    if (windowed && cursor > 0 && broadcastIdIn) {
      const { data: bcRow, error: bcLookupErr } = await admin
        .from("contact_broadcasts")
        .select("id")
        .eq("id", broadcastIdIn)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (bcLookupErr) throw new Error(`broadcast lookup: ${bcLookupErr.message}`);
      if (!bcRow) return json({ error: "broadcast_not_found" }, 404);
    }

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

    // ── 5. The email for one recipient — shared by both delivery paths so
    //     an attachment send is the same message, same reply-to, same
    //     unsubscribe link + headers, plus the files. ────────────────────
    const buildEmail = async (r: Recipient, broadcastId: string) => {
      const token = await makeUnsubToken(SERVICE_KEY, organizationId, r.playerId, broadcastId);
      const unsubUrl = unsubscribeUrl(SUPABASE_URL, token);
      const html = renderEmailHtml({
        // No org-name eyebrow or subject heading in the body — the subject
        // already rides in the email's Subject line; the body starts with
        // the sender's own content under the branded logo band.
        bodyHtml: bodyIsHtml ? body : textToHtml(body),
        footer: `${escapeHtml(org.name ?? "This club")} via bert &amp; erne &mdash; pickleball tournaments<br /><a href="${unsubUrl}" style="color:#6b7280;">Unsubscribe</a>`,
      });
      return {
        from: fromAddress,
        to: [r.email],
        subject: subject.trim(),
        html,
        ...(effectiveReplyTo ? { reply_to: effectiveReplyTo } : {}),
        headers: {
          "List-Unsubscribe": `<${unsubUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      };
    };

    // ── 6a. Attachments → one POST /emails per recipient, one window per
    //      call. /emails/batch can't carry files, and per-recipient sends
    //      are rate-limited, so the client loops on nextCursor. ──────────
    if (windowed) {
      // Deterministic order so every window slices the same list. Emails are
      // already lowercased and unique per recipient; playerId breaks any tie.
      recipients.sort((a, b) =>
        a.email < b.email ? -1 : a.email > b.email ? 1 : a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0,
      );
      const total = recipients.length;

      let broadcastId: string;
      if (cursor === 0) {
        const { data: bc, error: bcErr } = await admin
          .from("contact_broadcasts")
          .insert({
            organization_id: organizationId,
            subject: subject.trim(),
            body: body,
            recipient_count: total,
            sent_by: authUserId,
          })
          .select("id")
          .single();
        if (bcErr || !bc) return json({ error: bcErr?.message ?? "broadcast_log_failed" }, 500);
        broadcastId = bc.id as string;
      } else {
        broadcastId = broadcastIdIn as string; // verified above to belong to this org
      }

      const start = Math.min(cursor, total);
      const end = Math.min(start + limit, total);
      const page = recipients.slice(start, end);

      let sent = 0;
      let failed = 0;
      let firstError: string | null = null;
      const logRows: { broadcast_id: string; player_id: string; email: string; resend_email_id: string | null }[] = [];
      for (let i = 0; i < page.length; i++) {
        const r = page[i];
        const email = { ...(await buildEmail(r, broadcastId)), attachments };
        const result = await sendOneEmail(resendApiKey, email);
        if (result.ok) {
          sent++;
          logRows.push({ broadcast_id: broadcastId, player_id: r.playerId, email: r.email, resend_email_id: result.id });
        } else {
          // Counted and logged, never thrown — one bad address must not lose
          // the rest of the window. Recipient rows are only written for
          // accepted sends (a row reads as "sent" forever).
          failed++;
          if (!firstError) firstError = result.error;
          console.error(`broadcast send failed for ${r.email}: ${result.error}`);
        }
        if (i < page.length - 1) await sleep(SEND_SPACING_MS);
      }

      if (logRows.length > 0) {
        const { error: recErr } = await admin.from("contact_broadcast_recipients").insert(logRows);
        if (recErr) console.error("recipient log failed", recErr.message);
      }

      const nextCursor = end < total ? end : null;

      // Nothing accepted across the WHOLE send → surface the error and don't
      // leave a phantom broadcast on the status page. Only knowable on the last
      // window (an earlier window sending 0 may still be followed by successes),
      // and only when no window at all produced a recipient row.
      if (nextCursor === null && sent === 0) {
        const { count, error: countErr } = await admin
          .from("contact_broadcast_recipients")
          .select("id", { count: "exact", head: true })
          .eq("broadcast_id", broadcastId);
        if (!countErr && count === 0) {
          await admin.from("contact_broadcasts").delete().eq("id", broadcastId);
          return json(
            {
              error: `Resend rejected the send — no emails went out. ${firstError ?? ""}`.trim(),
              detail: firstError,
            },
            502,
          );
        }
      }

      return json({
        broadcastId,
        recipientCount: total,
        sent,
        failed,
        nextCursor,
        ...(firstError ? { detail: firstError } : {}),
      });
    }

    // ── 6b. No attachments → log the broadcast, then batch-send ──────
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

    let sent = 0;
    // First Resend rejection, surfaced to the caller so a failed send stops
    // masquerading as a successful one (the usual cause is an unverified
    // sending domain or a test-mode API key — both come back verbatim here).
    let firstError: string | null = null;
    for (let start = 0; start < recipients.length; start += BATCH_SIZE) {
      const chunk = recipients.slice(start, start + BATCH_SIZE);

      // One email object per recipient, each with its own unsubscribe link.
      const emails = await Promise.all(chunk.map((r) => buildEmail(r, broadcastId)));

      let ids: (string | null)[];
      try {
        const resp = (await resend(resendApiKey, "POST", "/emails/batch", emails)) as {
          data?: { id?: string }[];
        };
        const returned = resp?.data ?? [];
        ids = chunk.map((_, i) => returned[i]?.id ?? null);
        sent += returned.length;
      } catch (e) {
        // Resend rejected this batch — nothing was sent for it. Remember the
        // reason and DON'T write recipient rows (they'd read as "sent" forever).
        if (!firstError) firstError = String((e as { message?: string })?.message ?? e);
        console.error("resend batch failed", firstError);
        continue;
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

    // ── 7. Nothing accepted → surface the error, don't log a phantom send ─
    if (sent === 0) {
      // Remove the broadcast row (cascades to any recipient rows) so it doesn't
      // show up on the status page as if it went out.
      await admin.from("contact_broadcasts").delete().eq("id", broadcastId);
      return json(
        {
          error: `Resend rejected the send — no emails went out. ${firstError ?? ""}`.trim(),
          detail: firstError,
        },
        502,
      );
    }

    // Partial failure: some batches sent, some didn't. Report both so the
    // sender knows coverage was incomplete (the sent rows are already logged).
    return json({
      broadcastId,
      recipientCount: recipients.length,
      sent,
      ...(firstError ? { failed: recipients.length - sent, detail: firstError } : {}),
    });
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
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: contacts, error } = await admin
      .from("organization_contacts")
      .select("player_id, unsubscribed_at")
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .order("player_id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`contacts: ${error.message}`);
    const page = (contacts ?? []) as { player_id: string; unsubscribed_at: string | null }[];
    for (const c of page) {
      if (c.unsubscribed_at) unsubscribed.add(c.player_id);
      else playerIds.add(c.player_id);
    }
    if (page.length < PAGE_SIZE) break;
  }

  // (b) registrants — distinct players with a live registration in any of the
  //     org's tournaments. One org-scoped query via the events join (same shape
  //     as the client's lib/orgContacts), paged past max_rows.
  const { data: tourneys, error: tErr } = await admin
    .from("tournaments")
    .select("id")
    .eq("organization_id", organizationId)
    .is("deleted_at", null);
  if (tErr) throw new Error(`tournaments: ${tErr.message}`);
  const tournamentIds = (tourneys ?? []).map((t: { id: string }) => t.id);
  if (tournamentIds.length > 0) {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data: regs, error: rErr } = await admin
        .from("event_registrations")
        .select("id, player_id, events!inner(tournament_id, deleted_at)")
        .in("events.tournament_id", tournamentIds)
        .is("events.deleted_at", null)
        .in("status", ACTIVE_REG_STATUSES)
        .is("deleted_at", null)
        .order("id")
        .range(from, from + PAGE_SIZE - 1);
      if (rErr) throw new Error(`registrations: ${rErr.message}`);
      const page = (regs ?? []) as { player_id: string }[];
      for (const r of page) {
        if (!unsubscribed.has(r.player_id)) playerIds.add(r.player_id);
      }
      if (page.length < PAGE_SIZE) break;
    }
  }

  if (playerIds.size === 0) return [];

  // Person rows, chunked so the id list stays well under the URL limit.
  type PlayerRow = {
    id: string;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
  };
  const players: PlayerRow[] = [];
  const allIds = [...playerIds];
  const CHUNK = 300;
  for (let i = 0; i < allIds.length; i += CHUNK) {
    const { data, error } = await admin
      .from("players")
      .select("id, email, first_name, last_name")
      .in("id", allIds.slice(i, i + CHUNK))
      .is("deleted_at", null);
    if (error) throw new Error(`players: ${error.message}`);
    players.push(...((data ?? []) as PlayerRow[]));
  }

  const out: Recipient[] = [];
  const seenEmail = new Set<string>();
  for (const p of players) {
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

// Make a `from` value safe for Resend's /emails/batch validator. A bare
// `email@domain` is left as-is; a `Display Name <email@domain>` is re-emitted
// with the display name ALWAYS quoted (stray quotes/newlines stripped), which
// is valid regardless of special characters in the name. Unparseable input is
// returned trimmed (Resend will still reject it — surfaced by the send loop).
function normalizeFrom(raw: string): string {
  const s = raw.trim().replace(/[\r\n]+/g, " ");
  const m = s.match(/^(.*?)\s*<\s*([^<>]+?)\s*>\s*$/);
  if (!m) return s; // bare address or unknown shape → leave as-is
  const name = m[1].trim().replace(/"/g, "").trim();
  const email = m[2].trim();
  return name ? `"${name}" <${email}>` : email;
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
