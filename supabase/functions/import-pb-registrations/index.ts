// supabase/functions/import-pb-registrations/index.ts
//
// Import an org's PickleballBrackets.com registrant export into a B&E tournament
// (D-0045 / #981). The browser parses PB.com's "Export Player w/ Events (Flat
// File)" into attendees (see web/src/lib/pbImport.ts) and posts them here; this
// function never sees the raw file. PB.com owns registration + division setup, so
// this INGESTS that structure and preserves PB.com's ids on every B&E record for
// the later results-push (#982):
//   * events                — source_division_label (the division's PB identity)
//   * event_registrations   — source_activity_id / source_team_id /
//                             source_attendee_header_id
// DUPR is first-class on the player (B&E seeds the draw from it) and is REFRESHED
// on every import (ratings move between registration open and close).
//
// What it does, idempotently (safe to re-run Wed night on an updated export):
//   1. divisions  — match by source label, else adopt a same-named B&E event,
//                   else create one from the parsed label. Never duplicated.
//   2. players    — match by email, else create. DUPR id + ratings refreshed for
//                   all. Other shared fields never clobbered (cross-org players).
//   3. entries    — insert an event_registration keyed by ActivityID if absent;
//                   an already-imported ActivityID is left unchanged (no dup).
//   4. partners   — two entries sharing a TeamID in one division are linked as a
//                   confirmed doubles team.
//   5. drops      — a pbcom entry in B&E whose ActivityID is gone from the file is
//                   REPORTED, never deleted.
// The bracket DRAW is NOT built here (B&E generates it from DUPR — separate).
//
// ORG-STAFF only. All DB work uses the service-role client (bypasses RLS).
//
// Body: { organizationId, tournamentId, attendees: Attendee[] }
// Returns: a summary (divisions / players / entries / partnersPaired / drops / …)
//
// Required secrets (auto-injected): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

// @ts-expect-error remote import resolved at runtime by Deno
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_ATTENDEES = 5000;
const SOURCE = "pbcom";

