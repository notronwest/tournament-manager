import * as XLSX from "xlsx";

// Client-side parse of a contacts upload (CSV / XLSX / XLS). SheetJS reads all
// three from an ArrayBuffer, so the raw file never leaves the browser — only
// the mapped rows are posted to the import-contacts edge function.

export type ParsedFile = {
  headers: string[];
  rows: string[][]; // data rows, cells aligned to `headers` by index
};

// The player fields an import can populate. `first_name` is the only one the
// server requires (players.first_name is NOT NULL).
export type ContactField =
  | "first_name"
  | "last_name"
  | "email"
  | "phone"
  | "city"
  | "state";

export const CONTACT_FIELDS: { key: ContactField; label: string; required?: boolean }[] = [
  { key: "first_name", label: "First name", required: true },
  { key: "last_name", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
];

// Header text → field, by common spreadsheet column names.
const HEADER_HINTS: { field: ContactField; patterns: RegExp[] }[] = [
  { field: "first_name", patterns: [/^first/i, /given/i, /^fname$/i] },
  { field: "last_name", patterns: [/^last/i, /surname/i, /family/i, /^lname$/i] },
  { field: "email", patterns: [/e-?mail/i] },
  { field: "phone", patterns: [/phone/i, /mobile/i, /cell/i, /^tel/i] },
  { field: "city", patterns: [/city/i, /town/i] },
  { field: "state", patterns: [/state/i, /province/i, /region/i] },
];

export async function parseContactsFile(file: File): Promise<ParsedFile> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
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
    // drop fully-empty rows
    .filter((r) => r.some((c) => c.trim() !== ""));
  return { headers, rows };
}

// Guess a header-index → field mapping from the header row. Returns a record
// of field → column index (or -1 when nothing matched). First match wins so a
// single column isn't claimed by two fields.
export function autoMap(headers: string[]): Record<ContactField, number> {
  const map: Record<ContactField, number> = {
    first_name: -1,
    last_name: -1,
    email: -1,
    phone: -1,
    city: -1,
    state: -1,
  };
  const taken = new Set<number>();
  for (const { field, patterns } of HEADER_HINTS) {
    const idx = headers.findIndex(
      (h, i) => !taken.has(i) && patterns.some((p) => p.test(h.trim())),
    );
    if (idx >= 0) {
      map[field] = idx;
      taken.add(idx);
    }
  }
  return map;
}

function cell(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}
