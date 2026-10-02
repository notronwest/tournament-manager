import { useMemo, useState, type CSSProperties } from "react";
import type { Database } from "../types/supabase";
import { ink, inkSoft, inkMuted, rule, courtBlue, courtYellow, warnBg, bodyFontStack, headingFontStack } from "../lib/publicTheme";

// A real bracket picture for double elimination: winners bracket on top,
// consolation bracket below, finals on the right, elbow connectors between a
// match and the match its winner feeds. Laid out purely from the match rows'
// own wiring (bracket / round / position / feeds_winner_to), so the console
// and the public Results tab draw the same thing. Zoom buttons scale the
// canvas; the container scrolls in both directions.

type MatchRow = Database["public"]["Tables"]["matches"]["Row"] & {
  bracket?: "winners" | "consolation" | "final" | null;
  slot_key?: string | null;
  label?: string | null;
  if_necessary?: boolean | null;
  feeds_winner_to?: string | null;
  feeds_winner_side?: "a" | "b" | null;
  feeds_loser_to?: string | null;
  feeds_loser_side?: "a" | "b" | null;
};

const CARD_W = 220;
const CARD_H = 66;
const COL_GAP = 48;
const ROW_GAP = 18;
const SECTION_GAP = 56;

type Placed = { m: MatchRow; x: number; y: number };

