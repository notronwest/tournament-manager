import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  fetchPendingPartnerInvites,
  resendPartnerInvite,
  type PendingInvite,
} from "../../lib/partnerInvites";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  ruleSoft,
  courtGreen,
  warnBg,
  warnFg,
  bodyFontStack,
  headingFontStack,
} from "../../lib/publicTheme";

type SendState = "idle" | "sending" | "sent" | "error";

// "Pending partner invites" — partners invited to a doubles event who haven't
// accepted yet (invite still pending), with a one-click / bulk Resend. Renders
// nothing when there are none. Lives on the tournament Attendees page.
export default function PendingPartnerInvitesPanel({ tournamentId }: { tournamentId: string }) {
  const [invites, setInvites] = useState<PendingInvite[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, setState] = useState<Record<string, SendState>>({});
  const [errById, setErrById] = useState<Record<string, string>>({});
  const [bulkRunning, setBulkRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchPendingPartnerInvites(tournamentId);
        if (cancelled) return;
        setInvites(data);
        setLoadError(null);
      } catch (e) {
        if (cancelled) return;
        setLoadError((e as { message?: string })?.message ?? "Could not load pending invites.");
        setInvites([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tournamentId]);

  const emailable = useMemo(() => (invites ?? []).filter((i) => i.inviteeEmail), [invites]);
  const baseUrl = window.location.origin;

  async function resendOne(inv: PendingInvite): Promise<boolean> {
    setState((s) => ({ ...s, [inv.inviteId]: "sending" }));
    setErrById((e) => ({ ...e, [inv.inviteId]: "" }));
    try {
      await resendPartnerInvite(inv.inviteId, baseUrl);
      setState((s) => ({ ...s, [inv.inviteId]: "sent" }));
      return true;
    } catch (e) {
      setState((s) => ({ ...s, [inv.inviteId]: "error" }));
      setErrById((prev) => ({ ...prev, [inv.inviteId]: (e as { message?: string })?.message ?? "Failed" }));
      return false;
    }
  }

  async function resendSelected() {
    const targets = emailable.filter((i) => selected.has(i.inviteId));
    if (targets.length === 0) return;
    setBulkRunning(true);
    try {
      // Sequential to stay gentle on the email function and give clear per-row status.
      for (const inv of targets) {
        await resendOne(inv);
      }
      setSelected(new Set());
    } finally {
      setBulkRunning(false);
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllVisible() {
    setSelected((prev) => {
      const allOn = emailable.length > 0 && emailable.every((i) => prev.has(i.inviteId));
      const next = new Set(prev);
      if (allOn) emailable.forEach((i) => next.delete(i.inviteId));
      else emailable.forEach((i) => next.add(i.inviteId));
      return next;
    });
  }

  // Nothing to show → render nothing (keeps the page clean when all is well).
  if (invites === null || (invites.length === 0 && !loadError)) return null;

  const allVisibleSelected = emailable.length > 0 && emailable.every((i) => selected.has(i.inviteId));

  return (
    <section
      style={{
        padding: "14px 16px",
        marginBottom: 20,
        background: warnBg,
        border: `1px solid ${warnFg}33`,
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, fontFamily: headingFontStack, color: warnFg, marginBottom: 4 }}>
        ✉️ Pending partner invites ({invites.length})
      </div>
      <div style={{ fontSize: 12, color: warnFg, marginBottom: 12, lineHeight: 1.5, maxWidth: 640 }}>
        Partners who were invited but haven't accepted yet. If an invite email never
        reached them, resend it — this re-sends to the address on the invite.
      </div>

      {loadError && (
        <div style={{ fontSize: 13, color: "#9c2412", marginBottom: 12 }} role="alert">{loadError}</div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: warnFg }}>
          {selected.size > 0 ? `${selected.size} selected` : `${emailable.length} with an email address`}
        </div>
        <button
          onClick={resendSelected}
          disabled={selected.size === 0 || bulkRunning}
          style={{
            ...btn,
            opacity: selected.size === 0 || bulkRunning ? 0.5 : 1,
            cursor: selected.size === 0 || bulkRunning ? "default" : "pointer",
          }}
        >
          {bulkRunning ? "Resending…" : "Resend selected"}
        </button>
      </div>

      <div style={{ overflowX: "auto", background: "#fff", borderRadius: 6, border: `1px solid ${warnFg}22` }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 640 }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 32, textAlign: "center" }}>
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} disabled={emailable.length === 0} style={{ width: 14, height: 14 }} />
              </th>
              <th style={th}>Partner (invitee)</th>
              <th style={th}>Invited by</th>
              <th style={th}>Event</th>
              <th style={th}>Inviter</th>
              <th style={th}>Invited</th>
              <th style={{ ...th, textAlign: "right" }}></th>
            </tr>
          </thead>
          <tbody>
            {(invites ?? []).map((inv) => {
              const st = state[inv.inviteId] ?? "idle";
              const hasEmail = !!inv.inviteeEmail;
              return (
                <tr key={inv.inviteId} style={{ borderTop: `1px solid ${ruleSoft}` }}>
                  <td style={{ ...td, textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={selected.has(inv.inviteId)}
                      disabled={!hasEmail}
                      onChange={() => toggleOne(inv.inviteId)}
                      title={hasEmail ? undefined : "No email on this invite — can't resend"}
                      style={{ width: 14, height: 14 }}
                    />
                  </td>
                  <td style={td}>
                    <div style={{ fontWeight: 500 }}>{inv.inviteeName}</div>
                    <div style={{ color: hasEmail ? inkSoft : "#9c2412", fontSize: 12 }}>
                      {inv.inviteeEmail ?? "no email"}
                    </div>
                  </td>
                  <td style={td}>{inv.inviterName}</td>
                  <td style={td}>{inv.eventName}</td>
                  <td style={td}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: inv.inviterPaid ? "#e8f5ea" : "#fff3e0",
                        color: inv.inviterPaid ? "#2c7a3d" : "#8a5a00",
                      }}
                    >
                      {inv.inviterPaid ? "Paid" : inv.inviterStatus ? labelStatus(inv.inviterStatus) : "No reg"}
                    </span>
                  </td>
                  <td style={{ ...td, color: inkMuted }}>{fmtDate(inv.createdAt)}</td>
                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                    {st === "sent" ? (
                      <span style={{ color: courtGreen, fontWeight: 600, fontSize: 12 }}>✓ Sent</span>
                    ) : (
                      <button
                        onClick={() => void resendOne(inv)}
                        disabled={!hasEmail || st === "sending"}
                        style={{ ...btn, padding: "4px 10px", opacity: hasEmail && st !== "sending" ? 1 : 0.5, cursor: hasEmail && st !== "sending" ? "pointer" : "default" }}
                      >
                        {st === "sending" ? "Sending…" : st === "error" ? "Retry" : "Resend"}
                      </button>
                    )}
                    {st === "error" && errById[inv.inviteId] && (
                      <div style={{ color: "#9c2412", fontSize: 11, marginTop: 2 }}>{errById[inv.inviteId]}</div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function labelStatus(s: string): string {
  if (s === "pending_payment") return "Unpaid";
  if (s === "waitlisted" || s === "waitlisted_pending_payment") return "Waitlisted";
  if (s === "refunded") return "Refunded";
  if (s === "cancelled") return "Cancelled";
  if (s === "withdrawn") return "Withdrawn";
  return s;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const btn: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  padding: "6px 12px",
  borderRadius: 6,
  border: `1px solid ${rule}`,
  background: "#fff",
  color: ink,
  cursor: "pointer",
  fontFamily: bodyFontStack,
};

const th: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  fontSize: 11,
  color: inkMuted,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  fontWeight: 700,
  fontFamily: headingFontStack,
  whiteSpace: "nowrap",
};

const td: CSSProperties = { padding: "8px 10px", verticalAlign: "middle", color: ink };
