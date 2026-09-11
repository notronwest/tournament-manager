import { useEffect, useMemo, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  ruleSoft,
  courtBlue,
  bodyFontStack,
  headingFontStack,
  panelStyle,
  ctaPrimaryStyle,
  ghostButtonStyle,
} from "../lib/publicTheme";
import { fmtDuration } from "../lib/estimator";

// What the Schedule page hands us: one row per event with its placed phases.
export type PrintPhase = { kind: "pool" | "medal"; start: Date; end: Date; courts: number[] };
export type PrintRow = {
  id: string;
  name: string;
  formatLine: string;
  teamCount: number;
  totalMinutes: number;
  start: Date | null;
  end: Date | null;
  courtNumbers: number[];
  phases: PrintPhase[];
};

// "Print schedule" — a finished sheet, previewed on screen exactly as it
// prints, following RosterExportModal: portaled to <body> so the print rules
// can remove every sibling (no sidebar, header, buttons or widgets), US
// Letter, half-inch margins, rows that never split across pages. Print /
// Save as PDF is the OS dialog — that is the PDF.
export function SchedulePrintModal({
  tournamentName,
  startsAt,
  endsAt,
  venueName,
  courtCount,
  rows,
  onClose,
}: {
  tournamentName: string;
  startsAt: string | null;
  endsAt: string | null;
  venueName: string | null;
  courtCount: number;
  rows: PrintRow[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const scheduled = useMemo(
    () => rows.filter((r) => r.start && r.end).sort((a, b) => a.start!.getTime() - b.start!.getTime()),
    [rows],
  );
  const unscheduled = useMemo(() => rows.filter((r) => !r.start), [rows]);

  // Court-by-court rundown: every phase touching that court, in time order.
  const byCourt = useMemo(() => {
    const out: { court: number; items: { row: PrintRow; phase: PrintPhase }[] }[] = [];
    for (let c = 1; c <= courtCount; c++) {
      const items = scheduled
        .flatMap((row) => row.phases.filter((ph) => ph.courts.includes(c)).map((phase) => ({ row, phase })))
        .sort((a, b) => a.phase.start.getTime() - b.phase.start.getTime());
      out.push({ court: c, items });
    }
    return out;
  }, [scheduled, courtCount]);

  const dayLine = fmtDateRange(startsAt, endsAt);
  const firstStart = scheduled[0]?.start ?? null;
  const lastEnd = scheduled.length ? new Date(Math.max(...scheduled.map((r) => r.end!.getTime()))) : null;
  const printedOn = new Date().toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="schedule-print-title"
      onClick={onClose}
      style={overlay}
      data-schedule-print
    >
      <div onClick={(e) => e.stopPropagation()} style={sheet} className="schedule-sheet">
        <div style={toolbar} className="no-print">
          <div style={{ minWidth: 0 }}>
            <h2 id="schedule-print-title" style={headingStyle}>
              Print the schedule
            </h2>
            <p style={{ margin: "6px 0 0", fontSize: 13, color: inkSoft, lineHeight: 1.5 }}>
              Every event with its times and courts, then a court-by-court
              rundown for the desk. This is exactly what prints.
            </p>
          </div>
          <button
            onClick={onClose}
            style={{ ...ghostButtonStyle, color: inkMuted, textDecoration: "none", fontSize: 22, lineHeight: 1 }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div style={actionRow} className="no-print">
          <button onClick={() => window.print()} style={ctaPrimaryStyle}>
            Print / Save as PDF
          </button>
          <span style={{ fontSize: 11.5, color: inkMuted }}>
            Choose "Save as PDF" as the printer to get a file.
          </span>
        </div>

        <div id="schedule-document" style={documentStyle}>
          <header style={{ marginBottom: 18, borderBottom: `2px solid ${ink}`, paddingBottom: 10 }}>
            <h1 style={docTitle}>{tournamentName}</h1>
            <div style={docSub}>
              Schedule{dayLine ? ` · ${dayLine}` : ""}
              {venueName ? ` · ${venueName}` : ""} · {courtCount} court{courtCount === 1 ? "" : "s"}
              {firstStart && lastEnd ? ` · play ${fmtTime(firstStart)}–${fmtTime(lastEnd)}` : ""}
            </div>
            <div style={{ ...docSub, fontSize: 10.5 }}>Printed {printedOn}</div>
          </header>

          <section style={{ marginBottom: 22 }} className="print-section">
            <h2 style={sectionTitle}>Day schedule</h2>
            {scheduled.length === 0 ? (
              <p style={{ fontSize: 12, color: inkMuted, fontStyle: "italic" }}>No events have a start time yet.</p>
            ) : (
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>Time</th>
                    <th style={th}>Event</th>
                    <th style={th}>Pool play</th>
                    <th style={th}>Medal round</th>
                    <th style={{ ...th, textAlign: "right" }}>Teams</th>
                  </tr>
                </thead>
                <tbody>
                  {scheduled.map((r) => {
                    const pool = r.phases.find((p) => p.kind === "pool");
                    const medal = r.phases.find((p) => p.kind === "medal");
                    return (
                      <tr key={r.id} className="print-row" style={{ borderBottom: `1px solid ${ruleSoft}` }}>
                        <td style={{ ...td, whiteSpace: "nowrap", fontWeight: 600 }}>
                          {fmtTime(r.start!)}–{fmtTime(r.end!)}
                          <div style={{ fontWeight: 400, color: inkMuted, fontSize: 10.5 }}>{fmtDuration(r.totalMinutes)}</div>
                        </td>
                        <td style={td}>
                          <div style={{ fontWeight: 600 }}>{r.name}</div>
                          <div style={{ color: inkMuted, fontSize: 10.5 }}>{r.formatLine}</div>
                        </td>
                        <td style={td}>
                          {pool ? (
                            <>
                              {fmtTime(pool.start)}–{fmtTime(pool.end)}
                              <div style={{ color: inkMuted, fontSize: 10.5 }}>courts {fmtCourts(pool.courts)}</div>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td style={td}>
                          {medal ? (
                            <>
                              {fmtTime(medal.start)}–{fmtTime(medal.end)}
                              <div style={{ color: inkMuted, fontSize: 10.5 }}>courts {fmtCourts(medal.courts)}</div>
                            </>
                          ) : (
                            <span style={{ color: inkMuted }}>no playoff</span>
                          )}
                        </td>
                        <td style={{ ...td, textAlign: "right" }}>{r.teamCount}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {unscheduled.length > 0 && (
              <p style={{ fontSize: 11.5, color: inkMuted, margin: "8px 0 0" }}>
                Not yet scheduled: {unscheduled.map((r) => r.name).join(", ")}.
              </p>
            )}
          </section>

          {scheduled.length > 0 && (
            <section className="print-section">
              <h2 style={sectionTitle}>By court</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
                {byCourt.map(({ court, items }) => (
                  <div key={court} className="print-row" style={{ border: `1px solid ${rule}`, borderRadius: 6, padding: "8px 10px" }}>
                    <div style={{ fontFamily: headingFontStack, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                      Court {court}
                    </div>
                    {items.length === 0 ? (
                      <div style={{ fontSize: 11, color: inkMuted, fontStyle: "italic" }}>Free all day</div>
                    ) : (
                      items.map(({ row, phase }, i) => (
                        <div key={`${row.id}-${phase.kind}-${i}`} style={{ fontSize: 11.5, lineHeight: 1.5, display: "flex", gap: 8 }}>
                          <span style={{ whiteSpace: "nowrap", color: inkSoft, minWidth: 92 }}>
                            {fmtTime(phase.start)}–{fmtTime(phase.end)}
                          </span>
                          <span>
                            {row.name}
                            {phase.kind === "medal" ? <span style={{ color: inkMuted }}> · medals</span> : ""}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      <style>{`
        @media print {
          body > *:not([data-schedule-print]) { display: none !important; }
          [data-schedule-print] {
            position: static !important;
            overflow: visible !important;
            background: none !important;
            padding: 0 !important;
          }
          [data-schedule-print] .no-print { display: none !important; }
          .schedule-sheet {
            max-width: none !important;
            border: none !important;
            box-shadow: none !important;
            border-radius: 0 !important;
            padding: 0 !important;
          }
          #schedule-document {
            max-height: none !important;
            overflow: visible !important;
            border: none !important;
            border-radius: 0 !important;
            padding: 0 !important;
          }
          #schedule-document thead { display: table-header-group; }
          .print-row { break-inside: avoid; page-break-inside: avoid; }
          .print-section h2 { break-after: avoid; page-break-after: avoid; }
          @page { size: letter; margin: 0.5in; }
        }
      `}</style>
    </div>,
    document.body,
  );
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function fmtCourts(courts: number[]): string {
  if (courts.length === 0) return "—";
  const s = [...courts].sort((a, b) => a - b);
  const contiguous = s.every((c, i) => i === 0 || c === s[i - 1] + 1);
  return contiguous && s.length > 1 ? `${s[0]}–${s[s.length - 1]}` : s.join(", ");
}

function fmtDateRange(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt) return "";
  const a = new Date(startsAt);
  const b = endsAt ? new Date(endsAt) : a;
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric", year: "numeric" };
  const sameDay = a.toDateString() === b.toDateString();
  return sameDay ? a.toLocaleDateString(undefined, opts) : `${a.toLocaleDateString(undefined, { month: "long", day: "numeric" })} – ${b.toLocaleDateString(undefined, opts)}`;
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(20,24,31,0.45)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "32px 16px",
  zIndex: 1000,
  overflowY: "auto",
};
const sheet: CSSProperties = {
  ...panelStyle,
  background: "#ffffff",
  border: `1px solid ${rule}`,
  width: "100%",
  maxWidth: 860,
  margin: 0,
  fontFamily: bodyFontStack,
  color: ink,
};
const toolbar: CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 14 };
const headingStyle: CSSProperties = { fontFamily: headingFontStack, fontSize: 16, textTransform: "uppercase", letterSpacing: "0.06em", margin: 0, color: courtBlue };
const actionRow: CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", paddingBottom: 14, marginBottom: 14, borderBottom: `1px solid ${ruleSoft}` };
const documentStyle: CSSProperties = { maxHeight: "65vh", overflowY: "auto", background: "#fff", border: `1px solid ${ruleSoft}`, borderRadius: 8, padding: 20 };
const docTitle: CSSProperties = { margin: 0, fontFamily: headingFontStack, fontSize: 22, textTransform: "uppercase", letterSpacing: "0.04em", color: ink };
const docSub: CSSProperties = { marginTop: 4, fontSize: 12, color: inkSoft };
const sectionTitle: CSSProperties = { fontFamily: headingFontStack, fontSize: 13, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px", color: ink };
const table: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12 };
const th: CSSProperties = { textAlign: "left", padding: "6px 8px", fontSize: 10.5, color: inkMuted, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `2px solid ${ink}` };
const td: CSSProperties = { padding: "7px 8px", verticalAlign: "top" };
