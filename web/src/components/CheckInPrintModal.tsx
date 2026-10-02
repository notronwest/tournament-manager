import { useEffect, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  ruleSoft,
  courtBlue,
  courtGreen,
  bodyFontStack,
  headingFontStack,
  panelStyle,
  ctaPrimaryStyle,
  ghostButtonStyle,
} from "../lib/publicTheme";
import type { CheckInRosterEntry } from "../lib/checkin";

// "Print check-in sheet" — the in-app version of backups/checkin-sheet.html: a
// master roster, every player A–Z by last name with their events and a check
// box, for the front desk to run off paper as a backstop. Follows
// RosterExportModal / SchedulePrintModal: portaled to <body> so the print
// rules can strip every sibling (no sidebar, header, buttons), US Letter,
// rows that never split across a page. Print / Save as PDF is the OS dialog.
export function CheckInPrintModal({
  tournamentName,
  startsAt,
  entries,
  onClose,
}: {
  tournamentName: string;
  startsAt: string | null;
  entries: CheckInRosterEntry[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dayLabel = startsAt
    ? new Date(startsAt).toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;

  const regCount = entries.reduce((n, e) => n + e.events.length, 0);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="checkin-print-title"
      onClick={onClose}
      style={overlay}
      data-checkin-print
    >
      <div onClick={(e) => e.stopPropagation()} style={sheet} className="checkin-sheet">
        <div style={toolbar} className="no-print">
          <div style={{ minWidth: 0 }}>
            <h2 id="checkin-print-title" style={headingStyle}>
              Print the check-in sheet
            </h2>
            <p style={{ margin: "6px 0 0", fontSize: 13, color: inkSoft, lineHeight: 1.5 }}>
              Every player A–Z with their events and a box. Find the player,
              check the box — that checks them in for every event listed. This
              is exactly what prints.
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
        </div>

        {/* The document itself — the only thing that prints. */}
        <div id="checkin-document" style={documentStyle}>
          <div style={{ borderBottom: `3px solid ${ink}`, paddingBottom: 8, marginBottom: 6 }}>
            <h1 style={docTitle}>Player Check-In</h1>
            <div style={docSub}>
              {tournamentName}
              {dayLabel ? ` · ${dayLabel}` : ""}
            </div>
          </div>
          <div style={instr}>
            Find the player · check the box · that checks them in for every event listed
          </div>

          {entries.length === 0 ? (
            <p style={{ color: inkMuted, fontSize: 14 }}>Nobody is registered yet.</p>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, width: 26 }}></th>
                  <th style={{ ...thStyle, width: 30 }}>#</th>
                  <th style={thStyle}>Player</th>
                  <th style={thStyle}>Events</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr
                    key={e.playerId}
                    className="checkin-row"
                    style={i % 2 === 1 ? { background: "#f7f4ea" } : undefined}
                  >
                    <td style={boxCell}>
                      <span style={boxMark} />
                    </td>
                    <td style={numCell}>{i + 1}</td>
                    <td style={nameCell}>{e.fullName}</td>
                    <td style={eventsCell}>{e.events.map((ev) => ev.name).join(" · ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div style={countLine}>
            {entries.length} player{entries.length === 1 ? "" : "s"} ·{" "}
            {regCount} registration{regCount === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      {/* Print isolation — everything but the document is removed from the
          layout (not merely hidden), so the sheet starts on page 1 and flows
          across as many pages as it needs. */}
      <style>{`
        @media print {
          body > *:not([data-checkin-print]) { display: none !important; }
          [data-checkin-print] {
            position: static !important;
            overflow: visible !important;
            background: none !important;
            padding: 0 !important;
          }
          [data-checkin-print] .no-print { display: none !important; }
          .checkin-sheet {
            max-width: none !important;
            border: none !important;
            box-shadow: none !important;
            border-radius: 0 !important;
            padding: 0 !important;
          }
          #checkin-document {
            max-height: none !important;
            overflow: visible !important;
            border: none !important;
            border-radius: 0 !important;
            padding: 0 !important;
          }
          .checkin-row { break-inside: avoid; page-break-inside: avoid; }
          @page { size: letter portrait; margin: 0.4in; }
        }
      `}</style>
    </div>,
    document.body,
  );
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
  maxWidth: 720,
  margin: 0,
  fontFamily: bodyFontStack,
  color: ink,
};

const toolbar: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  marginBottom: 14,
};

const headingStyle: CSSProperties = {
  fontFamily: headingFontStack,
  fontSize: 16,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  margin: 0,
  color: courtBlue,
};

const actionRow: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  flexWrap: "wrap",
  paddingBottom: 14,
  marginBottom: 14,
  borderBottom: `1px solid ${ruleSoft}`,
};

const documentStyle: CSSProperties = {
  maxHeight: "60vh",
  overflowY: "auto",
  background: "#fff",
  border: `1px solid ${ruleSoft}`,
  borderRadius: 8,
  padding: 20,
};

const docTitle: CSSProperties = {
  fontFamily: headingFontStack,
  fontSize: 22,
  fontWeight: 800,
  margin: 0,
  letterSpacing: "-0.3px",
  color: ink,
};

const docSub: CSSProperties = {
  fontSize: 12,
  color: inkMuted,
  marginTop: 2,
};

const instr: CSSProperties = {
  fontSize: 11,
  color: courtGreen,
  fontWeight: 700,
  margin: "8px 0 10px",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

const thStyle: CSSProperties = {
  fontSize: 9,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  color: inkMuted,
  textAlign: "left",
  padding: "3px 6px",
  borderBottom: `1px solid ${rule}`,
};

const boxCell: CSSProperties = { padding: "4px 6px", borderBottom: `1px solid ${rule}` };

const boxMark: CSSProperties = {
  display: "inline-block",
  width: 15,
  height: 15,
  border: `1.5px solid ${ink}`,
  borderRadius: 3,
  verticalAlign: "middle",
};

const numCell: CSSProperties = {
  padding: "4px 6px",
  borderBottom: `1px solid ${rule}`,
  color: inkMuted,
  fontSize: 10,
  textAlign: "right",
};

const nameCell: CSSProperties = {
  padding: "4px 6px",
  borderBottom: `1px solid ${rule}`,
  fontSize: 12,
  fontWeight: 700,
  whiteSpace: "nowrap",
};

const eventsCell: CSSProperties = {
  padding: "4px 6px",
  borderBottom: `1px solid ${rule}`,
  color: inkMuted,
  fontSize: 10.5,
};

const countLine: CSSProperties = {
  fontSize: 11,
  color: inkMuted,
  marginTop: 10,
};
