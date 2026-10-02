import { divisionKey } from "./pbDivision";

// ─────────────────────────────────────────────────────────────────────────
// PickleballBrackets.com → Bert & Erne — DOUBLES PARTNER LINKAGE (D-0045 / #984
// follow-up).
//
// THE GAP THIS CLOSES. The registration import (web/src/lib/pbImport.ts +
// supabase/functions/import-pb-registrations) ingests PB.com's "Export Player w/
// Events (Flat File)". That flat file does NOT carry doubles partnerships — every
// Team* column comes back blank — so `buildPlan().pairs` is always empty on real
// data and doubles registrations land as `partner_status='seeking'`, unpaired.
//
// The partnership IS visible on PB.com's authenticated **Attendees page**
// (`raS.aspx`, director view): every doubles registration line names the partner,
// with the partner's FULL unmasked phone. This module scrapes THAT (via a typed
// seam the pbcom-driver fills), parses the partner out, and links the two B&E
// `event_registrations` by NORMALIZED phone.
//
// PLACEMENT (documented choice). This lives in `web/src/lib/` beside pbImport.ts /
// pbReconcile.ts — the established home for the PB.com import's PURE, unit-tested
// parse/plan layer ("the canonical spec; the edge function reproduces it at write
// time", see pbReconcile.ts). Everything here is pure and dependency-free:
//   • the PARSER + LINKER import cleanly into the Deno edge function, the Node
//     pbcom-driver, or the SPA;
//   • `applyPartnerLinks` writes through an injected PORT (PartnerLinkStore) so it
//     is testable with an in-memory store and wired to Supabase service-role at the
//     call site (edge function / driver);
//   • the live fetch is a TRACE SEAM typed against a structural browser interface,
//     so NO Playwright dependency leaks into web/. The pbcom-driver's PbcomSession
//     (PR #986) is the intended implementor.
// The alternative home, pbcom-driver/, is not yet on `main` (open PR #986) and the
// write side belongs to the import's DB model, so web/src/lib is the fitting home.
//
// WHY PHONE, NOT NAME. The import stores each player's FULL phone (export `Phone`)
// and their `source_attendee_header_id`. Phones are unique per player in this data,
// and the Attendees page shows partner phones FULL/unmasked, so a
// last-10-digits phone match is the strong join. Name is a low-confidence fallback
// only. Anything that doesn't match is recorded `unlinked` with a reason — never
// guessed.
// ─────────────────────────────────────────────────────────────────────────

// ── Parsed shapes ──────────────────────────────────────────────────────────

export type PbName = { last: string; first: string };

/** One registration entry scraped from an attendee's raS.aspx block. */
export type AttendeeEntry = {
  /** The attendee (registration owner) this entry belongs to. */
  ownerName: PbName;
  /** The owner's OWN phone from the block header — full, unmasked ("+1 …"). */
  ownerPhone: string;
  /** The exact PB.com division string (its identity; == events.source_division_label). */
  divisionLabel: string;
  /** From the division label: doubles entries can carry a partner; singles cannot. */
  format: "singles" | "doubles";
  /** The partner named on a doubles line. null for singles OR a partner-needed doubles entry. */
  partnerName: PbName | null;
  /** The partner's phone as scraped ("+1 …", or a malformed/foreign one). null when absent. */
  partnerPhone: string | null;
  /** True when the partner segment was flagged "Waiting List" / "WL". */
  partnerWaitlisted: boolean;
};

/** A raw attendee block as the fetch seam yields it (one attendee's rendered text). */
export type RawAttendeeBlock = { text: string };

// ── Phone normalization (the join key) ───────────────────────────────────
// Normalized phone = the LAST 10 digits after stripping every non-digit. This
// collapses "+1 5085551234", "1 (508) 555-1234" and "508 555 1234" to the same
// key, while a wrong country code or an 11-digit garble (e.g. "+1 50826948222",
// "+93 6039312769") normalizes to a 10-digit string that simply won't match a real
// player — which is exactly the "record as unlinked, don't guess" behaviour we want.
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

// ── Text extraction ─────────────────────────────────────────────────────
// The seam may hand us either the page HTML or already-extracted visible text.
// Strip tags to text so the block/entry grammar below is the single source of
// truth. Kept deliberately small — we parse the RENDERED text, never the DOM.
function toText(input: string): string {
  let s = input;
  if (s.includes("<")) {
    s = s
      .replace(/<\s*(br|BR)\s*\/?>/g, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)));
  }
  // The raS.aspx header separates fields with bullet glyphs; normalize any bullet
  // separator to whitespace so the grammar below sees uniform token boundaries.
  return s.replace(/[·•‧∙|]/g, " ");
}

