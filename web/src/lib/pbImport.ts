import * as XLSX from "xlsx";

// ─────────────────────────────────────────────────────────────────────────
// PickleballBrackets.com → Bert & Erne registration import — parse layer.
//
// Flow (D-0045 / #970 trace / #981, confirmed against a real export):
// PB.com owns registration AND the initial division/bracket setup. When
// registration closes, B&E imports the players + divisions + partnerships from
// PB.com's "Export Player w/ Events (Flat File)" (the PB.com Attendees page),
// then B&E DRIVES the event. So this import INGESTS PB.com's structure — it does
// not invent brackets — and PRESERVES PB.com's identifiers on the B&E records
// (source_system='pbcom' + ActivityID / TeamID / AttendeeHeaderID / division
// label) so the later results-push (#982) can map cleanly back. The actual
// bracket DRAW (who-plays-whom) is a SEPARATE data source not present in this
// flat file — this module leaves that seam open and does not build it.
//
// The browser parses the file (SheetJS); the raw file never leaves the browser.
//
// FILE SHAPE (verified from the sample — NOT one row per player):
//   Each attendee has:
//     • one HEADER/summary row  — no "Event N" column filled, ServiceFee_Total
//       is the attendee fee. Carries contact + rating info.
//     • one ENTRY row PER DIVISION — exactly one "Event N" column holds the
//       division label, ActivityID is that entry's id, TeamID (when present)
//       groups doubles partners.
//   Rows are grouped by AttendeeHeaderID.
// ─────────────────────────────────────────────────────────────────────────

export type ParsedFile = {
  headers: string[];
  rows: string[][]; // data rows, cells aligned to `headers` by index
};

// ── The pluggable column layer (the one wiring point) ──────────────────────
// Columns are resolved by HEADER NAME, not fixed index, so PB.com reordering
// columns can't break the import. If PB.com RENAMES a column, edit the aliases
// here and nothing else changes. Matching is case/space-insensitive.
export const PB_COLUMNS = {
  lastName: ["LastName", "Last Name"],
  firstName: ["FirstName", "First Name"],
  gender: ["Gender", "Sex"],
  email: ["Email", "E-mail"],
  phoneCallingCode: ["Phone_CallingCode"],
  phoneAreaCode: ["Phone_AreaCode"],
  phone: ["Phone"],
  age: ["Age"],
  teamId: ["TeamID", "Team ID"],
  teamName: ["TeamName", "Team Name"],
  registrationType: ["TeamActivity_RegistrationType"],
  activityId: ["ActivityID", "Activity ID"],
  attendeeHeaderId: ["AttendeeHeaderID", "Attendee Header ID"],
  // The rating that matters (D-0045: DUPR is decisive). The rest are carried in
  // the raw row but not modelled on B&E records yet.
  duprId: ["DUPR_ID", "DUPR Id"],
  ratingDuprDbl: ["Rating_DUPR_DBL"],
  ratingDuprS: ["Rating_DUPR_S"],
  serviceFeeTotal: ["ServiceFee_Total"],
} as const;

// PB.com lays division entries across up to N "Event N" columns; the filled one
// per row is that row's division. Detected dynamically (any header /^Event \d+$/).
const EVENT_COL_RE = /^event\s*\d+$/i;

// ── Parsing ────────────────────────────────────────────────────────────────

// Core parse from bytes (used by tests). SheetJS reads CSV/XLSX/XLS alike.
export function parsePbBuffer(data: ArrayBuffer | Uint8Array): ParsedFile {
  const wb = XLSX.read(data, { type: "array" });
  const firstSheet = wb.SheetNames[0];
  if (!firstSheet) return { headers: [], rows: [] };
  const sheet = wb.Sheets[firstSheet];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: "",
  });
  if (aoa.length === 0) return { headers: [], rows: [] };
  const headers = (aoa[0] as unknown[]).map((h) => cell(h));
  const rows = aoa
    .slice(1)
    .map((r) => (r as unknown[]).map((c) => cell(c)))
    .filter((r) => r.some((c) => c.trim() !== ""));
  return { headers, rows };
}

export async function parsePbFile(file: File): Promise<ParsedFile> {
  const buf = await file.arrayBuffer();
  return parsePbBuffer(new Uint8Array(buf));
}

