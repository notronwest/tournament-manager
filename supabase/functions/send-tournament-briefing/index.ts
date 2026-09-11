// supabase/functions/send-tournament-briefing/index.ts
//
// "Know before you go" — email every registered player of ONE tournament a
// personalised briefing: their own events with the scheduled start time of
// each, when to arrive, the waiver, warm-up rules, what to bring, plus any
// notes from the organizer. One email per player (a player in three events
// gets one email listing all three), sent through Resend's batch API and
// logged in contact_broadcasts / contact_broadcast_recipients so it shows up
// on the org's Email → History tab with delivery tracking.
//
// This is a service email about a registration the player holds, not
// marketing: it goes to every active registrant (paid, pending payment, or
// waitlisted) whether or not they have unsubscribed from the club's list, and
// it carries no unsubscribe link.
//
// Start times are stored as timestamptz with no tournament time zone on
// record, so the caller passes the IANA zone to format them in (the
// organizer's browser zone) and the email names it.
//
// ORG-STAFF only (member of the tournament's org, or a platform admin).
//
// Body: {
//   tournamentId: string,
//   mode: "preview" | "test" | "send",   preview → render one player's email,
//                                        test → send that render to the caller,
//                                        send → email everyone (consent: true)
//   timeZone: string,                    IANA zone, e.g. "America/New_York"
//   subject?: string,
//   waiverUrl?: string,                  link to sign the waiver online
//   arriveMinutes?: number,              default 30
//   firstGameWarmupMinutes?: number,     default 10
//   matchWarmupMinutes?: number,         default 3
//   notes?: string,                      organizer's extra notes (plain text)
//   replyTo?: string,
//   consent?: boolean,                   required for mode "send"
// }
// Returns (preview): { recipientCount, missingEmail, eventsMissingStart, html, sampleFor }
// Returns (test):    { sentTo }
// Returns (send):    { broadcastId, recipientCount, sent, failed?, detail? }
//
// Required secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Required secrets (set per project): RESEND_API_KEY, RESEND_FROM_ADDRESS.

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
const MAX_RECIPIENTS = 3000;
const BATCH_SIZE = 100; // Resend /emails/batch caps at 100 per call.
const PAGE_SIZE = 1000; // PostgREST max_rows — page list queries past it.
const ACTIVE_REG_STATUSES = ["paid", "pending_payment", "waitlisted", "waitlisted_pending_payment"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_TZ = "America/New_York";

type Mode = "preview" | "test" | "send";

type Body = {
  tournamentId?: string;
  mode?: Mode;
  timeZone?: string;
  subject?: string;
  waiverUrl?: string;
  arriveMinutes?: number;
  firstGameWarmupMinutes?: number;
  matchWarmupMinutes?: number;
  notes?: string;
  replyTo?: string;
  consent?: boolean;
};

type EventRow = {
  id: string;
  name: string;
  format: string;
  scheduled_start_at: string | null;
};

type RegRow = {
  id: string;
  player_id: string;
  event_id: string;
  status: string;
  partner_registration_id: string | null;
  waitlist_position: number | null;
};

type PlayerRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
};

type PlayerEvent = {
  event: EventRow;
  status: string;
  partnerName: string | null;
  waitlistPosition: number | null;
};

type Recipient = {
  playerId: string;
  email: string;
  first: string;
  last: string;
  events: PlayerEvent[];
};