// ── Block splitting ───────────────────────────────────────────────────────
// An attendee block STARTS at its header, whose signature is a real name followed
// by "Age: <n> Gender: <M|F>". A partner's "Last, First" never has "Age:" after it,
// and rating lines have no name — so this anchor cleanly delimits attendees even
// with the "Total: 1 to 50 of N" pagination line and rating lines interleaved.
const HEADER_ANCHOR =
  /([A-Za-z][\w'.-]*),\s*([A-Za-z][\w'. -]*?)\s+Age:\s*\d+\s+Gender:\s*[MFXmfx]/g;

export function splitAttendeeBlocks(pageText: string): string[] {
  const text = toText(pageText);
  const starts: number[] = [];
  HEADER_ANCHOR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADER_ANCHOR.exec(text)) !== null) starts.push(m.index);
  if (starts.length === 0) return [];
  const blocks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : text.length;
    blocks.push(text.slice(from, to));
  }
  return blocks;
}

// ── Per-block parsing ─────────────────────────────────────────────────────
// A registration entry is anchored by `Self <skill> … EVT: <date>` (optionally
// `WL: <date>`). NOTE: `Self <skill>` (Self + a DIGIT) marks an entry, whereas the
// rating line reads `Self D: … S: … SS:` (Self + a LETTER) — so the digit lookahead
// never mistakes a rating line for a registration. A doubles line embeds a SECOND
// `Self <partnerSkill> <Last>, <First> [Waiting List] +<cc> <phone> <maskedEmail>`
// BEFORE its `EVT:`; because the entry regex is anchored on the terminator, that
// inner `Self` is captured as part of the entry, not treated as a new one.
const ENTRY_RE =
  /Self\s+(\d+(?:\.\d+)?)\s+([\s\S]*?)\s+EVT:\s*\S+(?:\s+WL:\s*\S+)?/g;

// Split a doubles entry's middle into the division label and the partner segment.
// The partner segment begins at the SECOND `Self <digit>`.
const PARTNER_SPLIT_RE = /^([\s\S]*?)\s+Self\s+\d+(?:\.\d+)?\s+([\s\S]*)$/;

// A phone anywhere in the partner segment: "+<cc> <digits>" (cc 1-3 digits).
const PHONE_RE = /\+(\d{1,3})[\s.-]*([\d][\d\s.-]{6,}\d)/;

function parseName(raw: string): PbName {
  const s = raw.trim();
  const i = s.indexOf(",");
  if (i < 0) return { last: s, first: "" };
  return { last: s.slice(0, i).trim(), first: s.slice(i + 1).trim() };
}

function labelFormat(label: string): "singles" | "doubles" {
  const l = label.toLowerCase();
  if (/\bsingles?\b/.test(l)) return "singles";
  // Doubles + mixed are doubles; default doubles (mirrors the import's default).
  return "doubles";
}

/**
 * Parse one attendee block into its registration entries.
 * Exposed for tests; `parseAttendeesPartners` maps it over every block.
 */