// Header name → column index resolver. Returns -1 for a missing column.
export type ColumnIndex = Record<keyof typeof PB_COLUMNS, number> & {
  eventCols: number[];
};

function norm(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "");
}

export function resolveColumns(headers: string[]): ColumnIndex {
  const normed = headers.map(norm);
  const find = (aliases: readonly string[]): number => {
    for (const a of aliases) {
      const i = normed.indexOf(norm(a));
      if (i >= 0) return i;
    }
    return -1;
  };
  const out = {} as ColumnIndex;
  for (const key of Object.keys(PB_COLUMNS) as (keyof typeof PB_COLUMNS)[]) {
    out[key] = find(PB_COLUMNS[key]);
  }
  out.eventCols = headers
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => EVENT_COL_RE.test(h.trim()))
    .map(({ i }) => i);
  return out;
}

// Headers that no known column claimed — surfaced as "X unmapped columns" so the
// operator can see what B&E ignored (most rating systems fall here by design).
export function unmappedColumns(headers: string[], cols: ColumnIndex): string[] {
  const claimed = new Set<number>([
    ...Object.entries(cols)
      .filter(([k]) => k !== "eventCols")
      .map(([, v]) => v as number)
      .filter((i) => i >= 0),
    ...cols.eventCols,
  ]);
  return headers
    .map((h, i) => ({ h, i }))
    .filter(({ i }) => !claimed.has(i))
    .map(({ h, i }) => h || `Column ${i + 1}`);
}

// ── Division-label parser ────────────────────────────────────────────────
// "Mens Doubles Skill: (3.0 To 3.49)" → {gender:'men', format:'doubles',
//  bracketType:'skill', low:3.0, high:3.49}. Also Womens/Mixed, Singles, Age.
export type DivisionMeta = {
  raw: string;
  gender: "men" | "women" | "mixed" | null;
  format: "doubles" | "singles" | null;
  bracketType: "skill" | "age" | null;
  low: number | null;
  high: number | null;
};

export function parseDivisionLabel(raw: string): DivisionMeta {
  const s = (raw ?? "").trim();
  const lower = s.toLowerCase();
  // Order matters: "women" and "mixed" before "men" ("women" contains "men").
  const gender = /\bmixed\b/.test(lower)
    ? "mixed"
    : /\bwomen'?s?\b/.test(lower)
      ? "women"
      : /\bmen'?s?\b/.test(lower)
        ? "men"
        : null;
  const format = /\bdoubles?\b/.test(lower)
    ? "doubles"
    : /\bsingles?\b/.test(lower)
      ? "singles"
      : null;
  const bracketType = /\bskill\b/.test(lower)
    ? "skill"
    : /\bage\b/.test(lower)
      ? "age"
      : null;
  let low: number | null = null;
  let high: number | null = null;
  const range = lower.match(/([\d.]+)\s*(?:to|-|–|—)\s*([\d.]+)/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (Number.isFinite(a)) low = a;
    if (Number.isFinite(b)) high = b;
  }
  return { raw: s, gender, format, bracketType, low, high };
}

// A stable key for a division = its label (deduped case/space-insensitively).
// The "Event N" column index is only the tournament ordinal, so the LABEL is the
// identity (D-0045 correction). The implementation now lives in ./pbDivision (a
// dependency-free module) so the pure partner linker can reuse it without pulling
// in this file's xlsx dependency; re-exported here so existing importers are unchanged.
export { divisionKey } from "./pbDivision";

// A PB.com registration is WAITLISTED when its division label is prefixed
// "(WAIT) …" on the attendee export. Waitlisted entries are NOT imported into
// B&E (Ron, 2026-10-01: "don't bring over players who are on the waitlist"); a
// division that exists ONLY as waitlist entries therefore has nobody signed up
// and is not created.
export function isWaitlisted(label: string): boolean {
  return /^\(WAIT\)\s*/i.test((label ?? "").trim());
}

// ── Attendee grouping ────────────────────────────────────────────────────
export type PbEntry = {
  activityId: string; // per-entry PB id (idempotency key)
  teamId: string; // partner-grouping id (may be blank → solo)
  divisionLabel: string;
  division: DivisionMeta;
  eventColumnIndex: number; // 1-based ordinal within the tournament (informational)
};

