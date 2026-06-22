import { useEffect, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../../supabase";
import {
  usePartnerInvites,
  type PendingPartnerInvite,
} from "../../components/PartnerInvitesContext";
import { ConfirmModal } from "../../components/ConfirmModal";
import {
  contentColStyle,
  courtBlue,
  displayFontStack,
  ink,
  inkSoft,
  inkMuted,
  pageWrapStyle,
} from "../../lib/publicTheme";

// Post-login landing for pending partner invites (#— surfaced after a
// genuine sign-in by PartnerInviteOnboarding, and reachable any time from
// the global banner). Lists every pending invite the signed-in player has,
// each with "Review invite" (routes to the existing accept/decline flow,
// which owns pairing + checkout context) and a quick inline Decline.
//
// The page reads from the already-loaded PartnerInvitesContext — no new
// fetch — and refreshes it after a decline so the list (and the global
// banner) stay in sync. When the list empties, we send the player on to
// My Tournaments rather than showing a bare empty screen.
export default function PartnerInvitesPage() {
  const { invites, refresh } = usePartnerInvites();
  const navigate = useNavigate();
  const [declining, setDeclining] = useState<PendingPartnerInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Once the provider has loaded and there's nothing pending, there's no
  // reason to sit on this page — bounce to My Tournaments. Guard on
  // `invites === null` (still loading) so we don't redirect prematurely.
  useEffect(() => {
    if (invites !== null && invites.length === 0) {
      navigate("/my-tournaments", { replace: true });
    }
  }, [invites, navigate]);

  const onConfirmDecline = async () => {
    if (!declining) return;
    setBusy(true);
    setError(null);
    const { error: rpcErr } = await supabase.rpc("decline_partner_invite", {
      p_invite_id: declining.inviteId,
    });
    setBusy(false);
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    setDeclining(null);
    await refresh();
  };

  if (invites === null) {
    return (
      <Shell>
        <p style={{ color: inkMuted, fontSize: 14 }}>Loading…</p>
      </Shell>
    );
  }
  if (invites.length === 0) {
    // Redirect effect is firing; render nothing meaningful in the meantime.
    return <Shell>{null}</Shell>;
  }

  const multiple = invites.length > 1;

  return (
    <Shell>
      <div
        style={{
          fontSize: 12,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "#a16207",
          fontWeight: 600,
          marginBottom: 10,
        }}
      >
        Partner {multiple ? "invites" : "invite"}
      </div>
      <h1
        style={{
          fontFamily: displayFontStack,
          fontSize: "clamp(28px, 5vw, 38px)",
          lineHeight: 1.05,
          letterSpacing: "-0.5px",
          margin: "0 0 12px",
          color: ink,
        }}
      >
        {multiple
          ? "You've got partner invites"
          : "You've got a partner invite"}
      </h1>
      <p
        style={{
          fontSize: 15,
          lineHeight: 1.55,
          color: inkSoft,
          margin: "0 0 22px",
        }}
      >
        {multiple
          ? "These players want you as their doubles partner. Review each to lock in your spot — you can always find them under My Tournaments."
          : "Someone wants you as their doubles partner. Review it to lock in your spot — you'll also find it under My Tournaments."}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {invites.map((inv) => (
          <div key={inv.inviteId} style={inviteCard}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={avatarStyle}>{initialsFor(inv.inviterName)}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 16, color: ink, lineHeight: 1.3 }}>
                  <strong>{inv.inviterName}</strong> invited you
                </div>
                <div style={{ fontSize: 13, color: inkMuted, marginTop: 3 }}>
                  {inv.eventName}
                </div>
              </div>
            </div>

            <div style={tournamentRow}>{inv.tournamentName}</div>

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <Link
                to={`/t/${inv.orgSlug}/${inv.tournamentSlug}/invites/${inv.token}`}
                style={reviewBtn}
              >
                Review invite →
              </Link>
              <button
                type="button"
                onClick={() => setDeclining(inv)}
                style={declineBtn}
              >
                Decline
              </button>
            </div>
          </div>
        ))}
      </div>

      <div style={{ textAlign: "center", marginTop: 22 }}>
        <Link
          to="/my-tournaments"
          style={{ color: inkMuted, fontSize: 14, textDecoration: "underline" }}
        >
          Not now — take me to my tournaments
        </Link>
      </div>

      {declining && (
        <ConfirmModal
          title="Decline this invite?"
          body={
            <>
              You're about to decline <strong>{declining.inviterName}</strong>'s
              invite for <strong>{declining.eventName}</strong>. They'll need to
              pick a different partner. This can't be undone.
              {error && (
                <span style={{ display: "block", color: "#b91c1c", marginTop: 8 }}>
                  {error}
                </span>
              )}
            </>
          }
          confirmLabel={busy ? "Declining…" : "Confirm decline"}
          onCancel={() => {
            if (!busy) {
              setDeclining(null);
              setError(null);
            }
          }}
          onConfirm={onConfirmDecline}
        />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={pageWrapStyle}>
      <main style={contentColStyle(560)}>{children}</main>
    </div>
  );
}

function initialsFor(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?"
  );
}

const inviteCard: CSSProperties = {
  background: "#fffbeb",
  border: "1.5px solid #fde68a",
  borderRadius: 12,
  padding: "18px 18px 16px",
};

const avatarStyle: CSSProperties = {
  width: 46,
  height: 46,
  flexShrink: 0,
  borderRadius: "50%",
  background: ink,
  color: "#fff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 600,
  fontSize: 15,
};

const tournamentRow: CSSProperties = {
  borderTop: "0.5px solid #fde68a",
  margin: "14px 0 0",
  paddingTop: 12,
  fontSize: 13,
  color: "#92400e",
};

const reviewBtn: CSSProperties = {
  flex: 1,
  background: courtBlue,
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "11px 16px",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  textAlign: "center",
  textDecoration: "none",
};

const declineBtn: CSSProperties = {
  background: "transparent",
  color: "#9a3412",
  border: "1px solid #e7c9a3",
  borderRadius: 8,
  padding: "11px 18px",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};