export function parseAttendeeBlock(block: string): AttendeeEntry[] {
  const text = toText(block);

  // Header: owner name + own phone (the FIRST phone before the first entry).
  const headerMatch =
    /([A-Za-z][\w'.-]*),\s*([A-Za-z][\w'. -]*?)\s+Age:\s*\d+\s+Gender:\s*[MFXmfx]/.exec(
      text,
    );
  const ownerName: PbName = headerMatch
    ? { last: headerMatch[1]!.trim(), first: headerMatch[2]!.trim() }
    : { last: "", first: "" };

  const firstEntryIdx = text.search(/Self\s+\d/);
  const headerRegion = firstEntryIdx >= 0 ? text.slice(0, firstEntryIdx) : text;
  const ownerPhoneMatch = PHONE_RE.exec(headerRegion);
  const ownerPhone = ownerPhoneMatch
    ? `+${ownerPhoneMatch[1]} ${ownerPhoneMatch[2]!.replace(/\D/g, "")}`
    : "";

  const entries: AttendeeEntry[] = [];
  ENTRY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTRY_RE.exec(text)) !== null) {
    const middle = m[2]!.trim();
    const split = PARTNER_SPLIT_RE.exec(middle);

    let divisionLabel: string;
    let partnerSegment: string | null;
    if (split) {
      divisionLabel = split[1]!.trim();
      partnerSegment = split[2]!.trim();
    } else {
      divisionLabel = middle;
      partnerSegment = null;
    }

    const format = labelFormat(divisionLabel);

    let partnerName: PbName | null = null;
    let partnerPhone: string | null = null;
    let partnerWaitlisted = false;

    if (partnerSegment) {
      const phone = PHONE_RE.exec(partnerSegment);
      if (phone) partnerPhone = `+${phone[1]} ${phone[2]!.replace(/\D/g, "")}`;

      // Name is whatever precedes "Waiting List"/"WL" or the phone.
      let namePart = phone ? partnerSegment.slice(0, phone.index) : partnerSegment;
      const wl = /\bwaiting\s+list\b|\bWL\b/i.exec(namePart);
      if (wl) {
        partnerWaitlisted = true;
        namePart = namePart.slice(0, wl.index);
      } else if (/\bwaiting\s+list\b|\bWL\b/i.test(partnerSegment)) {
        partnerWaitlisted = true;
      }
      namePart = namePart.trim();
      if (namePart) partnerName = parseName(namePart);
    }

    entries.push({
      ownerName,
      ownerPhone,
      divisionLabel,
      format,
      partnerName,
      partnerPhone,
      partnerWaitlisted,
    });
  }

  return entries;
}

/**
 * Parse the raS.aspx Attendees page (HTML or extracted text, or an array of raw
 * blocks) into flat registration entries. Each doubles entry carries its partner
 * (name, full phone, waitlist flag); singles entries carry no partner.
 */
export function parseAttendeesPartners(
  input: string | RawAttendeeBlock[],
): AttendeeEntry[] {
  const blocks =
    typeof input === "string"
      ? splitAttendeeBlocks(input)
      : input.map((b) => b.text);
  return blocks.flatMap((b) => parseAttendeeBlock(b));
}

// ── The linker ───────────────────────────────────────────────────────────

/** The minimum a player must expose to be joined. Supplied from the import/DB. */
export type LinkPlayer = {
  /** Full phone as stored on import (export `Phone`); normalized to last-10 here. */
  phone: string | null;
  firstName: string;
  lastName: string;
};

export type PartnerPair = {
  /** divisionKey(divisionLabel) — the normalized division identity. */
  divisionKey: string;
  /** Normalized (last-10) phone of the matched owner player. */
  phoneA: string;
  /** Normalized (last-10) phone of the matched partner player. */
  phoneB: string;
  /** high = both matched by phone; low = partner matched by name fallback. */
  confidence: "high" | "low";
  /** True when the partner segment was flagged waitlisted (informational). */
  waitlisted: boolean;
};

export type UnlinkedEntry = {
  ownerPhone: string;
  divisionLabel: string;
  reason:
    | "owner_not_found"
    | "partner_needed"
    | "partner_no_phone"
    | "partner_phone_unmatched"
    | "partner_name_unmatched"
    | "partner_name_ambiguous"
    | "self_partner";
};

export type PartnerLinkResult = {
  pairs: PartnerPair[];
  unlinked: UnlinkedEntry[];
};