export type PbAttendee = {
  attendeeHeaderId: string;
  lastName: string;
  firstName: string;
  gender: string; // raw
  email: string;
  phone: string; // best-effort composed
  age: string;
  duprId: string;
  ratingDuprDbl: string;
  ratingDuprS: string;
  serviceFeeTotal: string;
  entries: PbEntry[];
};

export type ParsedAttendees = {
  attendees: PbAttendee[];
  // rows with no AttendeeHeaderID / no usable identity — counted, not imported
  skippedRows: number;
  // "(WAIT) …" registrations dropped — waitlisted players are not brought over
  waitlistSkipped: number;
};

// Group the flat rows into attendees + their division entries.
export function parseAttendees(parsed: ParsedFile): ParsedAttendees {
  const cols = resolveColumns(parsed.headers);
  const at = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const byAttendee = new Map<string, PbAttendee>();
  let skippedRows = 0;
  let waitlistSkipped = 0;

  for (const r of parsed.rows) {
    const headerId = at(r, cols.attendeeHeaderId);
    const first = at(r, cols.firstName);
    const last = at(r, cols.lastName);
    // Need at least an attendee id (grouping) or a name to be usable.
    if (!headerId && !first && !last) {
      skippedRows++;
      continue;
    }
    const groupKey = headerId || `name:${last}|${first}`;

    let a = byAttendee.get(groupKey);
    if (!a) {
      a = {
        attendeeHeaderId: headerId,
        lastName: last,
        firstName: first,
        gender: at(r, cols.gender),
        email: at(r, cols.email),
        phone: composePhone(
          at(r, cols.phoneCallingCode),
          at(r, cols.phoneAreaCode),
          at(r, cols.phone),
        ),
        age: at(r, cols.age),
        duprId: at(r, cols.duprId),
        ratingDuprDbl: at(r, cols.ratingDuprDbl),
        ratingDuprS: at(r, cols.ratingDuprS),
        serviceFeeTotal: at(r, cols.serviceFeeTotal),
        entries: [],
      };
      byAttendee.set(groupKey, a);
    } else {
      // Fill any field a later row supplies that the header row didn't.
      a.email ||= at(r, cols.email);
      a.gender ||= at(r, cols.gender);
      a.duprId ||= at(r, cols.duprId);
      a.phone ||= composePhone(
        at(r, cols.phoneCallingCode),
        at(r, cols.phoneAreaCode),
        at(r, cols.phone),
      );
    }

    // Which "Event N" column (if any) is filled → this is an entry row.
    let divisionLabel = "";
    let eventColumnIndex = -1;
    for (const ci of cols.eventCols) {
      const v = (r[ci] ?? "").trim();
      if (v) {
        divisionLabel = v;
        // ordinal from the header text "Event N"
        const m = parsed.headers[ci]?.match(/\d+/);
        eventColumnIndex = m ? Number(m[0]) : ci;
        break;
      }
    }
    if (divisionLabel && isWaitlisted(divisionLabel)) {
      // Waitlisted registration — not imported. The division it names is created
      // only if someone is actually signed up (a non-waitlist entry) for it.
      waitlistSkipped++;
    } else if (divisionLabel) {
      a.entries.push({
        activityId: at(r, cols.activityId),
        teamId: at(r, cols.teamId),
        divisionLabel,
        division: parseDivisionLabel(divisionLabel),
        eventColumnIndex,
      });
    }
  }

  // Attendees left with no active entries (e.g. waitlist-only) are not brought
  // over — they carry no registration into B&E.
  const attendees = [...byAttendee.values()].filter((a) => a.entries.length > 0);
  return { attendees, skippedRows, waitlistSkipped };
}

// PB.com's ServiceFee_Total is a free-text dollar string (e.g. "65.00", "$65",
// blank). Parsed separately from parseAttendees so the import preview can
// surface "fees paid on PB.com" (#1127 AC) without writing it into B&E's own
// payment records — PB.com, not B&E, was merchant of record for that money.
export function parseFeeCents(raw: string): number {
  const n = Number(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

// PB splits phone into calling/area/number; compose a single readable string.
function composePhone(calling: string, area: string, number: string): string {
  const parts = [calling, area, number].map((p) => p.trim()).filter(Boolean);
  return parts.join(" ").trim();
}

function cell(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}
