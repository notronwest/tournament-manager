import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Database } from "../types/supabase";
import {
  PlayerPicker,
  emptySelection,
  persistPlayerSelection,
  type PlayerSelection,
} from "./PlayerPicker";
import { ConfirmModal } from "./ConfirmModal";
import {
  previewAdminRefund,
  executeAdminRefund,
  type AdminRefundPreview,
} from "../lib/refunds";
import { formatUsd } from "../lib/pricing";
import {
  reassignRegistrationPlayer,
  withdrawRegistration,
  pairRegistrations,
  unpairRegistration,
  createPartnerRegistration,
  fetchEventRegistrants,
  fetchRegPartnerContext,
  pairAndResolveInvites,
  type RegPartnerContext,
  type InviteContact,
} from "../lib/registrations";
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
  panelMutedStyle,
  ctaPrimaryStyle,
  ctaPrimaryDisabledStyle,
  ctaSecondaryStyle,
  ghostButtonStyle,
  statusPanelStyle,
  successBg,
  successFg,
  warnBg,
  warnFg,
  dangerBg,
  dangerFg,
  infoBg,
  infoFg,
} from "../lib/publicTheme";

type RegistrationStatus = Database["public"]["Enums"]["registration_status"];
type PartnerStatus = Database["public"]["Enums"]["partner_status"];
type EventFormat = Database["public"]["Enums"]["event_format"];

// The single registration this modal edits. Both hosts (AttendeesPage rows and
// the Contacts registrations list) build this shape and hand it in.
export type EditableRegistration = {
  regId: string;
  eventId: string;
  eventName: string;
  format: EventFormat;
  playerId: string;
  playerName: string;
  status: RegistrationStatus;
  partnerStatus: PartnerStatus;
  partnerRegId: string | null;
  partnerName: string | null;
  eventFeeCents: number;
  tournamentName?: string;
};