type DivisionMeta = {
  raw: string;
  gender: "men" | "women" | "mixed" | null;
  format: "doubles" | "singles" | null;
  bracketType: "skill" | "age" | null;
  low: number | null;
  high: number | null;
};
type Entry = {
  activityId?: string | null;
  teamId?: string | null;
  divisionLabel?: string | null;
  division?: DivisionMeta | null;
};
type Attendee = {
  attendeeHeaderId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  gender?: string | null;
  email?: string | null;
  phone?: string | null;
  duprId?: string | null;
  ratingDuprDbl?: string | number | null;
  ratingDuprS?: string | number | null;
  entries?: Entry[];
};
type Body = {
  organizationId?: string;
  tournamentId?: string;
  attendees?: Attendee[];
};

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

    // ── 1. Authenticate ──────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const authUserId = userData.user.id;

    // ── 2. Input ─────────────────────────────────────────────────────
    const { organizationId, tournamentId, attendees } = (await req.json()) as Body;
    if (!organizationId) return json({ error: "organizationId is required" }, 400);
    if (!tournamentId) return json({ error: "tournamentId is required" }, 400);
    if (!Array.isArray(attendees)) return json({ error: "attendees must be an array" }, 400);
    if (attendees.length === 0) return json({ error: "no attendees to import" }, 400);
    if (attendees.length > MAX_ATTENDEES) {
      return json({ error: `too many attendees (max ${MAX_ATTENDEES})` }, 400);
    }

    // ── 3. Authorize ─────────────────────────────────────────────────
    if (!(await isOrgStaff(admin, organizationId, authUserId))) {
      return json({ error: "forbidden_org_staff_only" }, 403);
    }

    // ── 4. Verify the tournament belongs to this org ─────────────────
    const { data: tournament, error: tErr } = await admin
      .from("tournaments")
      .select("id, organization_id, deleted_at")
      .eq("id", tournamentId)
      .maybeSingle();
    if (tErr) return json({ error: tErr.message }, 500);
    if (!tournament || tournament.deleted_at || tournament.organization_id !== organizationId) {
      return json({ error: "tournament_not_in_org" }, 404);
    }

    const warnings: string[] = [];
    const errors: string[] = [];

    // ── 5. Resolve / create divisions (events) ───────────────────────
    // Collect distinct divisions from all attendee entries, keyed by label.
    const wantDivisions = new Map<string, { label: string; meta: DivisionMeta }>();
    for (const a of attendees) {
      for (const e of a.entries ?? []) {
        const label = str(e.divisionLabel);
        if (!label) continue;
        const key = divKey(label);
        if (!wantDivisions.has(key)) {
          const cleanLabel = stripWaitlist(label);
          wantDivisions.set(key, {
            label: cleanLabel,
            meta: e.division ?? parseDivisionFallback(cleanLabel),
          });
        }
      }
    }

    const { data: existingEvents, error: evErr } = await admin
      .from("events")
      .select("id, name, format, gender, source_system, source_division_label")
      .eq("tournament_id", tournamentId)
      .is("deleted_at", null);
    if (evErr) return json({ error: evErr.message }, 500);

    const eventByLabelKey = new Map<string, string>(); // divKey → event id
    const eventByNormName = new Map<string, string>();
    for (const ev of (existingEvents ?? []) as EvRow[]) {
      if (ev.source_division_label) {
        eventByLabelKey.set(divKey(ev.source_division_label), ev.id);
      }
      eventByNormName.set(divKey(ev.name), ev.id);
    }

    let divisionsCreated = 0;
    let divisionsMatched = 0;
    const divKeyToEventId = new Map<string, string>();
    for (const [key, d] of wantDivisions) {
      // (a) already imported under this source label → reuse.
      const bySource = eventByLabelKey.get(key);
      if (bySource) {
        divKeyToEventId.set(key, bySource);
        divisionsMatched++;
        continue;
      }
      // (b) a same-named B&E event exists → adopt it (tag with the source label).
      const byName = eventByNormName.get(key);
      if (byName) {
        const { error: upErr } = await admin
          .from("events")
          .update({
            source_system: SOURCE,
            source_division_label: d.label,
            source_division_meta: d.meta,
          })
          .eq("id", byName);
        if (upErr) { errors.push(`division "${d.label}": adopt failed: ${upErr.message}`); continue; }
        divKeyToEventId.set(key, byName);
        eventByLabelKey.set(key, byName);
        divisionsMatched++;
        continue;
      }
      // (c) create a new division from the parsed label.
      const insert = eventInsertFromMeta(tournamentId, d.label, d.meta, warnings);
      const { data: created, error: cErr } = await admin
        .from("events")
        .insert(insert)
        .select("id")
        .single();
      if (cErr || !created) { errors.push(`division "${d.label}": create failed: ${cErr?.message ?? "insert_failed"}`); continue; }
      divKeyToEventId.set(key, created.id);
      eventByLabelKey.set(key, created.id);
      divisionsCreated++;
    }

    // ── 6. Resolve / create players + refresh DUPR ───────────────────
    // Dedupe attendees to players by identity key (email else name).
    type P = {
      key: string; first: string; last: string; email: string | null;
      phone: string | null; gender: "M" | "F" | "X" | null;
      duprId: string | null; duprDbl: number | null; duprS: number | null;
    };
    const wantPlayers = new Map<string, P>();
    for (const a of attendees) {
      const first = str(a.firstName);
      const last = str(a.lastName);
      const email = normEmail(a.email);
      const key = playerKey(email, first, last);
      if (!key) continue;
      const prev = wantPlayers.get(key);
      wantPlayers.set(key, {
        key,
        first: prev?.first || first || last,
        last: prev?.last || (first ? last : ""),
        email: prev?.email ?? email,
        phone: prev?.phone ?? (str(a.phone) || null),
        gender: prev?.gender ?? normGender(a.gender),
        duprId: prev?.duprId ?? normDuprId(a.duprId),
        duprDbl: prev?.duprDbl ?? parseDupr(a.ratingDuprDbl),
        duprS: prev?.duprS ?? parseDupr(a.ratingDuprS),
      });
    }

    // Match existing players by email (batch).
    const emails = [...wantPlayers.values()].map((p) => p.email).filter((e): e is string => !!e);
    const emailToId = new Map<string, string>();
    if (emails.length > 0) {
      const { data: existing, error: exErr } = await admin
        .from("players")
        .select("id, email")
        .in("email", emails)
        .is("deleted_at", null);
      if (exErr) return json({ error: exErr.message }, 500);
      for (const p of (existing ?? []) as { id: string; email: string | null }[]) {
        const k = (p.email ?? "").toLowerCase();
        if (k && !emailToId.has(k)) emailToId.set(k, p.id);
      }
    }

    // Create the players with no email match.
    const keyToPlayerId = new Map<string, string>();
    let playersCreated = 0;
    let playersMatched = 0;
    const toCreate: P[] = [];
    for (const p of wantPlayers.values()) {
      const emailKey = p.email;
      if (emailKey && emailToId.has(emailKey)) {
        keyToPlayerId.set(p.key, emailToId.get(emailKey)!);
        playersMatched++;
      } else {
        toCreate.push(p);
      }
    }
    if (toCreate.length > 0) {
      const { data: ins, error: insErr } = await admin
        .from("players")
        .insert(
          toCreate.map((p) => ({
            first_name: p.first,
            last_name: p.last,
            email: p.email,
            phone: p.phone,
            gender: p.gender,
            dupr_id: p.duprId,
            dupr_rating_doubles: p.duprDbl,
            dupr_rating_singles: p.duprS,
          })),
        )
        .select("id");
      if (insErr) return json({ error: insErr.message }, 500);
      const insRows = (ins ?? []) as { id: string }[];
      playersCreated = insRows.length;
      for (let i = 0; i < toCreate.length; i++) {
        const id = insRows[i]?.id;
        if (id) keyToPlayerId.set(toCreate[i].key, id);
      }
    }

    // Refresh DUPR on matched players (authoritative; only overwrite when the
    // export actually provides a value, so a later blank export can't wipe it).
    let duprRefreshed = 0;
    for (const p of wantPlayers.values()) {
      const pid = keyToPlayerId.get(p.key);
      if (!pid || toCreate.some((c) => c.key === p.key)) continue; // new players already carry DUPR
      const patch: Record<string, unknown> = {};
      if (p.duprId !== null) patch.dupr_id = p.duprId;
      if (p.duprDbl !== null) patch.dupr_rating_doubles = p.duprDbl;
      if (p.duprS !== null) patch.dupr_rating_singles = p.duprS;
      if (Object.keys(patch).length === 0) continue;
      const { error: upErr } = await admin.from("players").update(patch).eq("id", pid);
      if (upErr) { errors.push(`DUPR refresh for player ${pid}: ${upErr.message}`); continue; }
      duprRefreshed++;
    }

    // ── 7. Load existing pbcom entries for this tournament (idempotency) ──
    const eventIds = [...divKeyToEventId.values()];
    const allEventIds = [...new Set([...(existingEvents ?? []).map((e: EvRow) => e.id), ...eventIds])];
    const existingRegByActivity = new Map<string, RegRow>();
    const existingRegByEventPlayer = new Map<string, RegRow>();
    if (allEventIds.length > 0) {
      const { data: regs, error: regErr } = await admin
        .from("event_registrations")
        .select("id, event_id, player_id, partner_registration_id, partner_status, source_system, source_activity_id, source_team_id")
        .in("event_id", allEventIds)
        .is("deleted_at", null);
      if (regErr) return json({ error: regErr.message }, 500);
      for (const r of (regs ?? []) as RegRow[]) {
        if (r.source_activity_id) existingRegByActivity.set(r.source_activity_id, r);
        existingRegByEventPlayer.set(`${r.event_id}::${r.player_id}`, r);
      }
    }

    // ── 8. Create entries (insert-if-absent by ActivityID) ───────────
    let entriesAdded = 0;
    let entriesUnchanged = 0;
    const fileActivityIds = new Set<string>();
    // regId lookup for pairing: (eventId::teamId) → [{regId, playerId}]
    const teamGroups = new Map<string, { regId: string; playerId: string }[]>();

    for (const a of attendees) {
      const first = str(a.firstName);
      const last = str(a.lastName);
      const pkey = playerKey(normEmail(a.email), first, last);
      const playerId = keyToPlayerId.get(pkey);
      if (!playerId) continue;
      for (const e of a.entries ?? []) {
        const label = str(e.divisionLabel);
        if (!label) continue;
        const eventId = divKeyToEventId.get(divKey(label));
        if (!eventId) continue; // division failed to create → already in errors
        const activityId = str(e.activityId) || null;
        if (activityId) fileActivityIds.add(activityId);
        const isDoubles = (e.division?.format ?? "doubles") === "doubles";
        const teamId = str(e.teamId) || null;

        // Already imported? Idempotency is (event, player) — one registration
        // per player per division. NOTE: PB's ActivityID is the DIVISION id
        // (shared by every registrant in a division), NOT a per-entry id, so it
        // must NOT be the dedup key — doing so collapses a whole division to one
        // registration. It is still stored (source_activity_id) for the push.
        let reg =
          existingRegByEventPlayer.get(`${eventId}::${playerId}`) ||
          null;
        if (reg) {
          entriesUnchanged++;
          // Backfill source fields on a row that pre-existed without them.
          if (!reg.source_activity_id && activityId) {
            await admin
              .from("event_registrations")
              .update({
                source_system: SOURCE,
                source_activity_id: activityId,
                source_team_id: teamId,
                source_attendee_header_id: str(a.attendeeHeaderId) || null,
              })
              .eq("id", reg.id);
          }
        } else {
          const { data: newReg, error: nErr } = await admin
            .from("event_registrations")
            .insert({
              event_id: eventId,
              player_id: playerId,
              event_fee_cents: 0, // payment was collected on PB.com
              status: "paid",
              partner_status: isDoubles ? "seeking" : "solo",
              source_system: SOURCE,
              source_activity_id: activityId,
              source_team_id: teamId,
              source_attendee_header_id: str(a.attendeeHeaderId) || null,
              registered_at: new Date().toISOString(),
            })
            .select("id, event_id, player_id, partner_registration_id, partner_status, source_activity_id, source_team_id")
            .single();
          if (nErr || !newReg) { errors.push(`entry ${label} / ${pkey}: ${nErr?.message ?? "insert_failed"}`); continue; }
          reg = newReg as RegRow;
          entriesAdded++;
          existingRegByEventPlayer.set(`${eventId}::${playerId}`, reg);
          if (activityId) existingRegByActivity.set(activityId, reg);
        }

        if (isDoubles && teamId && reg) {
          const gk = `${eventId}::${teamId}`;
          const list = teamGroups.get(gk) ?? [];
          if (!list.some((m) => m.regId === reg!.id)) list.push({ regId: reg.id, playerId });
          teamGroups.set(gk, list);
        }
      }
    }

    // ── 9. Pair doubles partners sharing a TeamID ────────────────────
    let partnersPaired = 0;
    for (const [, members] of teamGroups) {
      if (members.length !== 2) {
        if (members.length > 2) warnings.push("A TeamID had more than 2 members; left unpaired.");
        continue;
      }
      const [x, y] = members;
      const [rX, rY] = await Promise.all([
        admin.from("event_registrations").update({ partner_registration_id: y.regId, partner_status: "confirmed" }).eq("id", x.regId),
        admin.from("event_registrations").update({ partner_registration_id: x.regId, partner_status: "confirmed" }).eq("id", y.regId),
      ]);
      const perr = [rX, rY].find((r: { error?: { message: string } }) => r.error)?.error;
      if (perr) { errors.push(`pairing failed: ${perr.message}`); continue; }
      partnersPaired++;
    }

    // ── 10. Drops: pbcom entries in B&E no longer in the file ─────────
    const drops: { regId: string; eventId: string; playerId: string; activityId: string | null }[] = [];
    for (const [activityId, r] of existingRegByActivity) {
      if (r.source_system === SOURCE && !fileActivityIds.has(activityId)) {
        drops.push({ regId: r.id, eventId: r.event_id, playerId: r.player_id, activityId });
      }
    }

    return json({
      divisions: { created: divisionsCreated, matched: divisionsMatched, total: wantDivisions.size },
      players: { created: playersCreated, matched: playersMatched, duprRefreshed },
      entries: { added: entriesAdded, unchanged: entriesUnchanged },
      partnersPaired,
      drops,
      attendees: attendees.length,
      warnings,
      ...(errors.length > 0 ? { errors } : {}),
    });
  } catch (e) {
    return json({ error: "internal_error", detail: String((e as { message?: string })?.message ?? e) }, 500);
  }
});

