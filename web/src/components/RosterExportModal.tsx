import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  buildRoster,
  eventsWhere,
  rosterToCsv,
  downloadCsv,
  rosterFilename,
  type Roster,
  type RosterEntry,
  type RosterEventGroup,
} from "../lib/rosterExport";
import { fetchPendingPartnerInvites } from "../lib/partnerInvites";
import {
  ink,
  inkSoft,
  inkMuted,
  cream,
  rule,
  ruleSoft,
  courtBlue,
  bodyFontStack,
  headingFontStack,
  panelStyle,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
  ghostButtonStyle,
  statusPanelStyle,
} from "../lib/publicTheme";

// "Download the list" for organizers who want paper, not a screen. Shows the
// finished document on screen first — what you see here is exactly what prints
// — because a hidden print-only block gives a non-technical user no idea what
// they're about to get.
//
// Two ways out, deliberately ordered: Print / Save as PDF is the 90% case (a
// sheet for the check-in table); the spreadsheet is for people who want to
// sort it.
export function RosterExportModal({
  tournamentId,
  tournamentName,
  groups,
  onClose,
}: {
  tournamentId: string;
  tournamentName: string;
  groups: RosterEventGroup[];
  onClose: () => void;
}) {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pending invites are the only thing not already in memory — they're what
  // turns "waiting to hear back" into "waiting to hear back from Dana Reyes".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let invites: Awaited<ReturnType<typeof fetchPendingPartnerInvites>> = [];
      try {
        invites = await fetchPendingPartnerInvites(tournamentId);
      } catch {
        // Non-fatal: the roster is still correct, it just can't name the
        // person each invite went to.
        if (!cancelled) setError("Couldn't load who each invite went to — the rest of the list is complete.");
      }
      if (!cancelled) setRoster(buildRoster(tournamentName, groups, invites));
    })();
    return () => {
      cancelled = true;
    };
  }, [tournamentId, tournamentName, groups]);

  // Escape closes, matching the rest of the admin modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onDownload = () => {
    if (!roster) return;
    downloadCsv(
      rosterFilename(tournamentName, new Date()),
      rosterToCsv(roster),
    );
  };

  const printedOn = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Portaled to <body> so the print rules can hide every sibling outright.
  // Isolating with `visibility` instead (the pattern in quotes/ContractPage)
  // leaves the hidden app still occupying space, which prints as blank pages
  // ahead of the roster — fine for a one-page contract, wrong for a list that
  // can run to several sheets.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="roster-export-title"
      onClick={onClose}
      style={overlay}
      data-roster-print
    >
      <div onClick={(e) => e.stopPropagation()} style={sheet} className="roster-sheet">
        {/* Toolbar — never printed */}
        <div style={toolbar} className="no-print">
          <div style={{ minWidth: 0 }}>
            <h2 id="roster-export-title" style={headingStyle}>
              Download the attendee list
            </h2>
            <p style={{ margin: "6px 0 0", fontSize: 13, color: inkSoft, lineHeight: 1.5 }}>
              Everyone signed up with their contact details, who still needs a
              partner, and who's waiting to hear back. This is exactly what
              prints.
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

        {error && (
          <div style={{ ...statusPanelStyle("warn"), margin: "0 0 14px" }} className="no-print">
            {error}
          </div>
        )}

        <div style={actionRow} className="no-print">
          <button
            onClick={() => window.print()}
            disabled={!roster}
            style={{ ...ctaPrimaryStyle, opacity: roster ? 1 : 0.6 }}
          >
            Print / Save as PDF
          </button>
          <button
            onClick={onDownload}
            disabled={!roster}
            style={{ ...ctaSecondaryStyle, opacity: roster ? 1 : 0.6 }}
          >
            Download spreadsheet
          </button>
          <span style={{ fontSize: 11.5, color: inkMuted }}>
            The spreadsheet opens in Excel or Google Sheets.
          </span>
        </div>

        {/* The document itself — the only thing that prints. */}
        <div id="roster-document" style={documentStyle}>
          {!roster ? (
            <p style={{ color: inkMuted, fontSize: 14 }}>Building the list…</p>
          ) : (
            <>
              <div style={{ marginBottom: 20 }}>
                <h1 style={docTitle}>{roster.tournamentName}</h1>
                <div style={docSub}>
                  Attendee list · {roster.everyone.length}{" "}
                  {roster.everyone.length === 1 ? "player" : "players"} ·{" "}
                  {printedOn}
                </div>
              </div>

              <DocSection
                title="Still needs a partner"
                blurb="Signed up for a doubles event with nobody lined up. Pair these people up first."
                count={roster.needsPartner.length}
                emptyLabel="Nobody is waiting for a partner."
              >
                {roster.needsPartner.map((e) => (
                  <PersonLine
                    key={e.playerId}
                    entry={e}
                    detail={eventsWhere(e, "seeking")
                      .map((ev) => ev.eventName)
                      .join(", ")}
                    detailLabel="Needs a partner in"
                  />
                ))}
              </DocSection>

              <DocSection
                title="Waiting to hear back"
                blurb="They asked someone specific to partner with them, and that person hasn't answered yet."
                count={roster.awaitingReply.length}
                emptyLabel="Nobody is waiting on an answer."
              >
                {roster.awaitingReply.map((e) => (
                  <PersonLine
                    key={e.playerId}
                    entry={e}
                    detail={eventsWhere(e, "pending")
                      .map((ev) =>
                        ev.invitedName
                          ? `${ev.invitedName} (${ev.eventName})`
                          : ev.eventName,
                      )
                      .join(", ")}
                    detailLabel="Asked"
                  />
                ))}
              </DocSection>

              <DocSection
                title="Everyone signed up"
                blurb="In alphabetical order by last name."
                count={roster.everyone.length}
                emptyLabel="Nobody has signed up yet."
              >
                {roster.everyone.map((e) => (
                  <PersonLine
                    key={e.playerId}
                    entry={e}
                    detail={e.events
                      .map((ev) =>
                        ev.partnerName
                          ? `${ev.eventName} — with ${ev.partnerName}`
                          : ev.eventName,
                      )
                      .join(", ")}
                    detailLabel="Playing in"
                    payment={[...new Set(e.events.map((ev) => ev.paymentLabel))].join(", ")}
                  />
                ))}
              </DocSection>
            </>
          )}
        </div>
      </div>

      {/* Print isolation — everything but the document is removed from the
          layout (not merely hidden), so the roster starts on page 1 and flows
          across as many sheets as it needs. */}
      <style>{`
        @media print {
          body > *:not([data-roster-print]) { display: none !important; }
          [data-roster-print] {
            position: static !important;
            overflow: visible !important;
            background: none !important;
            padding: 0 !important;
          }
          [data-roster-print] .no-print { display: none !important; }
          .roster-sheet {
            max-width: none !important;
            border: none !important;
            box-shadow: none !important;
            border-radius: 0 !important;
            padding: 0 !important;
          }
          #roster-document {
            max-height: none !important;
            overflow: visible !important;
            border: none !important;
            border-radius: 0 !important;
            padding: 0 !important;
          }
          .roster-person { break-inside: avoid; page-break-inside: avoid; }
          .roster-section-head { break-after: avoid; page-break-after: avoid; }
          @page { size: letter; margin: 0.5in; }
        }
      `}</style>
    </div>,
    document.body,
  );
}