export function BracketView({
  matches,
  labelFor,
  onSelect,
  selectedId,
}: {
  matches: MatchRow[];
  labelFor: (regId: string) => string;
  onSelect?: (m: MatchRow) => void;
  selectedId?: string | null;
}) {
  const [scale, setScale] = useState(1);

  const layout = useMemo(() => {
    const byId = new Map(matches.map((m) => [m.id, m]));
    // Who feeds whom (winner links only — those are the drawn connectors).
    const feedersOf = new Map<string, MatchRow[]>();
    for (const m of matches) {
      if (m.feeds_winner_to) {
        const arr = feedersOf.get(m.feeds_winner_to) ?? [];
        arr.push(m);
        feedersOf.set(m.feeds_winner_to, arr);
      }
    }
    const section = (m: MatchRow) => (m.bracket === "consolation" ? "bottom" : "top");
    const rounds = (b: "winners" | "consolation") => {
      const rs = new Map<number, MatchRow[]>();
      for (const m of matches) if ((m.bracket ?? "winners") === b) rs.set(m.round, [...(rs.get(m.round) ?? []), m]);
      return Array.from(rs.entries()).sort(([a], [c]) => a - c).map(([r, ms]) => ({ round: r, ms: ms.sort((x, y) => x.position - y.position) }));
    };
    const W = rounds("winners");
    const L = rounds("consolation");
    const finals = matches.filter((m) => m.bracket === "final").sort((a, b) => a.round - b.round);

    const placed = new Map<string, Placed>();
    const step = CARD_H + ROW_GAP;
    // Place a bracket's columns left→right; y = average of same-section
    // feeders when there are any, else even spacing by position.
    const placeBracket = (cols: { round: number; ms: MatchRow[] }[], x0: number, y0: number) => {
      let x = x0;
      let maxBottom = y0;
      const firstCount = cols[0]?.ms.length ?? 0;
      const span = Math.max(firstCount, 1) * step;
      for (const col of cols) {
        for (const m of col.ms) {
          const feeders = (feedersOf.get(m.id) ?? []).filter((f) => section(f) === section(m) && placed.has(f.id));
          let y: number;
          if (feeders.length > 0) {
            y = feeders.reduce((s, f) => s + placed.get(f.id)!.y, 0) / feeders.length;
          } else {
            const slot = span / Math.max(col.ms.length, 1);
            y = y0 + slot * (m.position + 0.5) - CARD_H / 2;
          }
          placed.set(m.id, { m, x, y });
          maxBottom = Math.max(maxBottom, y + CARD_H);
        }
        x += CARD_W + COL_GAP;
      }
      return { right: x, bottom: maxBottom };
    };
    const top = placeBracket(W, 0, 0);
    // Finals to the right of the winners final, aligned with it.
    let right = top.right;
    if (finals.length) {
      const wFinal = W.length ? placed.get(W[W.length - 1].ms[0]?.id) : undefined;
      let y = wFinal ? wFinal.y : 0;
      for (const f of finals) {
        placed.set(f.id, { m: f, x: right, y });
        y += step;
      }
      right += CARD_W + COL_GAP;
    }
    const bottomY = Math.max(top.bottom, finals.length ? (placed.get(finals[finals.length - 1].id)!.y + CARD_H) : 0) + SECTION_GAP;
    const bottom = L.length ? placeBracket(L, 0, bottomY) : { right: 0, bottom: bottomY };
    const width = Math.max(right, bottom.right) - COL_GAP + 8;
    const height = Math.max(top.bottom, bottom.bottom) + 8;

    // Connectors: from each match's right-middle to the fed match's left-middle,
    // same section only (loser drops are labelled on the card instead).
    const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const m of matches) {
      const to = m.feeds_winner_to ? byId.get(m.feeds_winner_to) : undefined;
      if (!to) continue;
      const a = placed.get(m.id), b = placed.get(to.id);
      if (!a || !b) continue;
      if (section(m) !== section(to) && to.bracket !== "final") continue;
      lines.push({ x1: a.x + CARD_W, y1: a.y + CARD_H / 2, x2: b.x, y2: b.y + CARD_H / 2 });
    }
    // TBD text: which match feeds each empty side.
    const sourceText = new Map<string, string>();
    for (const m of matches) {
      if (m.feeds_winner_to && m.feeds_winner_side) sourceText.set(`${m.feeds_winner_to}:${m.feeds_winner_side}`, `Winner of ${m.slot_key ?? m.label ?? "?"}`);
      if (m.feeds_loser_to && m.feeds_loser_side) sourceText.set(`${m.feeds_loser_to}:${m.feeds_loser_side}`, `Loser of ${m.slot_key ?? m.label ?? "?"}`);
    }
    const headers: { x: number; y: number; text: string }[] = [];
    const lastW = Math.max(...W.map((c) => c.round), 0);
    const lastLr = Math.max(...L.map((c) => c.round), 0);
    W.forEach((c, i) => headers.push({ x: i * (CARD_W + COL_GAP), y: -22, text: c.round === lastW ? "Winners Final" : `Winners R${c.round}` }));
    if (finals.length) headers.push({ x: top.right, y: -22, text: "Final" });
    L.forEach((c, i) => headers.push({ x: i * (CARD_W + COL_GAP), y: bottomY - 22, text: c.round === lastLr ? "Consolation Final" : `Consolation R${c.round}` }));
    return { placed: Array.from(placed.values()), lines, width, height: height + 24, sourceText, headers, hasBottom: L.length > 0 };
  }, [matches]);

  const zoom = (d: number) => setScale((s) => Math.min(2, Math.max(0.4, Math.round((s + d) * 10) / 10)));
  const PAD = 26; // room for the column headers above row 0

  return (
    <div style={{ fontFamily: bodyFontStack }}>
      <div className="no-print" style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => zoom(-0.1)} style={zoomBtn} aria-label="Zoom out">−</button>
        <span style={{ fontSize: 12, color: inkMuted, minWidth: 44, textAlign: "center" }}>{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => zoom(0.1)} style={zoomBtn} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => setScale(1)} style={{ ...zoomBtn, width: "auto", padding: "0 12px" }}>100%</button>
        <button type="button" onClick={() => setScale(0.6)} style={{ ...zoomBtn, width: "auto", padding: "0 12px" }}>Fit more</button>
        <span style={{ fontSize: 11, color: inkMuted, flexBasis: "100%" }}>Scroll to pan · bold = winner · dashed = if necessary</span>
      </div>
      <div style={{ overflow: "auto", border: `1px solid ${rule}`, borderRadius: 8, background: "#fff", maxHeight: "70vh" }}>
        <div style={{ width: (layout.width) * scale, height: (layout.height + PAD) * scale, position: "relative" }}>
          <div style={{ transform: `scale(${scale})`, transformOrigin: "top left", position: "absolute", left: 0, top: 0, width: layout.width, height: layout.height + PAD, padding: 0 }}>
            <svg width={layout.width} height={layout.height + PAD} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }} aria-hidden>
              <g transform={`translate(0, ${PAD})`}>
                {layout.lines.map((l, i) => {
                  const midX = l.x1 + COL_GAP / 2;
                  return <path key={i} d={`M ${l.x1} ${l.y1} H ${midX} V ${l.y2} H ${l.x2}`} fill="none" stroke={rule} strokeWidth={2} />;
                })}
              </g>
            </svg>
            {layout.headers.map((h, i) => (
              <div key={i} style={{ position: "absolute", left: h.x, top: h.y + PAD, fontSize: 11, fontFamily: headingFontStack, textTransform: "uppercase", letterSpacing: 0.6, color: inkMuted, whiteSpace: "nowrap" }}>
                {h.text}
              </div>
            ))}
            {layout.placed.map(({ m, x, y }) => {
              const done = m.status === "completed";
              const a = m.team_a_reg_id ? labelFor(m.team_a_reg_id) : layout.sourceText.get(`${m.id}:a`) ?? "TBD";
              const b = m.team_b_reg_id ? labelFor(m.team_b_reg_id) : layout.sourceText.get(`${m.id}:b`) ?? "TBD";
              const aWon = done && m.winner_reg_id === m.team_a_reg_id;
              const bWon = done && m.winner_reg_id === m.team_b_reg_id;
              const selected = selectedId === m.id;
              const live = m.status === "in_progress";
              return (
                <div
                  key={m.id}
                  role={onSelect ? "button" : undefined}
                  tabIndex={onSelect ? 0 : undefined}
                  onClick={onSelect ? () => onSelect(m) : undefined}
                  onKeyDown={onSelect ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(m); } } : undefined}
                  title={m.label ?? m.slot_key ?? undefined}
                  style={{
                    position: "absolute", left: x, top: y + PAD, width: CARD_W, height: CARD_H,
                    border: `${selected ? 2 : 1}px ${m.if_necessary ? "dashed" : "solid"} ${selected ? courtBlue : live ? courtYellow : rule}`,
                    borderRadius: 6, background: live ? warnBg : "#fff", boxSizing: "border-box",
                    display: "flex", flexDirection: "column", justifyContent: "space-between",
                    cursor: onSelect ? "pointer" : "default", boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                  }}
                >
                  <div style={{ fontSize: 9.5, color: inkMuted, padding: "3px 8px 0", display: "flex", justifyContent: "space-between" }}>
                    <span>{m.slot_key ?? ""}</span>
                    <span>{m.court ?? (live ? "playing" : "")}</span>
                  </div>
                  <TeamLine name={a} score={m.team_a_score} won={aWon} tbd={!m.team_a_reg_id} />
                  <TeamLine name={b} score={m.team_b_score} won={bWon} tbd={!m.team_b_reg_id} last />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function TeamLine({ name, score, won, tbd, last }: { name: string; score: number | null; won: boolean; tbd: boolean; last?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, padding: `0 8px ${last ? 4 : 0}px`, borderTop: last ? `1px solid ${rule}` : undefined, fontSize: 12.5, lineHeight: 1.6 }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: tbd ? inkMuted : won ? ink : inkSoft, fontWeight: won ? 700 : 400, fontStyle: tbd ? "italic" : "normal" }}>{name}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: won ? 700 : 400, color: score == null ? inkMuted : ink, minWidth: 18, textAlign: "right" }}>{score ?? ""}</span>
    </div>
  );
}

const zoomBtn: CSSProperties = {
  width: 44, height: 44, borderRadius: 6, border: `1px solid ${rule}`, background: "#fff", color: ink, fontSize: 16, cursor: "pointer", fontFamily: bodyFontStack,
};
