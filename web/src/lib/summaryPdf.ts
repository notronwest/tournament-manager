import type { PDFDocument, PDFFont, PDFPage, RGB } from "pdf-lib";
import {
  fmtDateRange,
  fmtDay,
  fmtMinutes,
  type EventResult,
  type Highlight,
  type Podium,
  type ReportHeader,
  type TournamentSummary,
} from "./tournamentSummary";
import {
  ink,
  inkSoft,
  inkMuted,
  bg,
  cream,
  creamDeep,
  rule,
  ruleSoft,
  courtRed,
  courtGreen,
  warnBg,
  warnFg,
  dangerBg,
  dangerFg,
} from "./publicTheme";

// The end-of-tournament summary as a real PDF — the same content the
// on-screen TournamentSummaryReport shows (masthead, note, tiles,
// podiums, highlights, day-by-day), laid out with pdf-lib so the file can
// be attached to an email without going through the browser's print
// dialog. Text-based (selectable), US Letter, half-inch margins, cards
// that never split across a page break, "Page n of N" footers.
//
// pdf-lib is imported dynamically so it stays out of the main bundle —
// only the summary page ever pays for it.

// ── Page geometry (points; 72/in) ────────────────────────────────────
const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const MARGIN = 36; // 0.5in
const CONTENT_W = PAGE_W - MARGIN * 2; // 540
const FOOTER_H = 18; // strip above the bottom margin for "Page n of N"
const CONTENT_BOTTOM = MARGIN + FOOTER_H;
const TOP = PAGE_H - MARGIN;

type Fonts = { regular: PDFFont; bold: PDFFont };

type Colors = {
  ink: RGB;
  inkSoft: RGB;
  inkMuted: RGB;
  bg: RGB;
  cream: RGB;
  creamDeep: RGB;
  rule: RGB;
  ruleSoft: RGB;
  courtRed: RGB;
  courtGreen: RGB;
  warnBg: RGB;
  warnFg: RGB;
  dangerBg: RGB;
  dangerFg: RGB;
  white: RGB;
};

export async function renderSummaryPdf(input: {
  header: ReportHeader;
  summary: TournamentSummary;
  note: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  const lib = await import("pdf-lib");
  const { header, summary, note } = input;

  const doc = await lib.PDFDocument.create();
  doc.setTitle(`${header.tournamentName} — Tournament summary`);
  doc.setAuthor(header.orgName);
  doc.setSubject("End-of-tournament summary report");
  doc.setCreator("Bert & Erne");
  doc.setProducer("Bert & Erne · pdf-lib");
  doc.setCreationDate(new Date());
  doc.setModificationDate(new Date());

  const fonts: Fonts = {
    regular: await doc.embedFont(lib.StandardFonts.Helvetica),
    bold: await doc.embedFont(lib.StandardFonts.HelveticaBold),
  };
  const hex = (h: string): RGB => {
    const n = parseInt(h.replace("#", ""), 16);
    return lib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };
  const colors: Colors = {
    ink: hex(ink),
    inkSoft: hex(inkSoft),
    inkMuted: hex(inkMuted),
    bg: hex(bg),
    cream: hex(cream),
    creamDeep: hex(creamDeep),
    rule: hex(rule),
    ruleSoft: hex(ruleSoft),
    courtRed: hex(courtRed),
    courtGreen: hex(courtGreen),
    warnBg: hex(warnBg),
    warnFg: hex(warnFg),
    dangerBg: hex(dangerBg),
    dangerFg: hex(dangerFg),
    white: lib.rgb(1, 1, 1),
  };

  const sheet = new Sheet(doc, fonts, colors);

  drawMasthead(sheet, header);
  if (note.trim()) drawNote(sheet, note.trim());
  drawTiles(sheet, summary);
  drawBrackets(sheet, summary.events);
  if (summary.highlights.length > 0) drawHighlights(sheet, summary.highlights);
  if (summary.days.length > 0) drawDays(sheet, summary);
  drawClosing(sheet, header, summary);
  drawPageFooters(sheet, header);

  // Copy onto a plain ArrayBuffer so callers can hand the bytes straight
  // to `new Blob([...])` under TS's stricter typed-array generics.
  const saved = await doc.save();
  const out = new Uint8Array(saved.byteLength);
  out.set(saved);
  return out;
}

// "nh-baners-2026-09-15-summary.pdf" — kebab tournament name + the
// tournament's start date (local calendar day, matching the masthead).
export function summaryPdfFilename(header: ReportHeader): string {
  const slug = slugify(header.tournamentName) || "tournament";
  const d = new Date(header.startsAt);
  const date = Number.isNaN(d.getTime())
    ? ""
    : `-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${slug}${date}-summary.pdf`;
}

// Browser-safe base64 (for an email attachment payload). Chunked so a
// multi-megabyte PDF never hits the argument-count limit that a single
// `String.fromCharCode(...bytes)` would.
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// ── Text encoding ────────────────────────────────────────────────────
// The standard 14 fonts only speak WinAnsi. Anything else (emoji in a
// team name, the narrow no-break space Intl puts before "AM") would make
// pdf-lib throw, so every string passes through here first: keep what
// WinAnsi has, decompose accented / compatibility characters to a
// printable base, and drop the rest.

const WINANSI_EXTRA = new Set(
  "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".split("").map((c) => c.codePointAt(0) as number),
);

function encodable(cp: number): boolean {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WINANSI_EXTRA.has(cp);
}

function clean(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x0a) {
      out += "\n";
      continue;
    }
    if (cp === 0x09 || cp === 0x0d) {
      out += " ";
      continue;
    }
    if (encodable(cp)) {
      out += ch;
      continue;
    }
    if (cp === 0x2192 || cp === 0x27a1) {
      out += "-"; // → (never used by our own copy, but a team name might)
      continue;
    }
    for (const part of ch.normalize("NFKD")) {
      const pc = part.codePointAt(0) as number;
      if (encodable(pc)) out += part;
    }
  }
  return out;
}