// ── helpers ────────────────────────────────────────────────────────────

type EvRow = { id: string; name: string; format: string; gender: string; source_system: string | null; source_division_label: string | null };
type RegRow = {
  id: string; event_id: string; player_id: string;
  partner_registration_id: string | null; partner_status: string;
  source_system: string | null; source_activity_id: string | null; source_team_id: string | null;
};

function eventInsertFromMeta(
  tournamentId: string,
  label: string,
  meta: DivisionMeta,
  warnings: string[],
): Record<string, unknown> {
  const format = meta.format ?? "doubles";
  const gender = meta.gender ?? "mixed";
  if (!meta.format) warnings.push(`Division "${label}": singles/doubles not detected — defaulted to doubles.`);
  if (!meta.gender) warnings.push(`Division "${label}": gender not detected — defaulted to mixed.`);
  const row: Record<string, unknown> = {
    tournament_id: tournamentId,
    name: label,
    format,
    gender,
    bracket_type: "round_robin", // the DRAW is generated later by B&E (separate)
    event_fee_cents: 0,
    source_system: SOURCE,
    source_division_label: label,
    source_division_meta: meta,
  };
  if (meta.bracketType === "skill") {
    if (meta.low !== null) row.min_rating = meta.low;
    if (meta.high !== null) row.max_rating = meta.high;
  } else if (meta.bracketType === "age") {
    if (meta.low !== null) row.min_age = Math.round(meta.low);
    if (meta.high !== null) row.max_age = Math.round(meta.high);
  }
  return row;
}

