import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  deletePartnerInvites,
  fetchPendingPartnerInvites,
  pairInviteWithRegistration,
  resendPartnerInvite,
  type PendingInvite,
} from "../../lib/partnerInvites";
import { ConfirmModal } from "../../components/ConfirmModal";
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
type RowBusy = "pair" | "remove" | null;

// "Pending partner invites" — partners invited to a doubles event who haven't
// accepted yet (invite still pending). Each row says what has actually
// happened since: still waiting (resend), registered under another record
// (pair & clear), or already settled (clear). Renders nothing when there are
// none. Lives on the tournament Attendees page.
export default function PendingPartnerInvitesPanel({
  tournamentId,
  onChanged,
}: {
  tournamentId: string;
  /** Called after a pairing so the attendee list behind the panel refreshes. */
  onChanged?: () => void;
}) {
  const [invites, setInvites] = useState<PendingInvite[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, setState] = useState<Record<string, SendState>>({});
  const [errById, setErrById] = useState<Record<string, string>>({});
  const [rowBusy, setRowBusy] = useState<Record<string, RowBusy>>({});
  const [bulkRunning, setBulkRunning] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<PendingInvite[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
  }, [tournamentId, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  // Open first (actionable), then "registered" (one click to pair), then settled.
  const ordered = useMemo(() => {
    const rank = (i: PendingInvite) =>
      i.resolution.kind === "open" ? 0 : i.resolution.kind === "registered" ? 1 : 2;
    return [...(invites ?? [])].sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
  }, [invites]);
  const openCount = ordered.filter((i) => i.resolution.kind === "open").length;
  const settled = ordered.filter((i) => i.resolution.kind === "settled");
  const emailable = useMemo(
    () => ordered.filter((i) => i.inviteeEmail && i.resolution.kind === "open"),
    [ordered],
  );
  const baseUrl = window.location.origin;

  async function resendOne(inv: PendingInvite): Promise<boolean> {
    setState((s) => ({ ...s, [inv.inviteId]: "sending" }));
    setErrById((e) => ({ ...e, [inv.inviteId]: "" }));
    try {
      await resendPartnerInvite(inv.inviteId, baseUrl);
      setState((s) => ({ ...s, [inv.inviteId]: "sent" }));
      // The function stamped last_sent_at server-side; reflect it here so the
      // row's "Last sent" moves without a reload.
      const sentAt = new Date().toISOString();
      setInvites((list) =>
        list ? list.map((i) => (i.inviteId === inv.inviteId ? { ...i, lastSentAt: sentAt } : i)) : list,
      );
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

  async function pairOne(inv: PendingInvite) {
    setRowBusy((b) => ({ ...b, [inv.inviteId]: "pair" }));
    setErrById((e) => ({ ...e, [inv.inviteId]: "" }));
    try {
      await pairInviteWithRegistration(inv);
      onChanged?.();
      reload();
    } catch (e) {
      setErrById((prev) => ({ ...prev, [inv.inviteId]: (e as { message?: string })?.message ?? "Failed" }));
    } finally {
      setRowBusy((b) => ({ ...b, [inv.inviteId]: null }));
    }
  }

  async function removeMany(targets: PendingInvite[]) {
    setConfirmRemove(null);
    setBulkRunning(true);
    try {
      await deletePartnerInvites(targets.map((t) => t.inviteId));
      setSelected(new Set());
      onChanged?.();
      reload();
    } catch (e) {
      setLoadError((e as { message?: string })?.message ?? "Could not remove invites.");
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
      const allOn = ordered.length > 0 && ordered.every((i) => prev.has(i.inviteId));
      const next = new Set(prev);
      if (allOn) ordered.forEach((i) => next.delete(i.inviteId));
      else ordered.forEach((i) => next.add(i.inviteId));
      return next;
    });
  }

  // Nothing to show → render nothing (keeps the page clean when all is well).
  if (invites === null || (invites.length === 0 && !loadError)) return null;

  const allVisibleSelected = ordered.length > 0 && ordered.every((i) => selected.has(i.inviteId));
  const selectedRows = ordered.filter((i) => selected.has(i.inviteId));
  const selectedEmailable = selectedRows.filter((i) => emailable.includes(i));

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
      <div style={{ fontSize: 12, color: warnFg, marginBottom: 12, lineHeight: 1.5, maxWidth: 680 }}>
        {openCount} still waiting on the partner. Rows marked <strong>registered</strong> mean the
        partner signed up on their own (often under a different email) — pair them in one click.
        Rows marked <strong>done</strong> are safe to clear.
      </div>

      {loadError && (
        <div style={{ fontSize: 13, color: "#9c2412", marginBottom: 12 }} role="alert">{loadError}</div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: warnFg }}>
          {selected.size > 0 ? `${selected.size} selected` : `${emailable.length} waiting with an email address`}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {settled.length > 0 && selected.size === 0 && (
            <button
              onClick={() => setConfirmRemove(settled)}
              disabled={bulkRunning}
              style={{ ...btn, opacity: bulkRunning ? 0.5 : 1 }}
            >
              Clear {settled.length} done
            </button>
          )}
          <button
            onClick={() => setConfirmRemove(selectedRows)}
            disabled={selectedRows.length === 0 || bulkRunning}
            style={{ ...btn, opacity: selectedRows.length === 0 || bulkRunning ? 0.5 : 1, cursor: selectedRows.length === 0 || bulkRunning ? "default" : "pointer" }}
          >
            Remove selected
          </button>
          <button
            onClick={resendSelected}
            disabled={selectedEmailable.length === 0 || bulkRunning}
            style={{ ...btn, opacity: selectedEmailable.length === 0 || bulkRunning ? 0.5 : 1, cursor: selectedEmailable.length === 0 || bulkRunning ? "default" : "pointer" }}
            title={selectedEmailable.length === 0 && selected.size > 0 ? "Only waiting invites with an email can be resent" : undefined}
          >
            {bulkRunning ? "Working…" : "Resend selected"}
          </button>
        </div>
      </div>

      <div style={{ overflowX: "auto", background: "#fff", borderRadius: 6, border: `1px solid ${warnFg}22` }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 720 }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 32, textAlign: "center" }}>
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} disabled={ordered.length === 0} style={{ width: 14, height: 14 }} />
              </th>
              <th style={th}>Partner (invitee)</th>
              <th style={th}>Invited by</th>
              <th style={th}>Event</th>
              <th style={th}>What's happened</th>
              <th style={th}>Last sent</th>
              <th style={{ ...th, textAlign: "right" }}></th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((inv) => {
              const st = state[inv.inviteId] ?? "idle";
              const busy = rowBusy[inv.inviteId] ?? null;
              const hasEmail = !!inv.inviteeEmail;
              const res = inv.resolution;
              return (
                <tr key={inv.inviteId} style={{ borderTop: `1px solid ${ruleSoft}`, opacity: res.kind === "settled" ? 0.75 : 1 }}>
                  <td style={{ ...td, textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={selected.has(inv.inviteId)}
                      onChange={() => toggleOne(inv.inviteId)}
                      style={{ width: 14, height: 14 }}
                    />
                  </td>
                  <td style={td}>
                    <div style={{ fontWeight: 500 }}>{inv.inviteeName}</div>
                    <div style={{ color: hasEmail ? inkSoft : "#9c2412", fontSize: 12 }}>
                      {inv.inviteeEmail ?? "no email"}
                    </div>
                  </td>
                  <td style={td}>
                    <div>{inv.inviterName}</div>
                    <div style={{ fontSize: 11, color: inkMuted }}>
                      {inv.inviterPaid ? "Paid" : inv.inviterStatus ? labelStatus(inv.inviterStatus) : "No registration"}
                    </div>
                  </td>
                  <td style={td}>{inv.eventName}</td>
                  <td style={td}>
                    <ResolutionCell inv={inv} />
                  </td>
                  <td style={{ ...td, color: inkMuted, whiteSpace: "nowrap" }}>
                    {fmtDate(inv.lastSentAt)}
                    {fmtDate(inv.lastSentAt) !== fmtDate(inv.createdAt) && (
                      <div style={{ fontSize: 11 }}>invited {fmtDate(inv.createdAt)}</div>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                    <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      {res.kind === "registered" && !res.alreadyPaired && inv.inviterRegId && (
                        <button
                          onClick={() => void pairOne(inv)}
                          disabled={busy !== null}
                          style={{ ...btn, padding: "4px 10px", background: ink, color: "#fff", borderColor: ink, opacity: busy ? 0.6 : 1 }}
                        >
                          {busy === "pair" ? "Pairing…" : "Pair & clear"}
                        </button>
                      )}
                      {res.kind === "open" && (
                        st === "sent" ? (
                          <span style={{ color: courtGreen, fontWeight: 600, fontSize: 12 }}>✓ Sent</span>
                        ) : (
                          <button
                            onClick={() => void resendOne(inv)}
                            disabled={!hasEmail || st === "sending"}
                            style={{ ...btn, padding: "4px 10px", opacity: hasEmail && st !== "sending" ? 1 : 0.5, cursor: hasEmail && st !== "sending" ? "pointer" : "default" }}
                            title={hasEmail ? undefined : "No email on this invite — can't resend"}
                          >
                            {st === "sending" ? "Sending…" : st === "error" ? "Retry" : "Resend"}
                          </button>
                        )
                      )}
                      <button
                        onClick={() => setConfirmRemove([inv])}
                        disabled={busy !== null}
                        style={{ ...btn, padding: "4px 10px", color: "#9c2412", opacity: busy ? 0.6 : 1 }}
                      >
                        {res.kind === "settled" ? "Clear" : "Remove"}
                      </button>
                    </div>
                    {errById[inv.inviteId] && (
                      <div style={{ color: "#9c2412", fontSize: 11, marginTop: 2, whiteSpace: "normal", maxWidth: 260 }}>{errById[inv.inviteId]}</div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {confirmRemove && (
        <ConfirmModal
          title={confirmRemove.length === 1 ? "Remove this invite?" : `Remove ${confirmRemove.length} invites?`}
          destructive
          body={
            confirmRemove.length === 1 ? (
              <>
                Remove the invite from <strong>{confirmRemove[0].inviterName}</strong> to{" "}
                <strong>{confirmRemove[0].inviteeName}</strong> for {confirmRemove[0].eventName}? The invite link stops
                working. Registrations are not touched.
              </>
            ) : (
              <>
                Remove <strong>{confirmRemove.length}</strong> invites? Their links stop working. Registrations are not touched.
              </>
            )
          }
          confirmLabel="Remove"
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => removeMany(confirmRemove)}
        />
      )}
    </section>
  );
}

function ResolutionCell({ inv }: { inv: PendingInvite }) {
  const res = inv.resolution;
  if (res.kind === "open") {
    return <span style={{ ...pill, background: "#fff3e0", color: "#8a5a00" }}>Waiting on partner</span>;
  }
  if (res.kind === "registered") {
    const how =
      res.matchedBy === "player" ? "" : res.matchedBy === "email" ? " · matched by email" : " · matched by name";
    return (
      <div>
        <span style={{ ...pill, background: "#e8f5ea", color: "#2c7a3d" }}>Registered{res.alreadyPaired ? " · already paired" : ""}</span>
        <div style={{ fontSize: 11, color: inkSoft, marginTop: 3 }}>
          as {res.name}{res.email ? ` (${res.email})` : ""}{how}
        </div>
      </div>
    );
  }
  const label =
    res.reason === "paired"
      ? "Done · paired"
      : res.reason === "inviter_paired_elsewhere"
        ? "Done · inviter paired with someone else"
        : `Done · inviter ${inv.inviterStatus ? labelStatus(inv.inviterStatus).toLowerCase() : "not registered"}`;
  return <span style={{ ...pill, background: "#eef0f3", color: inkSoft }}>{label}</span>;
}

function labelStatus(s: string): string {
  if (s === "pending_payment") return "Unpaid";
  if (s === "waitlisted" || s === "waitlisted_pending_payment") return "Waitlisted";
  if (s === "refunded") return "Refunded";
  if (s === "cancelled") return "Cancelled";
  if (s === "withdrawn") return "Withdrawn";
  if (s === "paid") return "Paid";
  return s;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const pill: CSSProperties = {
  display: "inline-block",
  fontSize: 11,
  fontWeight: 700,
  padding: "2px 8px",
  borderRadius: 999,
  whiteSpace: "nowrap",
};

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
