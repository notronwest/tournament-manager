// supabase/functions/notify-registration-change/index.ts
//
// Tell players when an ORGANIZER changes their registration for them: moved to
// a different division, given a new partner, or split from a partner. Until
// now these desk edits were silent — the player found out at check-in.
//
// The admin editor performs the change itself (direct table updates), then
// invokes this function with what changed. This function only loads the
// current state, works out who is affected, and emails them. It never mutates
// registrations, so a failed email can't leave data half-changed.
//
// ORG-STAFF only (member of the tournament's org, or a platform admin).
//
// Body: {
//   registrationId: string,
//   change: "moved" | "partner_assigned" | "partner_removed",
//   fromEventId?: string,          moved: the division they left
//   previousPartnerRegId?: string, moved / partner_removed: the partner they
//                                  were split from (also emailed)
//   timeZone?: string,             IANA zone for start times (organizer's browser)
// }
// Returns: { emailed: string[], skipped: { who: string, reason: string }[] }
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

const SITE_URL = "https://bertanderne.com";
const DEFAULT_TZ = "America/New_York";
const P = `margin:0 0 14px;font-size:15px;color:#4a5159;line-height:1.6;`;

type Change = "moved" | "partner_assigned" | "partner_removed";

type Body = {
  registrationId?: string;
  change?: Change;
  fromEventId?: string;
  previousPartnerRegId?: string;
  timeZone?: string;
};