// Shared admin editor for one registration. Every write is a direct client
// UPDATE/INSERT on event_registrations (org-staff RLS allows it) — no edge
// functions, no payments/refunds. On any successful change we call onChanged
// (host refetches) and onClose, so the modal never shows stale data.
export function RegistrationEditorModal({
  reg,
  onClose,
  onChanged,
}: {
  reg: EditableRegistration;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const isDoubles = reg.format === "doubles";
  const hasPartner = reg.partnerRegId != null;

  const [reassignSel, setReassignSel] = useState<PlayerSelection>(emptySelection);
  const [partnerSel, setPartnerSel] = useState<PlayerSelection>(emptySelection);
  const [busy, setBusy] = useState<null | "reassign" | "partner" | "unpair">(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  // Organizer-initiated refund (#704). Only paid regs can be refunded.
  const canRefund = reg.status === "paid";
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundPreview, setRefundPreview] = useState<AdminRefundPreview | null>(null);
  const [refundLoading, setRefundLoading] = useState(false);
  const [refundAmountStr, setRefundAmountStr] = useState("");
  const [refundRemove, setRefundRemove] = useState(true);
  const [refundReason, setRefundReason] = useState("");
  const [refundConfirm, setRefundConfirm] = useState(false);
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);

  // Open the refund panel and fetch the policy default + max refundable.
  const openRefund = async () => {
    setRefundOpen(true);
    setRefundLoading(true);
    setRefundError(null);
    setRefundPreview(null);
    const { preview, error: err } = await previewAdminRefund(reg.regId);
    if (err || !preview) {
      setRefundError(err ?? "Could not load refund details.");
      setRefundLoading(false);
      return;
    }
    setRefundPreview(preview);
    setRefundAmountStr((preview.policyDefaultCents / 100).toFixed(2));
    setRefundLoading(false);
  };

  // Parse the dollar input → cents, clamped to [0, max].
  const refundMaxCents = refundPreview?.maxRefundableCents ?? 0;
  const refundAmountCents = (() => {
    const n = Math.round(parseFloat(refundAmountStr || "0") * 100);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, refundMaxCents);
  })();
  const refundAmountValid =
    refundPreview != null &&
    Number.isFinite(parseFloat(refundAmountStr)) &&
    refundAmountCents >= 0 &&
    refundAmountCents <= refundMaxCents;

  // Pending-invite context, so the admin can SEE who this player invited / who
  // invited them — the missing piece when two people invite each other.
  const [partnerCtx, setPartnerCtx] = useState<RegPartnerContext | null>(null);
  const [pairingId, setPairingId] = useState<string | null>(null);

  useEffect(() => {
    if (!isDoubles) return;
    let cancelled = false;
    (async () => {
      try {
        const ctx = await fetchRegPartnerContext(reg.eventId, reg.playerId);
        if (!cancelled) setPartnerCtx(ctx);
      } catch {
        // Non-fatal — the editor still works without the invite context.
        if (!cancelled) setPartnerCtx({ invited: [], invitedBy: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDoubles, reg.eventId, reg.playerId]);

  const done = async () => {
    await onChanged();
    onClose();
  };

  const onPairWith = async (c: InviteContact) => {
    if (!c.regId) return;
    setError(null);
    setPairingId(c.inviteId);
    try {
      await pairAndResolveInvites(reg.regId, c.regId, reg.eventId, reg.playerId, c.playerId);
      await done();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setPairingId(null);
    }
  };

  const onReassign = async () => {
    setError(null);
    if (reassignSel.mode === "empty") {
      setError("Pick or enter the player to move this registration to.");
      return;
    }
    setBusy("reassign");
    try {
      const res = await persistPlayerSelection(reassignSel);
      if (!res.player) {
        setError(res.error ?? "Could not resolve that player.");
        return;
      }
      if (res.player.id === reg.playerId) {
        setError("This registration is already for that player.");
        return;
      }
      await reassignRegistrationPlayer(reg.regId, res.player.id, reg.eventId);
      await done();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const onRemovePartner = async () => {
    if (!reg.partnerRegId) return;
    setError(null);
    setBusy("unpair");
    try {
      await unpairRegistration(reg.regId, reg.partnerRegId);
      await done();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const onAssignPartner = async () => {
    setError(null);
    if (partnerSel.mode === "empty") {
      setError("Pick or enter a partner first.");
      return;
    }
    setBusy("partner");
    try {
      const res = await persistPlayerSelection(partnerSel);
      if (!res.player) {
        setError(res.error ?? "Could not resolve that player.");
        return;
      }
      const playerId = res.player.id;
      if (playerId === reg.playerId) {
        setError("A player can't be their own partner — pick someone else.");
        return;
      }
      // Reuse an existing active reg for this player in this event if one
      // exists; otherwise comp-create a new reg for them.
      const registrants = await fetchEventRegistrants(reg.eventId);
      const existing = registrants.find(
        (r) => r.playerId === playerId && r.regId !== reg.regId,
      );
      const partnerRegId = existing
        ? existing.regId
        : await createPartnerRegistration(reg.eventId, playerId);
      await pairRegistrations(reg.regId, partnerRegId);
      await done();
    } catch (e) {
      // Surfaces the check_paired_roles_sides trigger message verbatim.
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const anyBusy = busy !== null;

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reg-editor-title"
        onClick={onClose}
        style={overlay}
      >
        <div onClick={(e) => e.stopPropagation()} style={sheet}>
          {/* Header */}
          <div style={headerRow}>
            <div style={{ minWidth: 0 }}>
              <h2 id="reg-editor-title" style={headingStyle}>Manage registration</h2>
              <div style={{ fontSize: 15, fontWeight: 600, color: ink, marginTop: 6 }}>
                {reg.playerName}
              </div>
              <div style={{ fontSize: 13, color: inkSoft, marginTop: 2 }}>
                {reg.eventName}
                {reg.tournamentName ? ` · ${reg.tournamentName}` : ""}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                <StatusBadge status={reg.status} />
                <PartnerBadge status={reg.partnerStatus} />
              </div>
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
            <div style={{ ...statusPanelStyle("danger"), margin: "0 0 16px" }} role="alert">
              {error}
            </div>
          )}

          {/* Reassign player */}
          <Section title="Reassign player">
            <p style={hint}>
              Move this registration to a different player. Their event, partner,
              and payment stay put — only who is registered changes.
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <PlayerPicker
                  label="New player"
                  selection={reassignSel}
                  onChange={setReassignSel}
                />
              </div>
              <div style={{ paddingTop: 18 }}>
                <button
                  onClick={onReassign}
                  disabled={anyBusy || reassignSel.mode === "empty"}
                  style={
                    anyBusy || reassignSel.mode === "empty"
                      ? ctaPrimaryDisabledStyle
                      : ctaPrimaryStyle
                  }
                >
                  {busy === "reassign" ? "Saving…" : "Reassign"}
                </button>
              </div>
            </div>
          </Section>

          {/* Partner (doubles only) */}
          {isDoubles && (
            <Section title="Partner">
              <PendingInviteContext
                ctx={partnerCtx}
                playerName={reg.playerName}
                pairingId={pairingId}
                onPairWith={onPairWith}
              />
              {hasPartner ? (
                <div style={{ ...panelMutedStyle }}>
                  <div style={{ fontSize: 13, color: inkSoft, marginBottom: 10 }}>
                    Current partner:{" "}
                    <strong style={{ color: ink }}>
                      {reg.partnerName ?? "(partner)"}
                    </strong>
                  </div>
                  <button
                    onClick={onRemovePartner}
                    disabled={anyBusy}
                    style={anyBusy ? ctaPrimaryDisabledStyle : ctaSecondaryStyle}
                  >
                    {busy === "unpair" ? "Removing…" : "Remove partner"}
                  </button>
                  <p style={{ ...hint, marginTop: 10, marginBottom: 0 }}>
                    Removing the partner sends both players back to seeking — it
                    doesn't withdraw or refund either of them.
                  </p>
                </div>
              ) : (
                <>
                  <p style={hint}>
                    Assign a partner. If they're already registered for this
                    event we'll pair the existing entry; otherwise a comped
                    ($0) registration is created for them and the two are paired.
                  </p>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <PlayerPicker
                        label="Partner"
                        selection={partnerSel}
                        onChange={setPartnerSel}
                      />
                    </div>
                    <div style={{ paddingTop: 18 }}>
                      <button
                        onClick={onAssignPartner}
                        disabled={anyBusy || partnerSel.mode === "empty"}
                        style={
                          anyBusy || partnerSel.mode === "empty"
                            ? ctaPrimaryDisabledStyle
                            : ctaPrimaryStyle
                        }
                      >
                        {busy === "partner" ? "Pairing…" : "Assign partner"}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </Section>
          )}

          {/* Issue refund — organizer-initiated, paid regs only (#704) */}
          {canRefund && (
            <Section title="Issue refund">
              {!refundOpen ? (
                <>
                  <p style={hint}>
                    Refund this player yourself — no withdrawal request needed.
                    The amount defaults to the tournament's cancellation policy
                    and you can override it.
                  </p>
                  <button
                    onClick={openRefund}
                    disabled={anyBusy}
                    style={{
                      ...ctaSecondaryStyle,
                      opacity: anyBusy ? 0.6 : 1,
                    }}
                  >
                    Issue a refund…
                  </button>
                </>
              ) : refundLoading ? (
                <p style={hint}>Loading refund details…</p>
              ) : refundError && !refundPreview ? (
                <div>
                  <div style={statusPanelStyle("danger")}>{refundError}</div>
                  <button
                    onClick={() => setRefundOpen(false)}
                    style={{ ...ghostButtonStyle, marginTop: 10 }}
                  >
                    Close
                  </button>
                </div>
              ) : refundPreview ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <p style={{ ...hint, margin: 0 }}>
                    Cancellation policy:{" "}
                    <strong>{prettyPolicy(refundPreview.policyDecision)}</strong>
                    {" → suggests "}
                    <strong>{formatUsd(refundPreview.policyDefaultCents)}</strong>.
                    {refundPreview.alreadyRefundedCents > 0 && (
                      <>
                        {" "}
                        Already refunded{" "}
                        {formatUsd(refundPreview.alreadyRefundedCents)}.
                      </>
                    )}
                  </p>

                  <label style={fieldLabel}>
                    Refund amount (USD)
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                      <span style={{ color: inkSoft }}>$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={refundAmountStr}
                        onChange={(e) => setRefundAmountStr(e.target.value)}
                        style={refundInput}
                      />
                    </div>
                    <span style={{ fontSize: 11.5, color: inkMuted }}>
                      Max {formatUsd(refundPreview.maxRefundableCents)} (net paid
                      {refundPreview.alreadyRefundedCents > 0
                        ? " minus already refunded"
                        : ""}
                      ).
                    </span>
                  </label>

                  <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={refundRemove}
                      onChange={(e) => setRefundRemove(e.target.checked)}
                      style={{ marginTop: 2 }}
                    />
                    <span>
                      Also remove {reg.playerName} from the event
                      <span style={{ display: "block", color: inkMuted, fontSize: 11.5 }}>
                        {refundRemove
                          ? hasPartner
                            ? "They'll be withdrawn and their partner unpaired."
                            : "They'll be withdrawn from this event."
                          : "They stay registered — money back only."}
                      </span>
                    </span>
                  </label>

                  <label style={fieldLabel}>
                    Note (optional)
                    <input
                      type="text"
                      value={refundReason}
                      onChange={(e) => setRefundReason(e.target.value)}
                      placeholder="Reason for the refund"
                      style={{ ...refundInput, marginTop: 4 }}
                    />
                  </label>

                  {refundError && (
                    <div style={statusPanelStyle("danger")}>{refundError}</div>
                  )}

                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => {
                        setRefundOpen(false);
                        setRefundError(null);
                      }}
                      disabled={refundBusy}
                      style={ghostButtonStyle}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => setRefundConfirm(true)}
                      disabled={!refundAmountValid || refundBusy}
                      style={
                        !refundAmountValid || refundBusy
                          ? ctaPrimaryDisabledStyle
                          : ctaPrimaryStyle
                      }
                    >
                      {refundAmountCents > 0
                        ? `Issue ${formatUsd(refundAmountCents)} refund`
                        : refundRemove
                          ? "Withdraw (no refund)"
                          : "Issue refund"}
                    </button>
                  </div>
                </div>
              ) : null}
            </Section>
          )}

          {/* Withdraw */}
          <Section title="Withdraw" danger>
            <p style={hint}>
              Pulls this player from the event and unpairs their partner. This
              does <strong>not</strong> issue a refund — to refund, use{" "}
              <strong>Issue refund</strong> above (it can also remove them).
            </p>
            <button
              onClick={() => setWithdrawOpen(true)}
              disabled={anyBusy}
              style={{
                ...ctaSecondaryStyle,
                color: dangerFg,
                boxShadow: `inset 0 0 0 2px ${dangerFg}`,
                opacity: anyBusy ? 0.6 : 1,
              }}
            >
              Withdraw from event
            </button>
          </Section>
        </div>
      </div>

      {withdrawOpen && (
        <ConfirmModal
          title={`Withdraw ${reg.playerName}?`}
          body={
            <div>
              This withdraws them from <strong>{reg.eventName}</strong> and
              unpairs any partner.
              <div style={{ ...statusPanelStyle("warn"), marginTop: 10 }}>
                It does <strong>not</strong> issue a refund. To refund, use{" "}
                <strong>Issue refund</strong> instead.
              </div>
            </div>
          }
          confirmLabel="Withdraw"
          onCancel={() => setWithdrawOpen(false)}
          onConfirm={async () => {
            try {
              await withdrawRegistration({
                regId: reg.regId,
                status: reg.status,
                partnerRegId: reg.partnerRegId,
              });
              setWithdrawOpen(false);
              await done();
            } catch (e) {
              setWithdrawOpen(false);
              setError(errMsg(e));
            }
          }}
        />
      )}

      {refundConfirm && refundPreview && (
        <ConfirmModal
          title="Issue refund?"
          body={
            <div>
              {refundAmountCents > 0 ? (
                <>
                  Refund <strong>{formatUsd(refundAmountCents)}</strong> to{" "}
                  <strong>{reg.playerName}</strong> for{" "}
                  <strong>{reg.eventName}</strong>. This goes back to their
                  original payment and can't be undone here.
                </>
              ) : (
                <>
                  No money will be refunded to <strong>{reg.playerName}</strong>.
                </>
              )}
              <div style={{ ...statusPanelStyle(refundRemove ? "warn" : "info"), marginTop: 10 }}>
                {refundRemove
                  ? hasPartner
                    ? "They'll also be withdrawn from the event and their partner unpaired."
                    : "They'll also be withdrawn from the event."
                  : "They stay registered — money back only."}
              </div>
            </div>
          }
          confirmLabel={refundBusy ? "Processing…" : "Issue refund"}
          onCancel={() => (refundBusy ? undefined : setRefundConfirm(false))}
          onConfirm={async () => {
            setRefundBusy(true);
            setRefundError(null);
            const { error: err } = await executeAdminRefund({
              regId: reg.regId,
              amountCents: refundAmountCents,
              removeFromEvent: refundRemove,
              reason: refundReason.trim() || undefined,
            });
            setRefundBusy(false);
            if (err) {
              setRefundConfirm(false);
              setRefundError(err);
              return;
            }
            setRefundConfirm(false);
            setRefundOpen(false);
            await done();
          }}
        />
      )}
    </>
  );
}

// Cancellation-policy decision → human label for the refund panel.
function prettyPolicy(decision: string): string {
  switch (decision) {
    case "full":
      return "full refund";
    case "partial":
      return "partial refund";
    case "none":
      return "no refund";
    case "manual_required":
      return "organizer decides";
    case "unpaid":
      return "unpaid";
    default:
      return decision;
  }
}

function errMsg(e: unknown): string {
  return (e as { message?: string })?.message ?? "Something went wrong.";
}

// Shows who this player invited / who invited them while a partner invite is
// still pending — the context the admin otherwise has to remember from the
// roster. Calls out the "invited each other, nobody accepted" case and offers a
// one-click pair when the other person is registered.
function PendingInviteContext({
  ctx,
  playerName,
  pairingId,
  onPairWith,
}: {
  ctx: RegPartnerContext | null;
  playerName: string;
  pairingId: string | null;
  onPairWith: (c: InviteContact) => void;
}) {
  if (!ctx) return null;
  const invitedByIds = new Set(ctx.invitedBy.map((c) => c.playerId));
  const mutual = ctx.invited.filter((c) => invitedByIds.has(c.playerId));
  const mutualIds = new Set(mutual.map((c) => c.playerId));
  const invitedOnly = ctx.invited.filter((c) => !mutualIds.has(c.playerId));
  const invitedByOnly = ctx.invitedBy.filter((c) => !mutualIds.has(c.playerId));
  if (mutual.length + invitedOnly.length + invitedByOnly.length === 0) return null;

  const firstName = playerName.split(/\s+/)[0] || playerName;

  const pairAction = (c: InviteContact) =>
    c.regId ? (
      <button
        onClick={() => onPairWith(c)}
        disabled={pairingId !== null}
        style={pairingId !== null ? ctaPrimaryDisabledStyle : ctaPrimaryStyle}
      >
        {pairingId === c.inviteId ? "Pairing…" : "Pair them"}
      </button>
    ) : (
      <span style={{ fontSize: 12, color: inkMuted }}>not registered yet</span>
    );

  return (
    <div style={{ marginBottom: 14 }}>
      {mutual.map((c) => (
        <div key={c.inviteId} style={{ ...statusPanelStyle("warn"), marginBottom: 8 }}>
          <div style={{ fontSize: 13, color: ink, marginBottom: 8, lineHeight: 1.5 }}>
            <strong>{firstName}</strong> and <strong>{c.name}</strong> invited each
            other — neither accepted yet. Pairing them confirms the team and clears
            both invites.
          </div>
          {pairAction(c)}
        </div>
      ))}
      {(invitedOnly.length > 0 || invitedByOnly.length > 0) && (
        <div style={{ ...panelMutedStyle, marginBottom: 8, display: "flex", flexDirection: "column", gap: 10 }}>
          {invitedOnly.map((c) => (
            <div key={c.inviteId} style={inviteRow}>
              <div style={{ fontSize: 13, color: inkSoft }}>
                Invited <strong style={{ color: ink }}>{c.name}</strong>
                {c.email ? <span style={{ color: inkMuted }}> · {c.email}</span> : null}{" "}
                — <em>pending</em>
              </div>
              {pairAction(c)}
            </div>
          ))}
          {invitedByOnly.map((c) => (
            <div key={c.inviteId} style={inviteRow}>
              <div style={{ fontSize: 13, color: inkSoft }}>
                <strong style={{ color: ink }}>{c.name}</strong> invited them —{" "}
                <em>pending</em>
              </div>
              {pairAction(c)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const inviteRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  flexWrap: "wrap",
};

function Section({
  title,
  danger,
  children,
}: {
  title: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        borderTop: `1px solid ${ruleSoft}`,
        paddingTop: 16,
        marginTop: 16,
      }}
    >
      <h3
        style={{
          margin: "0 0 8px",
          fontFamily: headingFontStack,
          fontSize: 13,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: danger ? dangerFg : inkSoft,
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function StatusBadge({ status }: { status: RegistrationStatus }) {
  const map: Record<RegistrationStatus, { label: string; bg: string; fg: string }> = {
    paid: { label: "Paid", bg: successBg, fg: successFg },
    pending_payment: { label: "Pending", bg: warnBg, fg: warnFg },
    cancelled: { label: "Cancelled", bg: cream, fg: inkMuted },
    refunded: { label: "Refunded", bg: cream, fg: inkMuted },
    withdrawn: { label: "Withdrawn", bg: cream, fg: inkMuted },
    waitlisted: { label: "Waitlisted", bg: warnBg, fg: warnFg },
    waitlisted_pending_payment: { label: "Waitlist — unpaid", bg: warnBg, fg: warnFg },
  };
  const s = map[status] ?? { label: status, bg: cream, fg: inkMuted };
  return <span style={badge(s.bg, s.fg)}>{s.label}</span>;
}

function PartnerBadge({ status }: { status: PartnerStatus }) {
  if (status === "solo") return null;
  const map: Record<PartnerStatus, { label: string; bg: string; fg: string }> = {
    solo: { label: "Solo", bg: cream, fg: inkMuted },
    confirmed: { label: "Team confirmed", bg: successBg, fg: successFg },
    pending: { label: "Invite pending", bg: infoBg, fg: infoFg },
    seeking: { label: "Seeking partner", bg: warnBg, fg: warnFg },
    declined: { label: "Declined", bg: dangerBg, fg: dangerFg },
  };
  const s = map[status] ?? { label: status, bg: cream, fg: inkMuted };
  return <span style={badge(s.bg, s.fg)}>{s.label}</span>;
}

function badge(bgc: string, fg: string): CSSProperties {
  return {
    padding: "2px 8px",
    background: bgc,
    color: fg,
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
  };
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(20,24,31,0.45)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "40px 16px",
  zIndex: 1000,
  overflowY: "auto",
};

const sheet: CSSProperties = {
  ...panelStyle,
  background: "#ffffff",
  border: `1px solid ${rule}`,
  width: "100%",
  maxWidth: 520,
  margin: 0,
  fontFamily: bodyFontStack,
  color: ink,
};

const headerRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
};

const headingStyle: CSSProperties = {
  fontFamily: headingFontStack,
  fontSize: 16,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  margin: 0,
  color: courtBlue,
};

const hint: CSSProperties = {
  fontSize: 12.5,
  color: inkSoft,
  margin: "0 0 12px",
  lineHeight: 1.5,
};

const fieldLabel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontSize: 12.5,
  fontWeight: 600,
  color: inkSoft,
};

const refundInput: CSSProperties = {
  flex: 1,
  padding: "8px 10px",
  border: `1px solid ${rule}`,
  borderRadius: 6,
  fontSize: 14,
  fontFamily: bodyFontStack,
  color: ink,
  background: "#fff",
  width: "100%",
  boxSizing: "border-box",
};