function DocSection({
  title,
  blurb,
  count,
  emptyLabel,
  children,
}: {
  title: string;
  blurb: string;
  count: number;
  emptyLabel: string;
  children: ReactNode;
}) {
  return (
    <section style={{ marginBottom: 26 }} className="roster-section">
      <div className="roster-section-head">
        <h2 style={sectionTitle}>
          {title}
          <span style={{ color: inkMuted, fontWeight: 400 }}> · {count}</span>
        </h2>
        <p style={sectionBlurb}>{blurb}</p>
      </div>
      {count === 0 ? (
        <p style={{ ...sectionBlurb, fontStyle: "italic" }}>{emptyLabel}</p>
      ) : (
        <div>{children}</div>
      )}
    </section>
  );
}

// One person, printed as a labelled block rather than a table row — a table
// wide enough for name + email + phone + events doesn't survive a portrait
// page or a 390px screen.
function PersonLine({
  entry,
  detail,
  detailLabel,
  payment,
}: {
  entry: RosterEntry;
  detail: string;
  detailLabel: string;
  payment?: string;
}) {
  const contact = [entry.email, entry.phone].filter(Boolean).join(" · ");
  return (
    <div style={personRow} className="roster-person">
      <div style={{ fontWeight: 700, color: ink, fontSize: 14 }}>
        {entry.lastName}, {entry.firstName}
        {payment ? (
          <span style={{ fontWeight: 400, color: inkMuted, fontSize: 12 }}>
            {" "}· {payment}
          </span>
        ) : null}
      </div>
      <div style={{ fontSize: 13, color: contact ? inkSoft : inkMuted, marginTop: 2 }}>
        {contact || "No email or phone on file"}
      </div>
      {detail && (
        <div style={{ fontSize: 12.5, color: inkSoft, marginTop: 2 }}>
          <span style={{ color: inkMuted }}>{detailLabel}:</span> {detail}
        </div>
      )}
    </div>
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
  margin: 0,
  fontSize: 20,
  fontFamily: headingFontStack,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: ink,
};

const docSub: CSSProperties = {
  fontSize: 12.5,
  color: inkMuted,
  marginTop: 4,
};

const sectionTitle: CSSProperties = {
  margin: "0 0 2px",
  fontSize: 14,
  fontFamily: headingFontStack,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: ink,
  borderTop: `2px solid ${ink}`,
  paddingTop: 8,
};

const sectionBlurb: CSSProperties = {
  margin: "0 0 10px",
  fontSize: 12,
  color: inkMuted,
  lineHeight: 1.5,
};

const personRow: CSSProperties = {
  padding: "7px 0",
  borderBottom: `1px solid ${cream}`,
};