type Player = { id: string; first_name: string | null; last_name: string | null; email: string | null };
type EventRow = { id: string; name: string; format: string; scheduled_start_at: string | null };

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

    // ── 2. Input ─────────────────────────────────────────────────────
    const body = (await req.json()) as Body;
    if (!body.registrationId) return json({ error: "registrationId is required" }, 400);
    const change = body.change;
    if (change !== "moved" && change !== "partner_assigned" && change !== "partner_removed") {
      return json({ error: "change must be moved | partner_assigned | partner_removed" }, 400);
    }
    const tz = validTimeZone(body.timeZone);

    // ── 3. Current state of the registration ────────────────────────
    const { data: reg, error: regErr } = await admin
      .from("event_registrations")
      .select(
        "id, player_id, event_id, status, partner_status, partner_registration_id, events!inner(id, name, format, scheduled_start_at, tournament_id, tournaments!inner(id, name, slug, starts_at, location_name, organization_id, organizations!inner(id, name, slug, contact_email)))",
      )
      .eq("id", body.registrationId)
      .is("deleted_at", null)
      .maybeSingle();
    if (regErr) throw new Error(`registration: ${regErr.message}`);
    if (!reg) return json({ error: "registration_not_found" }, 404);

    type Joined = {
      id: string;
      player_id: string;
      event_id: string;
      status: string;
      partner_status: string;
      partner_registration_id: string | null;
      events: EventRow & {
        tournament_id: string;
        tournaments: {
          id: string;
          name: string;
          slug: string;
          starts_at: string;
          location_name: string | null;
          organization_id: string;
          organizations: { id: string; name: string; slug: string; contact_email: string | null };
        };
      };
    };
    const r = reg as unknown as Joined;
    const event = r.events;
    const t = event.tournaments;
    const org = t.organizations;

    if (!(await isOrgStaff(admin, t.organization_id, authUserId))) {
      return json({ error: "forbidden_org_staff_only" }, 403);
    }
    if (!resendApiKey || !rawFrom) return json({ error: "server_misconfigured" }, 500);

    // Players involved: the registrant, their current partner (if any), and
    // the partner they were split from (if the caller told us).
    const wantIds = new Set<string>([r.player_id]);
    let currentPartnerPid: string | null = null;
    if (r.partner_registration_id) {
      const { data: pr } = await admin
        .from("event_registrations")
        .select("player_id")
        .eq("id", r.partner_registration_id)
        .maybeSingle();
      if (pr?.player_id) {
        currentPartnerPid = pr.player_id as string;
        wantIds.add(currentPartnerPid);
      }
    }
    let previousPartnerPid: string | null = null;
    if (body.previousPartnerRegId) {
      const { data: pr } = await admin
        .from("event_registrations")
        .select("player_id")
        .eq("id", body.previousPartnerRegId)
        .maybeSingle();
      if (pr?.player_id && pr.player_id !== r.player_id) {
        previousPartnerPid = pr.player_id as string;
        wantIds.add(previousPartnerPid);
      }
    }
    const { data: pdata, error: pErr } = await admin
      .from("players")
      .select("id, first_name, last_name, email")
      .in("id", [...wantIds]);
    if (pErr) throw new Error(`players: ${pErr.message}`);
    const players = new Map<string, Player>();
    for (const p of (pdata ?? []) as Player[]) players.set(p.id, p);

    let fromEvent: EventRow | null = null;
    if (change === "moved" && body.fromEventId) {
      const { data: fe } = await admin
        .from("events")
        .select("id, name, format, scheduled_start_at")
        .eq("id", body.fromEventId)
        .maybeSingle();
      fromEvent = (fe as EventRow | null) ?? null;
    }

    const me = players.get(r.player_id) ?? null;
    const partner = currentPartnerPid ? players.get(currentPartnerPid) ?? null : null;
    const previous = previousPartnerPid ? players.get(previousPartnerPid) ?? null : null;
    const pageUrl = `${SITE_URL}/t/${org.slug}/${t.slug}`;
    const isDoubles = event.format === "doubles";
    const whenLine = event.scheduled_start_at
      ? `<p style="${P}">It starts <strong>${escapeHtml(fmtWhen(event.scheduled_start_at, tz))}</strong>${t.location_name ? ` at ${escapeHtml(t.location_name)}` : ""}.</p>`
      : `<p style="${P}">Start times will be emailed before the tournament.</p>`;

    // ── 4. Compose one email per affected person ─────────────────────
    type Msg = { to: Player | null; who: string; subject: string; heading: string; bodyHtml: string };
    const msgs: Msg[] = [];

    if (change === "moved") {
      const partnerNote = isDoubles
        ? partner
          ? `<p style="${P}">Your partner is <strong>${escapeHtml(fullName(partner))}</strong>.</p>`
          : `<p style="${P}">This is a doubles division and you don't have a partner in it yet. Open the tournament page to invite one, or reply to this email and we'll help.</p>`
        : "";
      msgs.push({
        to: me,
        who: "player",
        subject: `Your registration moved to ${event.name} — ${t.name}`,
        heading: `You're now in ${event.name}`,
        bodyHtml: `
          <p style="${P}">Hi ${escapeHtml(firstName(me))},</p>
          <p style="${P}">The organizers moved your <strong>${escapeHtml(t.name)}</strong> registration${fromEvent ? ` from <strong>${escapeHtml(fromEvent.name)}</strong>` : ""} to <strong>${escapeHtml(event.name)}</strong>. Nothing changes about what you've paid.</p>
          ${whenLine}${partnerNote}`,
      });
      if (previous) {
        msgs.push({
          to: previous,
          who: "previous partner",
          subject: `${fullName(me)} moved divisions — you need a new partner for ${fromEvent?.name ?? "your event"}`,
          heading: `You need a new partner${fromEvent ? ` for ${fromEvent.name}` : ""}`,
          bodyHtml: `
            <p style="${P}">Hi ${escapeHtml(firstName(previous))},</p>
            <p style="${P}">The organizers moved <strong>${escapeHtml(fullName(me))}</strong> to <strong>${escapeHtml(event.name)}</strong> at <strong>${escapeHtml(t.name)}</strong>, so you're no longer paired${fromEvent ? ` in <strong>${escapeHtml(fromEvent.name)}</strong>` : ""}. Your own registration is unchanged.</p>
            <p style="${P}">Open the tournament page to invite a new partner, or reply to this email and the organizers will help you find one.</p>`,
        });
      }
    }

    if (change === "partner_assigned") {
      if (!partner) return json({ error: "no_partner_on_registration" }, 409);
      const pair = (to: Player, other: Player) => ({
        to,
        who: to.id === r.player_id ? "player" : "new partner",
        subject: `You're partnered with ${fullName(other)} for ${event.name} — ${t.name}`,
        heading: `Your partner for ${event.name}`,
        bodyHtml: `
          <p style="${P}">Hi ${escapeHtml(firstName(to))},</p>
          <p style="${P}">The organizers have paired you with <strong>${escapeHtml(fullName(other))}</strong> for <strong>${escapeHtml(event.name)}</strong> at <strong>${escapeHtml(t.name)}</strong>. You're all set as a team.</p>
          ${whenLine}
          <p style="${P}">Not right? Reply to this email and the organizers will sort it out.</p>`,
      });
      if (me) msgs.push(pair(me, partner));
      msgs.push(pair(partner, me ?? { id: "", first_name: null, last_name: null, email: null }));
    }

    if (change === "partner_removed") {
      const split = (to: Player, other: Player | null) => ({
        to,
        who: to.id === r.player_id ? "player" : "previous partner",
        subject: `Partner change for ${event.name} — ${t.name}`,
        heading: `You need a new partner for ${event.name}`,
        bodyHtml: `
          <p style="${P}">Hi ${escapeHtml(firstName(to))},</p>
          <p style="${P}">The organizers have unpaired you${other ? ` and <strong>${escapeHtml(fullName(other))}</strong>` : ""} for <strong>${escapeHtml(event.name)}</strong> at <strong>${escapeHtml(t.name)}</strong>. Your registration is still active; you just need a partner again.</p>
          <p style="${P}">Open the tournament page to invite someone, or reply to this email and the organizers will help you find a partner.</p>`,
      });
      if (me) msgs.push(split(me, previous));
      if (previous) msgs.push(split(previous, me));
    }

    // ── 5. Send ───────────────────────────────────────────────────────
    const fromAddress = normalizeFrom(rawFrom);
    const replyTo = org.contact_email || userData.user.email || undefined;
    const emailed: string[] = [];
    const skipped: { who: string; reason: string }[] = [];
    for (const m of msgs) {
      const email = (m.to?.email ?? "").trim().toLowerCase();
      if (!m.to || !email || !email.includes("@")) {
        skipped.push({ who: m.who, reason: "no email address" });
        continue;
      }
      const html = renderEmailHtml({
        headingLabel: org.name,
        heading: m.heading,
        bodyHtml: m.bodyHtml,
        ctaLabel: "Open the tournament page",
        ctaUrl: pageUrl,
        footer: `${escapeHtml(org.name)} via bert &amp; erne &mdash; pickleball tournaments<br />You're receiving this because you're registered for ${escapeHtml(t.name)}.`,
      });
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromAddress, to: [email], subject: m.subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
      });
      if (resp.ok) emailed.push(email);
      else skipped.push({ who: m.who, reason: `email service: ${(await resp.text()).slice(0, 200)}` });
    }
    return json({ emailed, skipped });
  } catch (e) {
    return json({ error: "internal_error", detail: String((e as { message?: string })?.message ?? e) }, 500);
  }
});

// ── Helpers ─────────────────────────────────────────────────────────

function fullName(p: Player | null): string {
  const n = `${(p?.first_name ?? "").trim()} ${(p?.last_name ?? "").trim()}`.trim();
  return n || "your partner";
}

function firstName(p: Player | null): string {
  return (p?.first_name ?? "").trim() || "there";
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

function fmtWhen(iso: string, tz: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
  return `${day} at ${time}`;
}

function normalizeFrom(raw: string): string {
  const s = raw.trim().replace(/[\r\n]+/g, " ");
  const m = s.match(/^(.*?)\s*<\s*([^<>]+?)\s*>\s*$/);
  if (!m) return s;
  const name = m[1].trim().replace(/"/g, "").trim();
  const address = m[2].trim();
  return name ? `"${name}" <${address}>` : address;
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