// Minimal fallback parser if the client didn't attach parsed meta.
function parseDivisionFallback(label: string): DivisionMeta {
  const l = label.toLowerCase();
  const gender = /\bmixed\b/.test(l) ? "mixed" : /\bwomen'?s?\b/.test(l) ? "women" : /\bmen'?s?\b/.test(l) ? "men" : null;
  const format = /\bdoubles?\b/.test(l) ? "doubles" : /\bsingles?\b/.test(l) ? "singles" : null;
  const bracketType = /\bskill\b/.test(l) ? "skill" : /\bage\b/.test(l) ? "age" : null;
  const m = l.match(/([\d.]+)\s*(?:to|-|–|—)\s*([\d.]+)/);
  return {
    raw: label, gender, format, bracketType,
    low: m ? Number(m[1]) : null, high: m ? Number(m[2]) : null,
  };
}

// A "(WAIT) " prefix marks waitlisted registrants in the SAME PB division, so
// strip it before keying — otherwise a waitlist splits into its own B&E division.
function stripWaitlist(label: string): string {
  return label.trim().replace(/^\(WAIT\)\s*/i, "");
}
function divKey(label: string): string {
  return stripWaitlist(label).toLowerCase().replace(/\s+/g, " ");
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}
function normEmail(v: unknown): string | null {
  const s = str(v).toLowerCase();
  return s && s.includes("@") ? s : null;
}
function nameKey(first: string, last: string): string {
  return `${first} ${last}`.trim().toLowerCase().replace(/\s+/g, " ");
}
function playerKey(email: string | null, first: string, last: string): string {
  if (email) return `email:${email}`;
  const n = nameKey(first, last);
  return n ? `name:${n}` : "";
}
function normGender(v: unknown): "M" | "F" | "X" | null {
  const s = str(v).toLowerCase();
  if (!s) return null;
  if (s === "m" || s.startsWith("male") || s === "man" || s === "men") return "M";
  if (s === "f" || s.startsWith("female") || s === "woman" || s === "women") return "F";
  if (s === "x" || s.startsWith("non") || s.startsWith("other")) return "X";
  return null;
}
function parseDupr(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n >= 10) return null;
  return Math.round(n * 100) / 100;
}
function normDuprId(v: unknown): string | null {
  const s = str(v);
  return s ? s : null;
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