function nameIndexKey(last: string, first: string): string {
  return `${last}|${first}`.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Join scraped partner entries to imported players by NORMALIZED phone (last-10),
 * with a low-confidence (last name + first name) fallback. The Attendees listing is
 * SYMMETRIC — each doubles pair appears from BOTH partners' blocks — so pairs are
 * deduped by (divisionKey, unordered player pair), keeping the highest confidence.
 */
export function buildPartnerLinks(
  entries: AttendeeEntry[],
  players: LinkPlayer[],
): PartnerLinkResult {
  const byPhone = new Map<string, LinkPlayer>();
  const byName = new Map<string, LinkPlayer[]>();
  for (const p of players) {
    const np = normalizePhone(p.phone);
    if (np && !byPhone.has(np)) byPhone.set(np, p);
    const nk = nameIndexKey(p.lastName, p.firstName);
    const list = byName.get(nk) ?? [];
    list.push(p);
    byName.set(nk, list);
  }

  const pairsByKey = new Map<string, PartnerPair>();
  const unlinked: UnlinkedEntry[] = [];

  for (const e of entries) {
    if (e.format !== "doubles") continue; // singles have no partner concept

    const dkey = divisionKey(e.divisionLabel);
    const ownerNorm = normalizePhone(e.ownerPhone);
    const ownerPlayer = ownerNorm ? byPhone.get(ownerNorm) : undefined;
    if (!ownerPlayer || !ownerNorm) {
      unlinked.push({ ownerPhone: e.ownerPhone, divisionLabel: e.divisionLabel, reason: "owner_not_found" });
      continue;
    }

    if (!e.partnerName) {
      unlinked.push({ ownerPhone: e.ownerPhone, divisionLabel: e.divisionLabel, reason: "partner_needed" });
      continue;
    }

    // Phone match first (strong).
    const partnerNorm = normalizePhone(e.partnerPhone);
    let partnerPlayer = partnerNorm ? byPhone.get(partnerNorm) : undefined;
    let confidence: "high" | "low" = "high";

    // Name fallback (weak) only when phone failed.
    if (!partnerPlayer) {
      const cand = byName.get(nameIndexKey(e.partnerName.last, e.partnerName.first)) ?? [];
      if (cand.length === 1) {
        partnerPlayer = cand[0];
        confidence = "low";
      } else if (cand.length > 1) {
        unlinked.push({ ownerPhone: e.ownerPhone, divisionLabel: e.divisionLabel, reason: "partner_name_ambiguous" });
        continue;
      }
    }

    if (!partnerPlayer) {
      unlinked.push({
        ownerPhone: e.ownerPhone,
        divisionLabel: e.divisionLabel,
        reason: partnerNorm ? "partner_phone_unmatched" : e.partnerPhone ? "partner_phone_unmatched" : "partner_no_phone",
      });
      continue;
    }

    const partnerCanon = normalizePhone(partnerPlayer.phone);
    if (!partnerCanon) {
      // Matched a player (by name) who has no usable phone → can't key the pair.
      unlinked.push({ ownerPhone: e.ownerPhone, divisionLabel: e.divisionLabel, reason: "partner_no_phone" });
      continue;
    }
    if (partnerCanon === ownerNorm) {
      unlinked.push({ ownerPhone: e.ownerPhone, divisionLabel: e.divisionLabel, reason: "self_partner" });
      continue;
    }

    const [lo, hi] = [ownerNorm, partnerCanon].sort() as [string, string];
    const key = `${dkey}::${lo}|${hi}`;
    const pair: PartnerPair = {
      divisionKey: dkey,
      phoneA: lo,
      phoneB: hi,
      confidence,
      waitlisted: e.partnerWaitlisted,
    };
    const existing = pairsByKey.get(key);
    if (!existing) {
      pairsByKey.set(key, pair);
    } else if (existing.confidence === "low" && confidence === "high") {
      // The other side of a symmetric listing gave a stronger match — upgrade.
      pairsByKey.set(key, { ...existing, confidence: "high", waitlisted: existing.waitlisted || pair.waitlisted });
    } else {
      existing.waitlisted = existing.waitlisted || pair.waitlisted;
    }
  }

  return { pairs: [...pairsByKey.values()], unlinked };
}

// ── The apply step (idempotent, over an injected port) ─────────────────────

/** One event_registrations row, as the store resolves it. */
export type PartnerReg = {
  id: string;
  partnerRegistrationId: string | null;
  partnerStatus: string;
};

/**
 * The write PORT. The edge function / pbcom-driver supplies a Supabase
 * service-role adapter:
 *   • resolveRegistration(divisionKey, normPhone) → find the event_registration
 *     for the event whose divisionKey(source_division_label) matches, joined to the
 *     player whose normalized phone matches.
 *   • setPartner(regId, partnerRegId) → set partner_registration_id +
 *     partner_status='confirmed' (the same write the TeamID pairing did in #983).
 * Keeping it a port makes applyPartnerLinks pure and unit-testable with an
 * in-memory store, exactly like buildPlan in pbReconcile.ts.
 */
export interface PartnerLinkStore {
  resolveRegistration(divisionKey: string, normPhone: string): Promise<PartnerReg | null>;
  setPartner(registrationId: string, partnerRegistrationId: string): Promise<void>;
}

export type ApplyResult = {
  linked: number;
  unchanged: number;
  skipped: { divisionKey: string; phoneA: string; phoneB: string; reason: string }[];
};

/**
 * Apply confirmed partner pairs to event_registrations — sets
 * partner_registration_id (BOTH directions) + partner_status='confirmed' on the
 * two matching rows. IDEMPOTENT: a pair already linked to each other and confirmed
 * is left untouched (re-run doesn't thrash), mirroring the import's own idempotency.
 */
export async function applyPartnerLinks(
  pairs: PartnerPair[],
  store: PartnerLinkStore,
): Promise<ApplyResult> {
  let linked = 0;
  let unchanged = 0;
  const skipped: ApplyResult["skipped"] = [];

  for (const pair of pairs) {
    const a = await store.resolveRegistration(pair.divisionKey, pair.phoneA);
    const b = await store.resolveRegistration(pair.divisionKey, pair.phoneB);
    if (!a || !b) {
      skipped.push({ divisionKey: pair.divisionKey, phoneA: pair.phoneA, phoneB: pair.phoneB, reason: "registration_not_found" });
      continue;
    }
    if (a.id === b.id) {
      skipped.push({ divisionKey: pair.divisionKey, phoneA: pair.phoneA, phoneB: pair.phoneB, reason: "same_registration" });
      continue;
    }

    const alreadyLinked =
      a.partnerRegistrationId === b.id &&
      b.partnerRegistrationId === a.id &&
      a.partnerStatus === "confirmed" &&
      b.partnerStatus === "confirmed";
    if (alreadyLinked) {
      unchanged++;
      continue;
    }

    await store.setPartner(a.id, b.id);
    await store.setPartner(b.id, a.id);
    linked++;
  }

  return { linked, unchanged, skipped };
}

// ── The live-fetch TRACE SEAM (stub — NOT implemented here) ────────────────

/**
 * The minimal browser capability the seam needs, structural so this module keeps
 * ZERO Playwright dependency. The pbcom-driver's `PbcomSession` (PR #986,
 * pbcom-driver/src/pbcom/session.ts) is the intended implementor; its logged-in
 * `page` drives these from the captured director-session trace.
 */
export interface PbcomBrowserSession {
  /** Navigate to a URL and wait for load. */
  goto(url: string): Promise<void>;
  /** The current page's rendered text (or HTML) — whatever the trace shows is stable. */
  pageText(): Promise<string>;
  /** Click the WebForms "Next" postback. Resolves false when there is no next page. */
  clickNext(): Promise<boolean>;
}

/**
 * ┌─ TRACE SEAM (fetchAttendeesPartnersPages) ────────────────────────────────┐
 * │ Fill from the PB.com director-session trace (D-0045 "trace first"). Do NOT   │
 * │ invent the raS.aspx URL, query params, or the "Next" selector here. Expected │
 * │ shape once the trace is captured:                                            │
 * │   1. session.goto(the raS.aspx Attendees URL for `eid`).                     │
 * │   2. loop: read session.pageText() → push { text } ; parsePaginationTotal()  │
 * │      confirms "Total: X to Y of N" progress; session.clickNext() until it    │
 * │      returns false (all 50-per-page postbacks exhausted).                    │
 * │   3. return the collected raw blocks — the PURE parseAttendeesPartners()     │
 * │      above turns them into AttendeeEntry[]; NO DOM logic lives in the parser. │
 * │ This runs ONLY inside the pbcom-driver's authenticated Playwright session or  │
 * │ an operator session — never from the SPA (no PB.com auth there).             │
 * └─────────────────────────────────────────────────────────────────────────────┘
 */
export async function fetchAttendeesPartnersPages(
  session: PbcomBrowserSession,
  eid: string,
): Promise<RawAttendeeBlock[]> {
  void session;
  void eid;
  throw new Error(
    "fetchAttendeesPartnersPages: TRACE SEAM not filled — capture the PB.com " +
      "raS.aspx Attendees pagination flow (D-0045) and implement against " +
      "PbcomBrowserSession. The pure parser/linker in this module is ready.",
  );
}

/**
 * Parse the "Total: X to Y of N" progress line the Attendees page shows. Pure —
 * used by the seam to know when pagination is complete. Returns null if absent.
 */
export function parsePaginationTotal(
  text: string,
): { from: number; to: number; total: number } | null {
  const m = /Total:\s*(\d+)\s*to\s*(\d+)\s*of\s*(\d+)/i.exec(text);
  if (!m) return null;
  return { from: Number(m[1]), to: Number(m[2]), total: Number(m[3]) };
}
