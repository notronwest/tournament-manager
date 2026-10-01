// ─────────────────────────────────────────────────────────────────────────
// The PB.com DIVISION KEY — the one pure primitive the import's division identity
// is built on.
//
// Extracted out of pbImport.ts so the PURE partner parser/linker (pbPartners.ts)
// can depend on it WITHOUT pulling in pbImport's heavy transitive deps (xlsx).
// pbImport.ts drags in `xlsx` for the flat-file parse; the Node pbcom-driver
// (which reuses pbPartners for the live attendee-partner scrape) has no xlsx and
// never should — a results-push Playwright driver must not load a spreadsheet lib.
// Keeping divisionKey here lets pbPartners stay genuinely dependency-free (as its
// header promises) and import cleanly into the driver, the edge function, or the SPA.
//
// pbImport.ts RE-EXPORTS divisionKey from here, so every existing
// `import { divisionKey } from "./pbImport"` keeps working unchanged.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Normalize a PB.com division label to its stable identity key: trimmed, lower-cased,
 * internal whitespace collapsed. Two labels that differ only in case/spacing map to
 * the same division (the import proved `events.source_division_label` IS the division
 * identity in PB.com).
 */
export function divisionKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}
