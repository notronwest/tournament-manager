import type { CSSProperties } from "react";
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
  bodyFontStack,
  displayFontStack,
  headingFontStack,
} from "../lib/publicTheme";
import {
  fmtDateRange,
  fmtDay,
  fmtMinutes,
  type Podium,
  type ReportHeader,
  type TournamentSummary,
} from "../lib/tournamentSummary";

// The client-facing end-of-tournament summary: brackets + winners, the
// headline numbers, and the fun facts. Purely presentational so the page
// (which loads the data) and the print path share one render. Everything
// in here is meant to be printed / saved as PDF and sent to the client, so
// it carries no admin controls — the page wraps it with those.

export function TournamentSummaryReport({
  header,
  summary,
  note,
}: {
  header: ReportHeader;
  summary: TournamentSummary;
  note: string;
}) {
  const h = summary.headline;
  const scoredEverything = h.matchesPlayed === h.matchesTotal;

  const tiles: { label: string; value: string; sub?: string }[] = [
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
    {
      label: "Medals awarded",
      value: h.medalsAwarded.toLocaleString(),
    },
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

  return (
    <article style={sheet} className="summary-sheet">
      {/* ── Masthead ─────────────────────────────────────────────── */}
      <header style={{ borderBottom: `3px solid ${ink}`, paddingBottom: 14, marginBottom: 20 }}>
        <div style={eyebrow}>Tournament summary</div>
        <h1 style={title}>{header.tournamentName}</h1>
        <div style={{ fontSize: 14, color: inkSoft, lineHeight: 1.5 }}>
          {fmtDateRange(header.startsAt, header.endsAt)}
          {header.venueName && <> · {header.venueName}</>}
          {header.venueAddress && (
            <div style={{ fontSize: 13, color: inkMuted }}>{header.venueAddress}</div>
          )}
        </div>
      </header>

      {note.trim() && (
        <section style={{ ...noteBox, marginBottom: 22 }} className="print-row">
          <div style={eyebrow}>A note from your tournament director</div>
          <p style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.6 }}>{note.trim()}</p>
        </section>
      )}

      {/* ── Headline numbers ─────────────────────────────────────── */}
      <section style={{ marginBottom: 26 }} className="print-section">
        <h2 style={h2}>By the numbers</h2>
        <div style={tileGrid}>
          {tiles.map((t) => (
            <div key={t.label} style={tile} className="print-row">
              <div style={tileValue}>{t.value}</div>
              <div style={tileLabel}>{t.label}</div>
              {t.sub && <div style={tileSub}>{t.sub}</div>}
            </div>
          ))}
        </div>
      </section>

      {/* ── Brackets + winners ───────────────────────────────────── */}
      <section style={{ marginBottom: 26 }} className="print-section">
        <h2 style={h2}>Brackets &amp; winners</h2>
        {summary.events.length === 0 ? (
          <p style={{ color: inkMuted, fontSize: 14 }}>No brackets on this tournament yet.</p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {summary.events.map((e) => (
              <div key={e.id} style={eventCard} className="print-row">
                <div style={eventHead}>
                  <div style={{ minWidth: 0 }}>
                    <div style={eventName}>{e.name}</div>
                    <div style={{ fontSize: 12.5, color: inkSoft }}>{e.formatLine}</div>
                  </div>
                  <div style={eventMeta}>
                    {plural(e.teamCount, "team")} · {plural(e.playerCount, "player")} ·{" "}
                    {plural(e.matchesPlayed, "match", "matches")}
                    {e.matchesPlayed < e.matchesTotal && <> of {e.matchesTotal}</>}
                    {e.pointsScored > 0 && <> · {e.pointsScored.toLocaleString()} pts</>}
                  </div>
                </div>
                {e.podium.length > 0 ? (
                  <div style={podiumWrap}>
                    {e.podium.map((p) => (
                      <PodiumRow key={p.place} podium={p} />
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: inkMuted, marginTop: 8 }}>
                    {e.matchesTotal === 0
                      ? "No matches were generated for this bracket."
                      : "Results not final — medal matches still to be scored."}
                  </div>
                )}
                {e.podiumSource === "round_robin" && (
                  <div style={{ fontSize: 11.5, color: inkMuted, marginTop: 6 }}>
                    Placed by round-robin record (wins, then point differential).
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Fun facts ────────────────────────────────────────────── */}
      {summary.highlights.length > 0 && (
        <section style={{ marginBottom: 26 }} className="print-section">
          <h2 style={h2}>Highlights</h2>
          <div style={highlightGrid}>
            {summary.highlights.map((hl) => (
              <div key={hl.key} style={highlight} className="print-row">
                <div style={highlightLabel}>{hl.label}</div>
                <div style={highlightValue}>{hl.value}</div>
                {hl.detail && <div style={highlightDetail}>{hl.detail}</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Day by day ───────────────────────────────────────────── */}
      {summary.days.length > 0 && (
        <section style={{ marginBottom: 20 }} className="print-section">
          <h2 style={h2}>Day by day</h2>
          {/* Table on wide screens and paper; stacked cards at phone width
              (a 5-column table clips at 390px). Toggled by the media query
              in the style block below. */}
          <table className="summary-days-table" style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5 }}>
            <thead>
              <tr>
                <th style={th}>Day</th>
                <th style={{ ...th, textAlign: "right" }}>Matches</th>
                <th style={{ ...th, textAlign: "right" }}>Points</th>
                <th style={th}>First → last score</th>
                <th style={{ ...th, textAlign: "right" }}>Span</th>
              </tr>
            </thead>
            <tbody>
              {summary.days.map((d) => (
                <tr key={d.date} className="print-row" style={{ borderTop: `1px solid ${ruleSoft}` }}>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtDay(d.date)}</td>
                  <td style={{ ...td, textAlign: "right" }}>{d.matches}</td>
                  <td style={{ ...td, textAlign: "right" }}>{d.points.toLocaleString()}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    {fmtTime(d.firstFinish)} → {fmtTime(d.lastFinish)}
                  </td>
                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>{fmtMinutes(d.spanMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="summary-days-cards" style={{ display: "none", gap: 8 }}>
            {summary.days.map((d) => (
              <div key={d.date} style={eventCard} className="print-row">
                <div style={{ ...eventName, fontSize: 15 }}>{fmtDay(d.date)}</div>
                <div style={{ fontSize: 13, color: inkSoft, marginTop: 4, lineHeight: 1.5 }}>
                  {plural(d.matches, "match", "matches")} · {d.points.toLocaleString()} points
                  <br />
                  {fmtTime(d.firstFinish)} → {fmtTime(d.lastFinish)} · {fmtMinutes(d.spanMinutes)}
                </div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 11.5, color: inkMuted, margin: "8px 0 0", lineHeight: 1.5 }}>
            Times are when each score was recorded at the desk, shown in this browser's time zone.
          </p>
        </section>
      )}

      <footer style={{ borderTop: `1px solid ${rule}`, paddingTop: 10, fontSize: 11.5, color: inkMuted, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <span>Prepared by {header.orgName} · Bert &amp; Erne</span>
        <span>
          {summary.lastResultAt
            ? `Results as of ${summary.lastResultAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
            : "No results recorded yet"}
        </span>
      </footer>

      {/* Print / Save as PDF: hide the whole app, then reveal just this
          sheet at the top-left of the page. US Letter, half-inch margins,
          cards that never split across pages (same rules as the schedule
          and roster print sheets). */}
      <style>{`
        @media (max-width: 599px) {
          .summary-days-table { display: none; }
          .summary-days-cards { display: grid !important; }
        }
        @media print {
          .summary-days-table { display: table !important; }
          .summary-days-cards { display: none !important; }
          body * { visibility: hidden !important; }
          .summary-sheet, .summary-sheet * { visibility: visible !important; }
          .summary-sheet {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            max-width: none !important;
            border: none !important;
            border-radius: 0 !important;
            padding: 0 !important;
          }
          .no-print { display: none !important; }
          .summary-sheet thead { display: table-header-group; }
          .print-row { break-inside: avoid; page-break-inside: avoid; }
          .print-section h2 { break-after: avoid; page-break-after: avoid; }
          @page { size: letter; margin: 0.5in; }
        }
      `}</style>
    </article>
  );
}

function PodiumRow({ podium }: { podium: Podium }) {
  const pal = medalPalette(podium.place);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
      <span
        style={{
          flex: "0 0 auto",
          minWidth: 62,
          textAlign: "center",
          background: pal.bg,
          color: pal.color,
          border: `1px solid ${pal.border}`,
          borderRadius: 4,
          fontFamily: headingFontStack,
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          padding: "3px 8px",
        }}
      >
        {pal.label}
      </span>
      <span style={{ fontSize: 14, fontWeight: podium.place === "gold" ? 700 : 500, minWidth: 0, overflowWrap: "anywhere" }}>
        {podium.team}
      </span>
    </div>
  );
}

// Same pairings as the event console's standings podium.
function medalPalette(place: Podium["place"]): { bg: string; color: string; border: string; label: string } {
  switch (place) {
    case "gold":
      return { bg: warnBg, color: warnFg, border: creamDeep, label: "Gold" };
    case "silver":
      return { bg: bg, color: inkSoft, border: rule, label: "Silver" };
    case "bronze":
      return { bg: dangerBg, color: dangerFg, border: courtRed, label: "Bronze" };
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// ── Styles ──────────────────────────────────────────────────────────

const sheet: CSSProperties = {
  background: "#fff",
  color: ink,
  fontFamily: bodyFontStack,
  border: `1px solid ${rule}`,
  borderRadius: 12,
  padding: "clamp(18px, 4vw, 36px)",
  maxWidth: 820,
};

const eyebrow: CSSProperties = {
  fontFamily: headingFontStack,
  fontSize: 12,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: courtGreen,
  marginBottom: 4,
};

const title: CSSProperties = {
  fontFamily: displayFontStack,
  fontSize: "clamp(24px, 4.5vw, 34px)",
  lineHeight: 1.1,
  margin: "0 0 6px",
  overflowWrap: "anywhere",
};

const h2: CSSProperties = {
  fontFamily: headingFontStack,
  fontSize: 17,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  margin: "0 0 10px",
  color: ink,
};

const noteBox: CSSProperties = {
  background: cream,
  border: `1px solid ${ruleSoft}`,
  borderRadius: 8,
  padding: "12px 14px",
};

const tileGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
  gap: 10,
};

const tile: CSSProperties = {
  border: `1px solid ${rule}`,
  borderRadius: 8,
  padding: "12px 12px 10px",
  background: "#fff",
  minWidth: 0,
};

const tileValue: CSSProperties = {
  fontFamily: displayFontStack,
  fontSize: 26,
  lineHeight: 1.1,
  color: ink,
  overflowWrap: "anywhere",
};

const tileLabel: CSSProperties = {
  fontFamily: headingFontStack,
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: inkSoft,
  marginTop: 6,
};

const tileSub: CSSProperties = { fontSize: 12, color: inkMuted, marginTop: 2 };

const eventCard: CSSProperties = {
  border: `1px solid ${rule}`,
  borderRadius: 8,
  padding: "12px 14px",
};

const eventHead: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 12,
  flexWrap: "wrap",
};

const eventName: CSSProperties = {
  fontFamily: headingFontStack,
  fontSize: 17,
  letterSpacing: "0.02em",
  overflowWrap: "anywhere",
};

const eventMeta: CSSProperties = { fontSize: 12.5, color: inkMuted, whiteSpace: "nowrap" };

const podiumWrap: CSSProperties = { display: "grid", gap: 6, marginTop: 10 };

const highlightGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
  gap: 10,
};

const highlight: CSSProperties = {
  background: cream,
  border: `1px solid ${ruleSoft}`,
  borderRadius: 8,
  padding: "10px 12px",
  minWidth: 0,
};

const highlightLabel: CSSProperties = {
  fontFamily: headingFontStack,
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: inkSoft,
};

const highlightValue: CSSProperties = {
  fontSize: 17,
  fontWeight: 700,
  marginTop: 2,
  overflowWrap: "anywhere",
};

const highlightDetail: CSSProperties = { fontSize: 12.5, color: inkSoft, marginTop: 3, lineHeight: 1.45 };

const th: CSSProperties = {
  textAlign: "left",
  fontFamily: headingFontStack,
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: inkSoft,
  padding: "4px 8px 6px",
  fontWeight: 500,
};

const td: CSSProperties = { padding: "7px 8px", verticalAlign: "top" };
