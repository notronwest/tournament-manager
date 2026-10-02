// Turns an organizer's free-typed tournament description into structured
// blocks so the public Details tab can lay it out (headings, icon lists,
// plain lists, paragraphs) instead of one wall of <br/>-separated lines.
//
// Organizers paste copy like:
//   Tournament Details:
//   📆 Dates: Friday, October 2nd – Sunday, October 4th
//   💰 Registration (includes 1 event):
//   $65 Early Bird through Sept 1st — $75 after
//   Skill Levels:
//   3.0–3.5
//   3.5–3.99
// with no blank lines and no markdown. Heuristics, line by line:
//   - "heading"  : short line ending in ":" with no leading marker
//   - "item"     : line led by a bullet marker (-, *, •, ✓, ✔, or an emoji)
//   - short text after a heading / item → list item (child of an item that
//                  ends in ":", e.g. the pricing lines under "💰 Registration:")
//   - everything else → paragraph (consecutive paragraph lines in the intro
//                  stay one paragraph per line; blank lines still separate)

export type DescItem = {
  /** Leading marker glyph (emoji / ✓ / •), null for a plain list line. */
  marker: string | null;
  text: string;
  children: string[];
};

export type DescBlock =
  | { kind: "heading"; text: string }
  | { kind: "list"; items: DescItem[] }
  | { kind: "paragraph"; text: string; note?: boolean };

const HEADING_MAX = 60;
const SHORT_LINE_MAX = 80;

// A leading emoji (incl. ZWJ sequences / variation selectors / keycaps) or a
// textual bullet, followed by whitespace.
const MARKER_RE =
  /^((?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|\u200D|\u20E3|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator})*|[-*\u2022\u00B7\u2713\u2714\u2705\u2611])\uFE0F?\s+(.*)$/u;

function splitMarker(line: string): { marker: string; text: string } | null {
  const m = line.match(MARKER_RE);
  if (!m) return null;
  // Markdown "-"/"*" bullets render as a plain dot.
  const marker = m[1] === "-" || m[1] === "*" ? "•" : m[1];
  return { marker, text: m[2].trim() };
}

function isHeading(line: string): boolean {
  return line.length <= HEADING_MAX && /:\s*$/.test(line) && !splitMarker(line);
}

export function parseDescription(raw: string): DescBlock[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  const blocks: DescBlock[] = [];
  let list: DescItem[] | null = null;
  // True once we're inside a heading's section or a list — short plain
  // lines there are list entries rather than paragraphs.
  let inSection = false;

  const closeList = () => {
    if (list && list.length) blocks.push({ kind: "list", items: list });
    list = null;
  };

  for (const line of lines) {
    if (!line) {
      closeList();
      inSection = false;
      continue;
    }
    if (isHeading(line)) {
      closeList();
      blocks.push({ kind: "heading", text: line.replace(/:\s*$/, "") });
      inSection = true;
      continue;
    }
    const marked = splitMarker(line);
    if (marked) {
      list ??= [];
      list.push({ marker: marked.marker, text: marked.text, children: [] });
      inSection = true;
      continue;
    }
    const isNote = line.startsWith("(") && line.endsWith(")");
    if (inSection && !isNote && line.length <= SHORT_LINE_MAX) {
      const last: DescItem | undefined = list?.[list.length - 1];
      if (last && last.marker && /:\s*$/.test(last.text)) {
        last.children.push(line);
      } else {
        list ??= [];
        list.push({ marker: null, text: line, children: [] });
      }
      continue;
    }
    closeList();
    blocks.push(isNote ? { kind: "paragraph", text: line, note: true } : { kind: "paragraph", text: line });
  }
  closeList();
  return blocks;
}