type Settings = {
  timeZone: string;
  waiverUrl: string;
  arriveMinutes: number;
  firstGameWarmupMinutes: number;
  matchWarmupMinutes: number;
  notes: string;
};

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

    // ── 1. Caller ────────────────────────────────────────────────────
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const authUserId = userData.user.id;
    const senderEmail = (userData.user.email ?? "").trim() || null;

    // ── 2. Input ─────────────────────────────────────────────────────
    const body = (await req.json()) as Body;
    const mode: Mode = body.mode === "test" || body.mode === "send" ? body.mode : "preview";
    if (!body.tournamentId) return json({ error: "tournamentId is required" }, 400);
    if (mode === "send" && body.consent !== true) return json({ error: "consent_required" }, 400);
    if (mode !== "preview" && (!resendApiKey || !rawFrom)) {
      return json({ error: "server_misconfigured" }, 500);
    }
    const replyToOverride = typeof body.replyTo === "string" ? body.replyTo.trim() : "";
    if (replyToOverride && !EMAIL_RE.test(replyToOverride)) {
      return json({ error: "invalid_reply_to" }, 400);
    }
    const waiverUrl = typeof body.waiverUrl === "string" ? body.waiverUrl.trim() : "";
    if (waiverUrl && !/^https?:\/\/\S+$/i.test(waiverUrl)) {
      return json({ error: "invalid_waiver_url" }, 400);
    }
    const settings: Settings = {
      timeZone: validTimeZone(body.timeZone),
      waiverUrl,
      arriveMinutes: clampInt(body.arriveMinutes, 30, 0, 240),
      firstGameWarmupMinutes: clampInt(body.firstGameWarmupMinutes, 10, 0, 60),
      matchWarmupMinutes: clampInt(body.matchWarmupMinutes, 3, 0, 60),
      notes: typeof body.notes === "string" ? body.notes.trim() : "",
    };

    // ── 3. Tournament + authorization ───────────────────────────────
    const { data: t, error: tErr } = await admin
      .from("tournaments")
      .select("id, name, slug, organization_id, starts_at, ends_at, location_name, location_address")
      .eq("id", body.tournamentId)
      .is("deleted_at", null)
      .maybeSingle();
    if (tErr) throw new Error(`tournament: ${tErr.message}`);
    if (!t) return json({ error: "tournament_not_found" }, 404);
    if (!(await isOrgStaff(admin, t.organization_id, authUserId))) {
      return json({ error: "forbidden_org_staff_only" }, 403);
    }
    const { data: org, error: orgErr } = await admin
      .from("organizations")
      .select("id, name, slug, contact_email")
      .eq("id", t.organization_id)
      .single();
    if (orgErr || !org) return json({ error: "organization_not_found" }, 404);
    const effectiveReplyTo: string | null = replyToOverride || org.contact_email || senderEmail;
    const subject = (body.subject ?? "").trim() || `${t.name}: your start times and what to bring`;

    // ── 4. Events + registrations → one recipient per player ─────────
    const { data: evData, error: evErr } = await admin
      .from("events")
      .select("id, name, format, scheduled_start_at")
      .eq("tournament_id", t.id)
      .is("deleted_at", null)
      .order("scheduled_start_at", { ascending: true, nullsFirst: false })
      .order("name");
    if (evErr) throw new Error(`events: ${evErr.message}`);
    const events = (evData ?? []) as EventRow[];
    const eventById = new Map(events.map((e) => [e.id, e]));

    const regs: RegRow[] = [];
    if (events.length > 0) {
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await admin
          .from("event_registrations")
          .select("id, player_id, event_id, status, partner_registration_id, waitlist_position")
          .in("event_id", events.map((e) => e.id))
          .in("status", ACTIVE_REG_STATUSES)
          .is("deleted_at", null)
          .order("id")
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(`registrations: ${error.message}`);
        const page = (data ?? []) as RegRow[];
        regs.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
    }

    // Partner names come from the partner registration's player. A partner
    // whose own registration is inactive is not in `regs`, so look those up
    // too rather than showing "no partner" for a real pair.
    const partnerRegIds = [...new Set(regs.map((r) => r.partner_registration_id).filter(Boolean))] as string[];
    const partnerPlayerByReg = new Map<string, string>();
    for (const r of regs) partnerPlayerByReg.set(r.id, r.player_id);
    const missingPartnerRegs = partnerRegIds.filter((id) => !partnerPlayerByReg.has(id));
    for (let i = 0; i < missingPartnerRegs.length; i += 300) {
      const { data, error } = await admin
        .from("event_registrations")
        .select("id, player_id")
        .in("id", missingPartnerRegs.slice(i, i + 300));
      if (error) throw new Error(`partners: ${error.message}`);
      for (const r of (data ?? []) as { id: string; player_id: string }[]) {
        partnerPlayerByReg.set(r.id, r.player_id);
      }
    }

    const playerIds = new Set<string>(regs.map((r) => r.player_id));
    for (const pid of partnerPlayerByReg.values()) playerIds.add(pid);
    const players = new Map<string, PlayerRow>();
    const allPlayerIds = [...playerIds];
    for (let i = 0; i < allPlayerIds.length; i += 300) {
      const { data, error } = await admin
        .from("players")
        .select("id, first_name, last_name, email")
        .in("id", allPlayerIds.slice(i, i + 300))
        .is("deleted_at", null);
      if (error) throw new Error(`players: ${error.message}`);
      for (const p of (data ?? []) as PlayerRow[]) players.set(p.id, p);
    }

    const byPlayer = new Map<string, Recipient>();
    let missingEmail = 0;
    const seenEmail = new Set<string>();
    for (const r of regs) {
      const p = players.get(r.player_id);
      const ev = eventById.get(r.event_id);
      if (!p || !ev) continue;
      let rec = byPlayer.get(p.id);
      if (!rec) {
        const email = (p.email ?? "").trim().toLowerCase();
        if (!email || !email.includes("@")) {
          missingEmail++;
          continue;
        }
        if (seenEmail.has(email)) continue; // one email per address
        seenEmail.add(email);
        rec = {
          playerId: p.id,
          email,
          first: (p.first_name ?? "").trim(),
          last: (p.last_name ?? "").trim(),
          events: [],
        };
        byPlayer.set(p.id, rec);
      }
      const partnerPid = r.partner_registration_id
        ? partnerPlayerByReg.get(r.partner_registration_id)
        : undefined;
      const partner = partnerPid ? players.get(partnerPid) : undefined;
      if (!rec.events.some((e) => e.event.id === ev.id)) {
        rec.events.push({
          event: ev,
          status: r.status,
          partnerName: partner ? fullName(partner) : null,
          waitlistPosition: r.waitlist_position,
        });
      }
    }
    const recipients = [...byPlayer.values()].sort(
      (a, b) => a.last.localeCompare(b.last) || a.first.localeCompare(b.first),
    );
    for (const rec of recipients) rec.events.sort(byStart);
    const eventsMissingStart = events.filter((e) => !e.scheduled_start_at).map((e) => e.name);

    const render = (rec: Recipient) =>
      renderBriefing({ rec, t, org, settings, replyTo: effectiveReplyTo });

    // ── 5a. Preview: one player's email, no send ─────────────────────
    if (mode === "preview") {
      const sample = recipients[0] ?? null;
      const html = sample
        ? render(sample)
        : render({
            playerId: "",
            email: "",
            first: "Sample",
            last: "Player",
            events: events.slice(0, 2).map((event) => ({ event, status: "paid", partnerName: null, waitlistPosition: null })),
          });
      return json({
        recipientCount: recipients.length,
        missingEmail,
        eventsMissingStart,
        subject,
        html,
        sampleFor: sample ? `${sample.first} ${sample.last}`.trim() : null,
      });
    }

    const fromAddress = normalizeFrom(rawFrom as string);

    // ── 5b. Test: the sample email to the signed-in organizer ────────
    if (mode === "test") {
      if (!senderEmail) return json({ error: "no_sender_email" }, 400);
      const sample = recipients[0] ?? {
        playerId: "",
        email: senderEmail,
        first: "Sample",
        last: "Player",
        events: events.slice(0, 2).map((event) => ({ event, status: "paid", partnerName: null, waitlistPosition: null })),
      };
      await resend(resendApiKey as string, "POST", "/emails", {
        from: fromAddress,
        to: [senderEmail],
        subject: `[TEST] ${subject}`,
        html: render(sample),
        ...(effectiveReplyTo ? { reply_to: effectiveReplyTo } : {}),
      });
      return json({ sentTo: senderEmail });
    }

    // ── 5c. Send to everyone ─────────────────────────────────────────
    if (recipients.length === 0) return json({ error: "no_recipients" }, 400);
    if (recipients.length > MAX_RECIPIENTS) {
      return json({ error: `too_many_recipients (max ${MAX_RECIPIENTS})` }, 400);
    }

    const { data: bc, error: bcErr } = await admin
      .from("contact_broadcasts")
      .insert({
        organization_id: org.id,
        subject,
        body: briefingSummaryText(t.name, settings),
        recipient_count: recipients.length,
        sent_by: authUserId,
      })
      .select("id")
      .single();
    if (bcErr || !bc) throw new Error(`broadcast log: ${bcErr?.message ?? "no row"}`);
    const broadcastId: string = bc.id;

    let sent = 0;
    let firstError: string | null = null;
    for (let start = 0; start < recipients.length; start += BATCH_SIZE) {
      const chunk = recipients.slice(start, start + BATCH_SIZE);
      const emails = chunk.map((r) => ({
        from: fromAddress,
        to: [r.email],
        subject,
        html: render(r),
        ...(effectiveReplyTo ? { reply_to: effectiveReplyTo } : {}),
      }));

      let ids: (string | null)[];
      try {
        const resp = (await resend(resendApiKey as string, "POST", "/emails/batch", emails)) as {
          data?: { id?: string }[];
        };
        const returned = resp?.data ?? [];
        ids = chunk.map((_, i) => returned[i]?.id ?? null);
        sent += returned.length;
      } catch (e) {
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

    if (sent === 0) {
      await admin.from("contact_broadcasts").delete().eq("id", broadcastId);
      return json({ error: "send_failed", detail: firstError ?? "Resend accepted nothing" }, 502);
    }

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

// ── Rendering ───────────────────────────────────────────────────────

const P = `margin:0 0 14px;font-size:15px;color:#4a5159;line-height:1.6;`;
const H2 = `margin:26px 0 10px;font-size:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#14181f;`;
const LI = `margin:0 0 8px;font-size:15px;color:#4a5159;line-height:1.55;`;

function renderBriefing(args: {
  rec: Recipient;
  t: { name: string; slug: string; starts_at: string; ends_at: string; location_name: string | null; location_address: string | null };
  org: { name: string; slug: string };
  settings: Settings;
  replyTo: string | null;
}): string {
  const { rec, t, org, settings, replyTo } = args;
  const tz = settings.timeZone;
  const tzLabel = tzShortName(tz, rec.events.find((e) => e.event.scheduled_start_at)?.event.scheduled_start_at ?? t.starts_at);

  const where = [t.location_name, t.location_address].filter(Boolean).join(", ");
  const mapsUrl = t.location_address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t.location_address)}`
    : null;

  // Schedule table — one row per event the player is in.
  const rows = rec.events
    .map((pe) => {
      const isWaitlist = pe.status.startsWith("waitlisted");
      const when = pe.event.scheduled_start_at
        ? `${fmtDay(pe.event.scheduled_start_at, tz)} &middot; <strong>${fmtTime(pe.event.scheduled_start_at, tz)}</strong>`
        : `<span style="color:#8a9099;">Start time to be announced</span>`;
      const extra: string[] = [];
      if (pe.partnerName) extra.push(`Partner: ${escapeHtml(pe.partnerName)}`);
      else if (pe.event.format === "doubles" && !isWaitlist) extra.push(`Partner: not yet confirmed`);
      if (isWaitlist) {
        extra.push(
          pe.waitlistPosition
            ? `Waitlist — position ${pe.waitlistPosition}. We'll email you if a spot opens.`
            : `Waitlist — we'll email you if a spot opens.`,
        );
      } else if (pe.status === "pending_payment") {
        extra.push(`Payment still pending — please complete it to keep your spot.`);
      }
      // One stacked cell per event — a second column squeezes the event name
      // to a few characters on a phone.
      return `<tr>
        <td style="padding:10px 0;border-top:1px solid #e3dec8;vertical-align:top;font-size:15px;color:#14181f;">
          <strong>${escapeHtml(pe.event.name)}</strong>
          <div style="font-size:15px;color:#4a5159;margin-top:3px;">${when}</div>
          ${extra.map((x) => `<div style="font-size:13px;color:#6b7280;margin-top:3px;">${x}</div>`).join("")}
        </td>
      </tr>`;
    })
    .join("");

  // Arrival: N minutes before the player's earliest scheduled start.
  const firstStart = rec.events.map((e) => e.event.scheduled_start_at).filter(Boolean).sort()[0] as string | undefined;
  const arriveBy = firstStart
    ? new Date(new Date(firstStart).getTime() - settings.arriveMinutes * 60_000).toISOString()
    : null;
  const arrivalLine = arriveBy
    ? `Please be checked in by <strong>${fmtTime(arriveBy, tz)} on ${fmtDay(arriveBy, tz)}</strong> — that's ${settings.arriveMinutes} minutes before your first bracket starts.`
    : `Please arrive <strong>${settings.arriveMinutes} minutes before your first bracket starts</strong> so you're checked in and ready.`;

  const waiverLine = settings.waiverUrl
    ? `<strong>Sign the waiver.</strong> Every player must sign it to compete. <a href="${escapeHtml(settings.waiverUrl)}" style="color:#14181f;">Sign it online now</a> so check-in takes seconds.`
    : `<strong>Sign the waiver.</strong> Every player must sign it to compete — you'll do this at the check-in desk, so allow a few extra minutes.`;

  const notesHtml = settings.notes
    ? `<h2 style="${H2}">From the organizers</h2>${textToHtml(settings.notes)}`
    : "";

  const bodyHtml = `
    <p style="${P}">Hi ${escapeHtml(rec.first || "there")},</p>
    <p style="${P}"><strong>${escapeHtml(t.name)}</strong> is ${escapeHtml(fmtDateRange(t.starts_at, t.ends_at, tz))}${where ? ` at ${escapeHtml(where)}` : ""}. Here's your schedule and what to do before you arrive.</p>

    <h2 style="${H2}">Your schedule</h2>
    <table cellpadding="0" cellspacing="0" role="presentation" style="width:100%;border-collapse:collapse;border-bottom:1px solid #e3dec8;">
      ${rows}
    </table>
    <p style="margin:8px 0 0;font-size:12px;color:#8a9099;">All times ${escapeHtml(tzLabel)}. Brackets can shift as the day runs — check the desk when you arrive.</p>

    <h2 style="${H2}">When to arrive</h2>
    <p style="${P}">${arrivalLine}</p>

    <h2 style="${H2}">Before you play</h2>
    <ol style="margin:0;padding-left:20px;">
      <li style="${LI}">${waiverLine}</li>
      <li style="${LI}"><strong>Check in at the desk</strong> when you arrive. Tell us your name and your bracket and we'll confirm your court.</li>
      <li style="${LI}"><strong>Warm up.</strong> Open courts are usually available before your bracket. Each team also gets a <strong>${settings.firstGameWarmupMinutes}-minute warm-up before its first game</strong> and a <strong>${settings.matchWarmupMinutes}-minute warm-up before every match after that</strong>.</li>
      <li style="${LI}"><strong>Stay near your court between games.</strong> Brackets keep moving — if your team isn't there when it's called, you may forfeit that game.</li>
    </ol>

    <h2 style="${H2}">What to bring</h2>
    <ul style="margin:0;padding-left:20px;">
      <li style="${LI}"><strong>Lots of water.</strong> You'll play several games in a row — bring more than you think you need.</li>
      <li style="${LI}">Your paddle, court shoes, and a towel.</li>
      <li style="${LI}">Snacks you can eat between games.</li>
      <li style="${LI}">A layer for the weather, sunscreen, and a hat if you're outdoors.</li>
      <li style="${LI}">A folding chair if you like somewhere to sit between games.</li>
    </ul>
    ${notesHtml}
    ${
      mapsUrl
        ? `<h2 style="${H2}">Getting there</h2><p style="${P}">${escapeHtml(where)}<br /><a href="${escapeHtml(mapsUrl)}" style="color:#14181f;">Open in Google Maps</a></p>`
        : ""
    }
    <p style="${P}margin-top:20px;">Questions? ${replyTo ? "Just reply to this email." : `Contact ${escapeHtml(org.name)}.`} See you on the courts!</p>
  `;

  return renderEmailHtml({
    headingLabel: org.name,
    heading: `Your ${t.name} briefing`,
    bodyHtml,
    ctaLabel: "View the tournament page",
    ctaUrl: `${SITE_URL}/t/${org.slug}/${t.slug}`,
    footer: `${escapeHtml(org.name)} via bert &amp; erne &mdash; pickleball tournaments<br />You're receiving this because you're registered for ${escapeHtml(t.name)}.`,
  });
}

