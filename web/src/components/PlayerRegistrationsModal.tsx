import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  RegistrationEditorModal,
  type EditableRegistration,
} from "./RegistrationEditorModal";
import { fetchPlayerRegistrations, type PlayerReg } from "../lib/registrations";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  bodyFontStack,
  headingFontStack,
  panelStyle,
  panelMutedStyle,
  ghostButtonStyle,
  statusPanelStyle,
} from "../lib/publicTheme";

// A player's registrations across an org's tournaments, each with an "Edit" that
// opens the RegistrationEditorModal. Reached from the Contacts list ("Registrations")
// and the Attendees By-Player view ("Manage").
export function PlayerRegistrationsModal({
  orgId,
  playerId,
  playerName,
  onClose,
  onChanged,
}: {
  orgId: string;
  playerId: string;
  playerName: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [regs, setRegs] = useState<PlayerReg[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<EditableRegistration | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchPlayerRegistrations(orgId, playerId);
        if (cancelled) return;
        setRegs(data);
        setLoadError(null);
      } catch (e) {
        if (cancelled) return;
        setLoadError((e as { message?: string })?.message ?? "Could not load registrations.");
        setRegs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, playerId, reloadKey]);

  const toEditable = (r: PlayerReg): EditableRegistration => ({
    regId: r.regId,
    eventId: r.eventId,
    eventName: r.eventName,
    format: r.format,
    playerId,
    playerName,
    status: r.status,
    partnerStatus: r.partnerStatus,
    partnerRegId: r.partnerRegId,
    partnerName: r.partnerName,
    eventFeeCents: r.eventFeeCents,
    tournamentName: r.tournamentName,
  });

  return (
    <>
      <Shell title={`${playerName} — registrations`} onClose={onClose}>
        {loadError && (
          <div style={{ ...statusPanelStyle("danger"), marginBottom: 12 }} role="alert">
            {loadError}
          </div>
        )}
        {regs === null ? (
          <div style={{ color: inkMuted }}>Loading…</div>
        ) : regs.length === 0 ? (
          <div style={{ color: inkMuted, fontSize: 14 }}>
            {playerName} isn't registered for any events in this club yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {regs.map((r) => (
              <div key={r.regId} style={{ ...panelMutedStyle, padding: 12, display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: ink }}>{r.eventName}</div>
                  <div style={{ fontSize: 12, color: inkSoft, marginTop: 2 }}>
                    {r.tournamentName}
                    {r.partnerName ? ` · partner: ${r.partnerName}` : ""}
                  </div>
                </div>
                <button style={rowBtn} onClick={() => setEditing(toEditable(r))}>Edit</button>
              </div>
            ))}
          </div>
        )}
      </Shell>

      {editing && (
        <RegistrationEditorModal
          reg={editing}
          onClose={() => setEditing(null)}
          onChanged={() => {
            setReloadKey((k) => k + 1);
            onChanged?.();
          }}
        />
      )}
    </>
  );
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(20,24,31,0.45)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "40px 16px", zIndex: 1000, overflowY: "auto",
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ ...panelStyle, width: "100%", maxWidth: 520, margin: 0, fontFamily: bodyFontStack, color: ink }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h2 style={{ fontFamily: headingFontStack, fontSize: 16, textTransform: "uppercase", letterSpacing: "0.06em", margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ ...ghostButtonStyle, color: inkMuted, textDecoration: "none", fontSize: 20, lineHeight: 1 }} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const rowBtn: CSSProperties = { ...ghostButtonStyle, fontSize: 13, border: `1px solid ${rule}`, borderRadius: 6, padding: "5px 12px" };