// Greedy word wrap; a single word wider than the column is broken by
// character so a long unbroken team name can't run off the page.
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  const width = (s: string) => font.widthOfTextAtSize(s, size);
  for (const para of clean(text).split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (width(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      if (width(w) <= maxWidth) {
        line = w;
        continue;
      }
      let chunk = "";
      for (const ch of w) {
        if (chunk === "" || width(chunk + ch) <= maxWidth) chunk += ch;
        else {
          out.push(chunk);
          chunk = ch;
        }
      }
      line = chunk;
    }
    out.push(line);
  }
  return out;
}

// Cut a single line down to fit, with an ellipsis.
function truncate(text: string, font: PDFFont, size: number, maxWidth: number): string {
  let s = clean(text);
  if (font.widthOfTextAtSize(s, size) <= maxWidth) return s;
  while (s.length > 1 && font.widthOfTextAtSize(`${s}…`, size) > maxWidth) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

// ── Type scale (mirrors the on-screen sheet, in points) ──────────────
const EYEBROW = { size: 8, lh: 12, tracking: 1.1 };
const LABEL = { size: 7, lh: 10, tracking: 0.7 }; // tile / highlight / th
const TITLE = { size: 24, lh: 27 };
const H2 = { size: 12.5, lh: 16, tracking: 0.6 };
const BODY = { size: 10.5, lh: 15 };
const SMALL = { size: 9, lh: 12 };
const FINE = { size: 8, lh: 11 };

// ── Sheet: pages, cursor, primitives ─────────────────────────────────

class Sheet {
  readonly doc: PDFDocument;
  readonly fonts: Fonts;
  readonly c: Colors;
  readonly pages: PDFPage[] = [];
  page!: PDFPage;
  // PDF y-coordinate of the top of the next block (decreases as we go).
  y = TOP;

  constructor(doc: PDFDocument, fonts: Fonts, c: Colors) {
    this.doc = doc;
    this.fonts = fonts;
    this.c = c;
    this.newPage();
  }

  newPage(): void {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = TOP;
  }

  get remaining(): number {
    return this.y - CONTENT_BOTTOM;
  }

  get atTop(): boolean {
    return this.y >= TOP;
  }

  // Start a new page unless `h` fits (a block taller than a whole page
  // is drawn anyway — callers that can flow line-by-line do so instead).
  ensure(h: number): void {
    if (h > this.remaining && !this.atTop) this.newPage();
  }

  space(h: number): void {
    this.y -= h;
  }

  // Baseline for a line of `size` type centred in a `lh`-tall line box
  // whose top edge is `top`.
  static baseline(top: number, size: number, lh: number): number {
    return top - lh / 2 - size * 0.3;
  }

  text(
    s: string,
    x: number,
    baseline: number,
    size: number,
    font: PDFFont,
    color: RGB,
    align: "left" | "right" = "left",
  ): void {
    const str = clean(s);
    if (!str) return;
    const dx = align === "right" ? font.widthOfTextAtSize(str, size) : 0;
    this.page.drawText(str, { x: x - dx, y: baseline, size, font, color });
  }

  // Letter-spaced uppercase label (pdf-lib has no character spacing, so
  // glyphs are placed one at a time). Used only for the small caps
  // labels so body copy stays a single selectable run.
  tracked(s: string, x: number, baseline: number, size: number, font: PDFFont, color: RGB, tracking: number): void {
    let cx = x;
    for (const ch of clean(s).toUpperCase()) {
      this.page.drawText(ch, { x: cx, y: baseline, size, font, color });
      cx += font.widthOfTextAtSize(ch, size) + tracking;
    }
  }

  trackedWidth(s: string, size: number, font: PDFFont, tracking: number): number {
    const str = clean(s).toUpperCase();
    return font.widthOfTextAtSize(str, size) + tracking * Math.max(0, str.length - 1);
  }

  // Draw pre-wrapped lines from `top`; returns the height used.
  lines(lines: string[], x: number, top: number, size: number, lh: number, font: PDFFont, color: RGB): number {
    let t = top;
    for (const line of lines) {
      this.text(line, x, Sheet.baseline(t, size, lh), size, font, color);
      t -= lh;
    }
    return lines.length * lh;
  }

  // Draw wrapped lines at the cursor, breaking pages between lines.
  flow(lines: string[], x: number, size: number, lh: number, font: PDFFont, color: RGB): void {
    for (const line of lines) {
      this.ensure(lh);
      this.text(line, x, Sheet.baseline(this.y, size, lh), size, font, color);
      this.y -= lh;
    }
  }

  hr(top: number, thickness: number, color: RGB, x = MARGIN, w = CONTENT_W): void {
    this.page.drawLine({
      start: { x, y: top - thickness / 2 },
      end: { x: x + w, y: top - thickness / 2 },
      thickness,
      color,
    });
  }

  // Rounded card: `top` is the top edge; fill may be omitted for a
  // border-only box.
  card(x: number, top: number, w: number, h: number, r: number, fill: RGB | undefined, border: RGB, borderWidth = 0.75): void {
    this.page.drawSvgPath(roundedRectPath(w, h, r), {
      x,
      y: top,
      color: fill,
      borderColor: border,
      borderWidth,
    });
  }

  // Small uppercase pill (medal badge, "not final" marker). Returns width.
  pill(label: string, x: number, top: number, minW: number, fill: RGB, fg: RGB, border: RGB): number {
    const size = LABEL.size;
    const tw = this.trackedWidth(label, size, this.fonts.bold, LABEL.tracking);
    const w = Math.max(minW, tw + 12);
    const h = 13;
    this.card(x, top, w, h, 2.5, fill, border, 0.6);
    this.tracked(label, x + (w - tw) / 2, top - h + 3.6, size, this.fonts.bold, fg, LABEL.tracking);
    return w;
  }
}

function roundedRectPath(w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return (
    `M ${rr} 0 H ${w - rr} A ${rr} ${rr} 0 0 1 ${w} ${rr} V ${h - rr} ` +
    `A ${rr} ${rr} 0 0 1 ${w - rr} ${h} H ${rr} A ${rr} ${rr} 0 0 1 0 ${h - rr} ` +
    `V ${rr} A ${rr} ${rr} 0 0 1 ${rr} 0 Z`
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// A block that has been measured but not yet drawn — lets rows of cards
// be sized (tallest wins) and page-broken as a unit before any ink hits
// the page.
type Block = { height: number; draw: (top: number) => void };

// Section heading; keeps the heading with its first block.
function sectionTitle(s: Sheet, title: string, firstBlockHeight: number): void {
  const gapAfter = 8;
  s.ensure(H2.lh + gapAfter + firstBlockHeight);
  s.tracked(title, MARGIN, Sheet.baseline(s.y, H2.size, H2.lh), H2.size, s.fonts.bold, s.c.ink, H2.tracking);
  s.y -= H2.lh + gapAfter;
}

// ── Masthead ─────────────────────────────────────────────────────────

function drawMasthead(s: Sheet, header: ReportHeader): void {
  const { regular, bold } = s.fonts;
  s.tracked("Tournament summary", MARGIN, Sheet.baseline(s.y, EYEBROW.size, EYEBROW.lh), EYEBROW.size, bold, s.c.courtGreen, EYEBROW.tracking);
  s.y -= EYEBROW.lh + 2;

  s.flow(wrap(header.tournamentName, bold, TITLE.size, CONTENT_W), MARGIN, TITLE.size, TITLE.lh, bold, s.c.ink);
  s.y -= 4;

  const when = fmtDateRange(header.startsAt, header.endsAt) + (header.venueName ? ` · ${header.venueName}` : "");
  s.flow(wrap(when, regular, 11, CONTENT_W), MARGIN, 11, 15, regular, s.c.inkSoft);
  if (header.venueAddress) {
    s.flow(wrap(header.venueAddress, regular, 10, CONTENT_W), MARGIN, 10, 13, regular, s.c.inkMuted);
  }
  s.y -= 4;
  s.flow(wrap(`Prepared by ${header.orgName}`, regular, SMALL.size, CONTENT_W), MARGIN, SMALL.size, SMALL.lh, regular, s.c.inkMuted);

  s.y -= 8;
  s.hr(s.y, 2.25, s.c.ink);
  s.y -= 2.25 + 16;
}

// ── Note from the tournament director ────────────────────────────────

function drawNote(s: Sheet, note: string): void {
  const { regular, bold } = s.fonts;
  const padX = 11;
  const padY = 10;
  const innerW = CONTENT_W - padX * 2;
  const lines = wrap(note, regular, BODY.size, innerW);
  const textH = lines.length * BODY.lh;
  const boxH = padY + EYEBROW.lh + 3 + textH + padY;

  if (boxH <= TOP - CONTENT_BOTTOM) {
    s.ensure(boxH);
    const top = s.y;
    s.card(MARGIN, top, CONTENT_W, boxH, 6, s.c.cream, s.c.ruleSoft);
    s.tracked("A note from your tournament director", MARGIN + padX, Sheet.baseline(top - padY, EYEBROW.size, EYEBROW.lh), EYEBROW.size, bold, s.c.courtGreen, EYEBROW.tracking);
    s.lines(lines, MARGIN + padX, top - padY - EYEBROW.lh - 3, BODY.size, BODY.lh, regular, s.c.ink);
    s.y = top - boxH;
  } else {
    // A note longer than a page can't sit in one card — flow it plain.
    s.ensure(EYEBROW.lh + BODY.lh * 2);
    s.tracked("A note from your tournament director", MARGIN, Sheet.baseline(s.y, EYEBROW.size, EYEBROW.lh), EYEBROW.size, bold, s.c.courtGreen, EYEBROW.tracking);
    s.y -= EYEBROW.lh + 3;
    s.flow(lines, MARGIN, BODY.size, BODY.lh, regular, s.c.ink);
  }
  s.y -= 18;
}

// ── By the numbers ───────────────────────────────────────────────────

type Tile = { label: string; value: string; sub?: string };

// Same tile set as TournamentSummaryReport.
function tilesFor(summary: TournamentSummary): Tile[] {
  const h = summary.headline;
  const scoredEverything = h.matchesPlayed === h.matchesTotal;
  const tiles: Tile[] = [
    { label: "Players", value: h.players.toLocaleString() },
    { label: "Teams", value: h.teams.toLocaleString() },
    {
      label: "Brackets",
      value: h.events.toLocaleString(),
      sub: h.eventsDecided < h.events ? `${h.eventsDecided} decided` : undefined,
    },
    {
      label: "Matches played",
      value: h.matchesPlayed.toLocaleString(),
      sub: scoredEverything ? undefined : `of ${h.matchesTotal.toLocaleString()} scheduled`,
    },
    { label: "Points scored", value: h.pointsScored.toLocaleString() },
    { label: "Medals awarded", value: h.medalsAwarded.toLocaleString() },
  ];
  if (h.days > 0) {
    tiles.push({
      label: h.days === 1 ? "Hours of play" : "Days of play",
      value: h.days === 1 ? fmtMinutes(h.playMinutes) : String(h.days),
      sub: h.days === 1 ? undefined : `${fmtMinutes(h.playMinutes)} of play`,
    });
  }
  if (h.courtsUsed > 0) {
    tiles.push({ label: "Courts used", value: String(h.courtsUsed) });
  }
  return tiles;
}

function drawTiles(s: Sheet, summary: TournamentSummary): void {
  const { regular, bold } = s.fonts;
  const cols = 4;
  const gap = 8;
  const tileW = (CONTENT_W - gap * (cols - 1)) / cols;
  const pad = 9;
  const innerW = tileW - pad * 2;
  const VALUE = { size: 19, lh: 22 };
  const SUB = { size: 8.5, lh: 11 };

  const tiles = tilesFor(summary);
  const rows: Block[] = [];
  for (let i = 0; i < tiles.length; i += cols) {
    const row = tiles.slice(i, i + cols).map((t) => {
      const valueLines = wrap(t.value, bold, VALUE.size, innerW);
      const subLines = t.sub ? wrap(t.sub, regular, SUB.size, innerW) : [];
      const height = pad + valueLines.length * VALUE.lh + 3 + LABEL.lh + (subLines.length ? 1 + subLines.length * SUB.lh : 0) + pad - 1;
      return { t, valueLines, subLines, height };
    });
    const rowH = Math.max(...row.map((r) => r.height));
    rows.push({
      height: rowH,
      draw: (top) => {
        row.forEach((r, col) => {
          const x = MARGIN + col * (tileW + gap);
          s.card(x, top, tileW, rowH, 6, s.c.white, s.c.rule);
          let t = top - pad;
          t -= s.lines(r.valueLines, x + pad, t, VALUE.size, VALUE.lh, bold, s.c.ink);
          t -= 3;
          s.tracked(r.t.label, x + pad, Sheet.baseline(t, LABEL.size, LABEL.lh), LABEL.size, bold, s.c.inkSoft, LABEL.tracking);
          t -= LABEL.lh;
          if (r.subLines.length) {
            t -= 1;
            s.lines(r.subLines, x + pad, t, SUB.size, SUB.lh, regular, s.c.inkMuted);
          }
        });
      },
    });
  }

  sectionTitle(s, "By the numbers", rows[0]?.height ?? 0);
  rows.forEach((row, i) => {
    if (i > 0) s.y -= gap;
    s.ensure(row.height);
    row.draw(s.y);
    s.y -= row.height;
  });
  s.y -= 22;
}

// ── Brackets & winners ───────────────────────────────────────────────

function medalPalette(s: Sheet, place: Podium["place"]): { fill: RGB; fg: RGB; border: RGB; label: string } {
  switch (place) {
    case "gold":
      return { fill: s.c.warnBg, fg: s.c.warnFg, border: s.c.creamDeep, label: "Gold" };
    case "silver":
      return { fill: s.c.bg, fg: s.c.inkSoft, border: s.c.rule, label: "Silver" };
    case "bronze":
      return { fill: s.c.dangerBg, fg: s.c.dangerFg, border: s.c.courtRed, label: "Bronze" };
  }
}

function layoutEventCard(s: Sheet, e: EventResult): Block {
  const { regular, bold } = s.fonts;
  const padX = 11;
  const padY = 9;
  const innerW = CONTENT_W - padX * 2;
  const NAME = { size: 12, lh: 15 };
  const TEAM = { size: 10.5, lh: 13.5 };
  const BADGE_W = 52;
  const BADGE_H = 13;

  const meta =
    `${plural(e.teamCount, "team")} · ${plural(e.playerCount, "player")} · ${plural(e.matchesPlayed, "match", "matches")}` +
    (e.matchesPlayed < e.matchesTotal ? ` of ${e.matchesTotal}` : "") +
    (e.pointsScored > 0 ? ` · ${e.pointsScored.toLocaleString()} pts` : "");
  const metaW = regular.widthOfTextAtSize(clean(meta), SMALL.size);
  const metaInline = metaW <= innerW * 0.45;
  const nameLines = wrap(e.name, bold, NAME.size, metaInline ? innerW - metaW - 12 : innerW);
  const formatLines = wrap(e.formatLine, regular, SMALL.size, innerW);
  const undecided = e.podium.length === 0;

  const podiumRows = e.podium.map((p) => {
    const font = p.place === "gold" ? bold : regular;
    const lines = wrap(p.team, font, TEAM.size, innerW - BADGE_W - 8);
    return { p, font, lines, height: Math.max(BADGE_H + 2, lines.length * TEAM.lh) };
  });
  const undecidedText = undecided
    ? e.matchesTotal === 0
      ? "No matches were generated for this bracket."
      : "Results not final — medal matches still to be scored."
    : "";
  const undecidedLines = undecided ? wrap(undecidedText, regular, 9.5, innerW - BADGE_W - 8) : [];
  const rrNote = e.podiumSource === "round_robin" ? "Placed by round-robin record (wins, then point differential)." : "";

  let height = padY + nameLines.length * NAME.lh + formatLines.length * SMALL.lh;
  if (!metaInline) height += SMALL.lh;
  height += 7;
  if (undecided) height += Math.max(BADGE_H + 2, undecidedLines.length * 13);
  else height += podiumRows.reduce((sum, r) => sum + r.height, 0) + 4 * (podiumRows.length - 1);
  if (rrNote) height += 4 + FINE.lh;
  height += padY;

  return {
    height,
    draw: (top) => {
      s.card(MARGIN, top, CONTENT_W, height, 6, s.c.white, s.c.rule);
      const x = MARGIN + padX;
      let t = top - padY;
      if (metaInline) {
        s.text(meta, MARGIN + CONTENT_W - padX, Sheet.baseline(t, SMALL.size, NAME.lh), SMALL.size, regular, s.c.inkMuted, "right");
      }
      t -= s.lines(nameLines, x, t, NAME.size, NAME.lh, bold, s.c.ink);
      t -= s.lines(formatLines, x, t, SMALL.size, SMALL.lh, regular, s.c.inkSoft);
      if (!metaInline) {
        t -= s.lines([meta], x, t, SMALL.size, SMALL.lh, regular, s.c.inkMuted);
      }
      t -= 7;
      if (undecided) {
        const w = s.pill("Not final", x, t - 1, BADGE_W, s.c.warnBg, s.c.warnFg, s.c.creamDeep);
        s.lines(undecidedLines, x + w + 8, t, 9.5, 13, regular, s.c.inkMuted);
        t -= Math.max(BADGE_H + 2, undecidedLines.length * 13);
      } else {
        podiumRows.forEach((r, i) => {
          if (i > 0) t -= 4;
          const pal = medalPalette(s, r.p.place);
          s.pill(pal.label, x, t - 1, BADGE_W, pal.fill, pal.fg, pal.border);
          s.lines(r.lines, x + BADGE_W + 8, t, TEAM.size, TEAM.lh, r.font, s.c.ink);
          t -= r.height;
        });
      }
      if (rrNote) {
        t -= 4;
        s.text(rrNote, x, Sheet.baseline(t, FINE.size, FINE.lh), FINE.size, regular, s.c.inkMuted);
      }
    },
  };
}

function drawBrackets(s: Sheet, events: EventResult[]): void {
  const gap = 8;
  if (events.length === 0) {
    sectionTitle(s, "Brackets & winners", BODY.lh);
    s.text("No brackets on this tournament yet.", MARGIN, Sheet.baseline(s.y, BODY.size, BODY.lh), BODY.size, s.fonts.regular, s.c.inkMuted);
    s.y -= BODY.lh + 22;
    return;
  }
  const cards = events.map((e) => layoutEventCard(s, e));
  sectionTitle(s, "Brackets & winners", cards[0].height);
  cards.forEach((card, i) => {
    if (i > 0) s.y -= gap;
    s.ensure(card.height);
    card.draw(s.y);
    s.y -= card.height;
  });
  s.y -= 22;
}

// ── Highlights ───────────────────────────────────────────────────────

function drawHighlights(s: Sheet, highlights: Highlight[]): void {
  const { regular, bold } = s.fonts;
  const cols = 2;
  const gap = 8;
  const cardW = (CONTENT_W - gap * (cols - 1)) / cols;
  const padX = 10;
  const padY = 9;
  const innerW = cardW - padX * 2;
  const VALUE = { size: 12, lh: 15 };

  const rows: Block[] = [];
  for (let i = 0; i < highlights.length; i += cols) {
    const row = highlights.slice(i, i + cols).map((hl) => {
      const valueLines = wrap(hl.value, bold, VALUE.size, innerW);
      const detailLines = hl.detail ? wrap(hl.detail, regular, SMALL.size, innerW) : [];
      const height =
        padY + LABEL.lh + 2 + valueLines.length * VALUE.lh + (detailLines.length ? 2 + detailLines.length * SMALL.lh : 0) + padY;
      return { hl, valueLines, detailLines, height };
    });
    const rowH = Math.max(...row.map((r) => r.height));
    rows.push({
      height: rowH,
      draw: (top) => {
        row.forEach((r, col) => {
          const x = MARGIN + col * (cardW + gap);
          s.card(x, top, cardW, rowH, 6, s.c.cream, s.c.ruleSoft);
          let t = top - padY;
          s.tracked(r.hl.label, x + padX, Sheet.baseline(t, LABEL.size, LABEL.lh), LABEL.size, bold, s.c.inkSoft, LABEL.tracking);
          t -= LABEL.lh + 2;
          t -= s.lines(r.valueLines, x + padX, t, VALUE.size, VALUE.lh, bold, s.c.ink);
          if (r.detailLines.length) {
            t -= 2;
            s.lines(r.detailLines, x + padX, t, SMALL.size, SMALL.lh, regular, s.c.inkSoft);
          }
        });
      },
    });
  }

  sectionTitle(s, "Highlights", rows[0]?.height ?? 0);
  rows.forEach((row, i) => {
    if (i > 0) s.y -= gap;
    s.ensure(row.height);
    row.draw(s.y);
    s.y -= row.height;
  });
  s.y -= 22;
}

// ── Day by day ───────────────────────────────────────────────────────

function drawDays(s: Sheet, summary: TournamentSummary): void {
  const { regular, bold } = s.fonts;
  const cols: { label: string; w: number; align: "left" | "right" }[] = [
    { label: "Day", w: 110, align: "left" },
    { label: "Matches", w: 70, align: "right" },
    { label: "Points", w: 70, align: "right" },
    { label: "First – last score", w: 190, align: "left" },
    { label: "Span", w: 100, align: "right" },
  ];
  const padX = 6;
  const headH = 16;
  const rowH = 18;
  const ROW = { size: 9.5 };

  const colX = (i: number): number => MARGIN + cols.slice(0, i).reduce((sum, c) => sum + c.w, 0);
  const cellX = (i: number): number => (cols[i].align === "right" ? colX(i) + cols[i].w - padX : colX(i) + padX);

  const drawHead = (): void => {
    const base = Sheet.baseline(s.y, LABEL.size, headH);
    cols.forEach((c, i) => {
      if (c.align === "right") {
        const w = s.trackedWidth(c.label, LABEL.size, bold, LABEL.tracking);
        s.tracked(c.label, cellX(i) - w, base, LABEL.size, bold, s.c.inkSoft, LABEL.tracking);
      } else {
        s.tracked(c.label, cellX(i), base, LABEL.size, bold, s.c.inkSoft, LABEL.tracking);
      }
    });
    s.y -= headH;
    s.hr(s.y, 0.75, s.c.rule);
  };

  sectionTitle(s, "Day by day", headH + rowH);
  drawHead();
  for (const d of summary.days) {
    if (rowH > s.remaining) {
      s.newPage();
      drawHead();
    }
    const cells = [
      fmtDay(d.date),
      String(d.matches),
      d.points.toLocaleString(),
      `${fmtTime(d.firstFinish)} – ${fmtTime(d.lastFinish)}`,
      fmtMinutes(d.spanMinutes),
    ];
    const base = Sheet.baseline(s.y, ROW.size, rowH);
    cells.forEach((v, i) => {
      s.text(truncate(v, regular, ROW.size, cols[i].w - padX * 2), cellX(i), base, ROW.size, regular, s.c.ink, cols[i].align);
    });
    s.y -= rowH;
    s.hr(s.y, 0.5, s.c.ruleSoft);
  }
  s.y -= 6;
  s.flow(
    wrap("Times are when each score was recorded at the desk, shown in the time zone this report was generated in.", regular, FINE.size, CONTENT_W),
    MARGIN,
    FINE.size,
    FINE.lh,
    regular,
    s.c.inkMuted,
  );
  s.y -= 16;
}

// ── Closing line + page footers ──────────────────────────────────────

function drawClosing(s: Sheet, header: ReportHeader, summary: TournamentSummary): void {
  const { regular } = s.fonts;
  const left = `Prepared by ${header.orgName} · Bert & Erne`;
  const right = summary.lastResultAt
    ? `Results as of ${summary.lastResultAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
    : "No results recorded yet";
  const size = 8.5;
  const lh = 12;
  const fits = regular.widthOfTextAtSize(clean(left), size) + regular.widthOfTextAtSize(clean(right), size) + 16 <= CONTENT_W;

  s.ensure(1 + 8 + lh * (fits ? 1 : 2));
  s.hr(s.y, 0.75, s.c.rule);
  s.y -= 0.75 + 8;
  const base = Sheet.baseline(s.y, size, lh);
  s.text(left, MARGIN, base, size, regular, s.c.inkMuted);
  if (fits) {
    s.text(right, MARGIN + CONTENT_W, base, size, regular, s.c.inkMuted, "right");
    s.y -= lh;
  } else {
    s.y -= lh;
    s.text(right, MARGIN, Sheet.baseline(s.y, size, lh), size, regular, s.c.inkMuted);
    s.y -= lh;
  }
}

// Second pass once every page exists: "Page n of N" plus the running
// title in the footer strip.
function drawPageFooters(s: Sheet, header: ReportHeader): void {
  const { regular } = s.fonts;
  const size = 7.5;
  const total = s.pages.length;
  const base = MARGIN + 4;
  s.pages.forEach((page, i) => {
    const label = `Page ${i + 1} of ${total}`;
    const labelW = regular.widthOfTextAtSize(label, size);
    page.drawLine({
      start: { x: MARGIN, y: CONTENT_BOTTOM - 4 },
      end: { x: MARGIN + CONTENT_W, y: CONTENT_BOTTOM - 4 },
      thickness: 0.5,
      color: s.c.ruleSoft,
    });
    page.drawText(label, { x: MARGIN + CONTENT_W - labelW, y: base, size, font: regular, color: s.c.inkMuted });
    const running = truncate(`${header.tournamentName} · Tournament summary`, regular, size, CONTENT_W - labelW - 16);
    if (running) page.drawText(running, { x: MARGIN, y: base, size, font: regular, color: s.c.inkMuted });
  });
}