function briefingSummaryText(tournamentName: string, s: Settings): string {
  const lines = [
    `Player briefing for ${tournamentName}: each player's events and start times (${s.timeZone}).`,
    `Arrive ${s.arriveMinutes} min early · waiver ${s.waiverUrl ? s.waiverUrl : "at check-in"} · ${s.firstGameWarmupMinutes}-min first-game warm-up, ${s.matchWarmupMinutes}-min match warm-up · bring water.`,
  ];
  if (s.notes) lines.push("", s.notes);
  return lines.join("\n");
}

// ── Helpers ─────────────────────────────────────────────────────────

function byStart(a: PlayerEvent, b: PlayerEvent): number {
  const as = a.event.scheduled_start_at ?? "9999";
  const bs = b.event.scheduled_start_at ?? "9999";
  return as.localeCompare(bs) || a.event.name.localeCompare(b.event.name);
}

function fullName(p: PlayerRow): string {
  return `${(p.first_name ?? "").trim()} ${(p.last_name ?? "").trim()}`.trim();
}

function validTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || !tz.trim()) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() }).format(new Date());
    return tz.trim();
  } catch {
    return DEFAULT_TZ;
  }
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.min(max, Math.max(min, n));
}

function fmtDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
}

function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function tzShortName(tz: string, iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(iso));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
}

// Tournament start/end are date-only in practice; render "Saturday, June 6"
// or "June 6–7" without a time.
function fmtDateRange(startIso: string, endIso: string, tz: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const day = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", day: "numeric" }).format(d);
  const wd = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(d);
  if (day(s) === day(e)) return `${wd(s)}, ${day(s)}`;
  return `${day(s)} – ${day(e)}`;
}

// Plain text → safe HTML paragraphs (blank line = new <p>, single newline = <br>).
function textToHtml(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p style="${P}">${escapeHtml(para).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

function normalizeFrom(raw: string): string {
  const s = raw.trim().replace(/[\r\n]+/g, " ");
  const m = s.match(/^(.*?)\s*<\s*([^<>]+?)\s*>\s*$/);
  if (!m) return s;
  const name = m[1].trim().replace(/"/g, "").trim();
  const email = m[2].trim();
  return name ? `"${name}" <${email}>` : email;
}

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
