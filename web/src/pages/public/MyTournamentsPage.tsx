import { useEffect, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import { ConfirmModal } from "../../components/ConfirmModal";
import { usePendingPayments } from "../../components/PendingPaymentsContext";
import type { Database } from "../../types/supabase";
import {
  bg,
  bodyFontStack,
  contentColStyle,
  courtBlue,
  courtRed,
  ink,
  inkMuted,
  inkSoft,
  pageH1Style,
  pageWrapStyle,
  rule,
  ruleSoft,
  sectionH2Style,
  successBg,
  successFg,
  warnBg,
  warnFg,
} from "../../lib/publicTheme";

type RegistrationStatus = Database["public"]["Enums"]["registration_status"];
type PartnerStatus = Database["public"]["Enums"]["partner_status"];

type EventReg = {
  id: string;
  status: RegistrationStatus;
  partner_status: PartnerStatus;
  event_fee_cents: number;
  event_name: string;
  event_format: string;
  partner_registration_id: string | null;
  withdrawal_requested_at: string | null;
  entitled_refund_cents: number | null;
};

type TournamentGroup = {
  tournament_id: string;
  tournament_name: string;
  tournament_slug: string;
  org_name: string;
  org_slug: string;
  starts_at: string;
  ends_at: string;
  location_name: string | null;
  tournament_status: Database["public"]["Enums"]["tournament_status"];
  regs: EventReg[];
};

// Which step of the withdraw flow is active.
type WithdrawConfirm = {
  regId: string;
  tournamentId: string;
  eventName: string;
  hasPartner: boolean;
};

// Which reg is in the "request refund" flow.
type RefundRequest = {
  regId: string;
  tournamentId: string;
  eventName: string;
  eventFeeCents: number;
  entitledCents: number | null;
  reason: string;
};

function statusLabel(reg: EventReg): string {
  if (reg.status === "cancelled") return "Cancelled";
  if (reg.status === "withdrawn") {
    return reg.withdrawal_requested_at
      ? "Withdrawn · Refund requested"
      : "Withdrawn";
  }
  if (reg.status === "refunded") return "Refunded";
  if (reg.status === "pending_payment") return "Pending payment";
  if (reg.partner_status === "seeking") return "Paid · Seeking partner";
  if (reg.partner_status === "pending") return "Paid · Awaiting partner";
  return "Paid";
}

type StatusTone = { color: string; background: string };

function statusTone(reg: EventReg): StatusTone {
  if (
    reg.status === "cancelled" ||
    reg.status === "withdrawn" ||
    reg.status === "refunded"
  )
    return { color: inkMuted, background: `${inkMuted}18` };
  if (reg.status === "pending_payment")
    return { color: warnFg, background: warnBg };
  if (reg.partner_status === "seeking" || reg.partner_status === "pending")
    return { color: courtBlue, background: `${courtBlue}18` };
  return { color: successFg, background: successBg };
}

function isWithdrawable(status: RegistrationStatus): boolean {
  return status === "paid" || status === "pending_payment";
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDateRange(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
  };
  const startStr = start.toLocaleDateString("en-US", {
    ...opts,
    year: "numeric",
  });
  if (start.toDateString() === end.toDateString()) return startStr;
  const endStr = end.toLocaleDateString("en-US", {
    ...opts,
    year:
      start.getFullYear() !== end.getFullYear() ? "numeric" : undefined,
  });
  return `${startStr} – ${endStr}`;
}

function isPast(group: TournamentGroup): boolean {
  if (
    group.tournament_status === "completed" ||
    group.tournament_status === "cancelled"
  )
    return true;
  return new Date(group.ends_at) < new Date();
}

export default function MyTournamentsPage() {
  const { user } = useAuth();
  // Refresh the site-wide pending-payments bar after a withdraw — withdrawing a
  // pending_payment reg cancels it, so it must drop out of the bar without a
  // full page reload (#286).
  const { refresh: refreshPendingBar } = usePendingPayments();
  const [groups, setGroups] = useState<TournamentGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Withdraw confirm state.
  const [withdrawConfirm, setWithdrawConfirm] =
    useState<WithdrawConfirm | null>(null);

  // Request-refund flow state.
  const [refundRequest, setRefundRequest] = useState<RefundRequest | null>(
    null
  );

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);

      const { data: playerRow, error: playerErr } = await supabase
        .from("players")
        .select("id")
        .eq("auth_user_id", user.id)
        .is("deleted_at", null)
        .maybeSingle();

      if (playerErr || !playerRow) {
        if (!cancelled) {
          setLoading(false);
          setGroups([]);
        }
        return;
      }

      const playerId = playerRow.id;

      const { data: rows, error: regsErr } = await supabase
        .from("event_registrations")
        .select(
          `
          id,
          status,
          partner_status,
          event_fee_cents,
          partner_registration_id,
          withdrawal_requested_at,
          entitled_refund_cents,
          events (
            id,
            name,
            format,
            gender,
            tournaments (
              id,
              name,
              slug,
              starts_at,
              ends_at,
              status,
              location_name,
              organizations (
                name,
                slug
              )
            )
          )
        `
        )
        .eq("player_id", playerId)
        .is("deleted_at", null);

      if (cancelled) return;

      if (regsErr) {
        setError("Could not load your tournaments. Please try again.");
        setLoading(false);
        return;
      }

      const byTournament = new Map<string, TournamentGroup>();
      for (const row of rows ?? []) {
        const ev = row.events;
        if (!ev) continue;
        const tour = Array.isArray(ev.tournaments)
          ? ev.tournaments[0]
          : ev.tournaments;
        if (!tour) continue;
        const org = Array.isArray(tour.organizations)
          ? tour.organizations[0]
          : tour.organizations;
        if (!org) continue;

        let group = byTournament.get(tour.id);
        if (!group) {
          group = {
            tournament_id: tour.id,
            tournament_name: tour.name,
            tournament_slug: tour.slug,
            org_name: org.name,
            org_slug: org.slug,
            starts_at: tour.starts_at,
            ends_at: tour.ends_at,
            location_name: tour.location_name,
            tournament_status: tour.status,
            regs: [],
          };
          byTournament.set(tour.id, group);
        }
        group.regs.push({
          id: row.id,
          status: row.status,
          partner_status: row.partner_status,
          event_fee_cents: row.event_fee_cents,
          event_name: ev.name,
          event_format: ev.format,
          partner_registration_id: row.partner_registration_id,
          withdrawal_requested_at: row.withdrawal_requested_at,
          entitled_refund_cents: row.entitled_refund_cents,
        });
      }

      if (!cancelled) {
        setGroups(Array.from(byTournament.values()));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // ── Withdraw flow ─────────────────────────────────────────────────────────

  const handleWithdrawClick = (reg: EventReg, tournamentId: string) => {
    setWithdrawConfirm({
      regId: reg.id,
      tournamentId,
      eventName: reg.event_name,
      hasPartner: reg.partner_registration_id !== null,
    });
  };

  const executeWithdraw = async () => {
    if (!withdrawConfirm) return;
    const { regId, tournamentId } = withdrawConfirm;

    const { data, error: rpcErr } = await supabase.rpc("withdraw_self", {
      p_reg_id: regId,
    });

    if (rpcErr) throw new Error(rpcErr.message);

    const row = Array.isArray(data) ? data[0] : data;
    const newStatus = row?.new_status ?? "withdrawn";
    const entitledCents = row?.entitled_cents ?? null;

    setGroups((prev) =>
      prev.map((g) => {
        if (g.tournament_id !== tournamentId) return g;
        return {
          ...g,
          regs: g.regs.map((r) =>
            r.id === regId
              ? {
                  ...r,
                  status: newStatus as RegistrationStatus,
                  entitled_refund_cents: entitledCents,
                  partner_registration_id: null,
                }
              : r
          ),
        };
      })
    );
    setWithdrawConfirm(null);
    // The withdrawn reg is no longer pending_payment → refresh the bar so it
    // disappears immediately (no manual reload). #286.
    await refreshPendingBar();
  };

  // ── Request refund flow ───────────────────────────────────────────────────

  const handleRequestRefundClick = (reg: EventReg, tournamentId: string) => {
    setRefundRequest({
      regId: reg.id,
      tournamentId,
      eventName: reg.event_name,
      eventFeeCents: reg.event_fee_cents,
      entitledCents: reg.entitled_refund_cents,
      reason: "",
    });
  };

  const executeRefundRequest = async () => {
    if (!refundRequest) return;
    const { regId, tournamentId, reason } = refundRequest;

    const { error: rpcErr } = await supabase.rpc("file_refund_request", {
      p_reg_id: regId,
      p_reason: reason.trim() || undefined,
    });

    if (rpcErr) throw new Error(rpcErr.message);

    setGroups((prev) =>
      prev.map((g) => {
        if (g.tournament_id !== tournamentId) return g;
        return {
          ...g,
          regs: g.regs.map((r) =>
            r.id === regId
              ? { ...r, withdrawal_requested_at: new Date().toISOString() }
              : r
          ),
        };
      })
    );
    setRefundRequest(null);
  };

  const upcoming = groups
    .filter((g) => !isPast(g))
    .sort(
      (a, b) =>
        new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
    );
  const past = groups
    .filter(isPast)
    .sort(
      (a, b) =>
        new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime()
    );

  return (
    <div style={pageWrapStyle}>
      <div style={contentColStyle(720)}>
        <h1 style={pageH1Style}>My Tournaments</h1>

        {loading && (
          <p style={{ color: inkMuted, marginTop: 24, fontFamily: bodyFontStack }}>
            Loading…
          </p>
        )}

        {error && (
          <p style={{ color: courtRed, marginTop: 24, fontFamily: bodyFontStack }}>
            {error}
          </p>
        )}

        {!loading && !error && groups.length === 0 && (
          <div style={emptyStyle}>
            <p
              style={{
                margin: 0,
                fontSize: 16,
                color: inkSoft,
                fontFamily: bodyFontStack,
              }}
            >
              You haven't registered for any tournaments yet.
            </p>
            <Link to="/" style={browseLinkStyle}>
              Browse upcoming events
            </Link>
          </div>
        )}

        {!loading && !error && upcoming.length > 0 && (
          <Section
            title="Upcoming & Running"
            groups={upcoming}
            onWithdraw={handleWithdrawClick}
            onRequestRefund={handleRequestRefundClick}
          />
        )}

        {!loading && !error && past.length > 0 && (
          <Section
            title="Past"
            groups={past}
            onWithdraw={handleWithdrawClick}
            onRequestRefund={handleRequestRefundClick}
          />
        )}
      </div>

      {/* Withdraw confirm modal */}
      {withdrawConfirm && (
        <ConfirmModal
          title={`Withdraw from ${withdrawConfirm.eventName}`}
          body={
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <p style={{ margin: 0 }}>
                Your spot will be released. You won't be able to undo this.
              </p>
              {withdrawConfirm.hasPartner && (
                <div style={partnerWarningStyle}>
                  <strong>Partner notice:</strong> Withdrawing will unpair your
                  doubles partner. They will be moved back to "Seeking partner."
                </div>
              )}
              <p style={{ margin: 0 }}>
                Once withdrawn, you can request a refund from the next screen.
              </p>
            </div>
          }
          confirmLabel="Confirm Withdrawal"
          onCancel={() => setWithdrawConfirm(null)}
          onConfirm={executeWithdraw}
        />
      )}

      {/* Request refund modal */}
      {refundRequest && (
        <RequestRefundModal
          flow={refundRequest}
          onChange={(reason) =>
            setRefundRequest((f) => (f ? { ...f, reason } : f))
          }
          onConfirm={executeRefundRequest}
          onCancel={() => setRefundRequest(null)}
        />
      )}
    </div>
  );
}

function Section({
  title,
  groups,
  onWithdraw,
  onRequestRefund,
}: {
  title: string;
  groups: TournamentGroup[];
  onWithdraw: (reg: EventReg, tournamentId: string) => void;
  onRequestRefund: (reg: EventReg, tournamentId: string) => void;
}) {
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={sectionH2Style}>{title}</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {groups.map((g) => (
          <TournamentCard
            key={g.tournament_id}
            group={g}
            onWithdraw={onWithdraw}
            onRequestRefund={onRequestRefund}
          />
        ))}
      </div>
    </section>
  );
}

function TournamentCard({
  group,
  onWithdraw,
  onRequestRefund,
}: {
  group: TournamentGroup;
  onWithdraw: (reg: EventReg, tournamentId: string) => void;
  onRequestRefund: (reg: EventReg, tournamentId: string) => void;
}) {
  const href = `/t/${group.org_slug}/${group.tournament_slug}`;
  const navigate = useNavigate();
  return (
    <div
      style={cardStyle}
      onClick={() => navigate(href)}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && navigate(href)}
    >
      <div style={cardHeaderStyle}>
        <div>
          <span style={cardTitleStyle}>{group.tournament_name}</span>
          <p style={cardMetaStyle}>
            {group.org_name}
            {group.location_name ? ` · ${group.location_name}` : ""}
          </p>
          <p style={cardMetaStyle}>
            {formatDateRange(group.starts_at, group.ends_at)}
          </p>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {group.regs.map((reg) => {
          const tone = statusTone(reg);
          const canWithdraw = isWithdrawable(reg.status);
          const canRequestRefund =
            reg.status === "withdrawn" && reg.withdrawal_requested_at === null;
          return (
            <div key={reg.id} style={regRowStyle}>
              <span style={eventNameStyle}>{reg.event_name}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    ...statusPillStyle,
                    color: tone.color,
                    background: tone.background,
                  }}
                >
                  {statusLabel(reg)}
                </span>
                {canWithdraw && (
                  <button
                    style={actionBtnStyle}
                    onClick={(e) => {
                      e.stopPropagation();
                      onWithdraw(reg, group.tournament_id);
                    }}
                  >
                    Withdraw
                  </button>
                )}
                {canRequestRefund && (
                  <button
                    style={actionBtnStyle}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestRefund(reg, group.tournament_id);
                    }}
                  >
                    Request refund
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div style={cardFooterStyle}>
        <Link
          to={href}
          style={viewLinkStyle}
          onClick={(e) => e.stopPropagation()}
        >
          View tournament &rarr;
        </Link>
      </div>
    </div>
  );
}

function RequestRefundModal({
  flow,
  onChange,
  onConfirm,
  onCancel,
}: {
  flow: RefundRequest;
  onChange: (reason: string) => void;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleConfirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onConfirm();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const entitledLine =
    flow.entitledCents === null
      ? "Refund amount will be reviewed by the organizer."
      : flow.entitledCents === 0
        ? `${formatMoney(0)} per the cancellation policy. You may still submit a review request.`
        : formatMoney(flow.entitledCents);

  return (
    <div
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="refund-modal-title"
        style={modalStyle}
      >
        <h2
          id="refund-modal-title"
          style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 600 }}
        >
          Request refund — {flow.eventName}
        </h2>

        <div
          style={{
            fontSize: 13,
            color: "#444",
            lineHeight: 1.6,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={refundRowStyle}>
            <span style={refundLabelStyle}>Amount paid</span>
            <span>{formatMoney(flow.eventFeeCents)}</span>
          </div>
          <div style={refundRowStyle}>
            <span style={refundLabelStyle}>Entitled refund</span>
            <span>{entitledLine}</span>
          </div>
          <p style={{ margin: 0, color: "#6b7280", fontSize: 12 }}>
            The organizer will review your request and approve or deny it. You
            will be notified of their decision.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label
              htmlFor="refund-reason"
              style={{ fontSize: 12, fontWeight: 600, color: "#6b7280" }}
            >
              Reason (optional)
            </label>
            <textarea
              id="refund-reason"
              value={flow.reason}
              onChange={(e) => onChange(e.target.value)}
              disabled={busy}
              rows={3}
              maxLength={2000}
              placeholder="Let the organizer know why you're withdrawing…"
              style={reasonTextareaStyle}
            />
          </div>

          {err && (
            <p style={{ margin: 0, color: "#dc2626" }}>{err}</p>
          )}
        </div>

        <div style={modalFooterStyle}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={secondaryBtnStyle(busy)}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={busy}
            style={primaryBtnStyle(busy)}
          >
            {busy ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────

const emptyStyle: CSSProperties = {
  marginTop: 48,
  textAlign: "center",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 16,
};

const browseLinkStyle: CSSProperties = {
  display: "inline-block",
  padding: "10px 20px",
  background: "#f3d111",
  color: "#14181f",
  borderRadius: 8,
  textDecoration: "none",
  fontWeight: 600,
  fontSize: 14,
};

const cardStyle: CSSProperties = {
  background: "#ffffff",
  border: `1px solid ${rule}`,
  borderRadius: 10,
  padding: "20px 24px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  cursor: "pointer",
  fontFamily: bodyFontStack,
};

const cardHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
};

const cardTitleStyle: CSSProperties = {
  fontSize: 17,
  fontWeight: 600,
  color: ink,
  textDecoration: "none",
};

const cardMetaStyle: CSSProperties = {
  fontSize: 13,
  color: inkMuted,
  margin: "2px 0 0",
};

const regRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "6px 0",
  borderTop: `1px solid ${bg}`,
};

const eventNameStyle: CSSProperties = {
  fontSize: 14,
  color: inkSoft,
};

const statusPillStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  padding: "2px 8px",
  borderRadius: 9999,
  whiteSpace: "nowrap",
};

const actionBtnStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  padding: "2px 10px",
  borderRadius: 6,
  border: "1px solid #d1d5db",
  background: "#fff",
  color: "#374151",
  cursor: "pointer",
  whiteSpace: "nowrap",
  fontFamily: "inherit",
};

const cardFooterStyle: CSSProperties = {
  borderTop: `1px solid ${ruleSoft}`,
  paddingTop: 10,
  marginTop: 2,
};

const viewLinkStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: courtBlue,
  textDecoration: "none",
};

const partnerWarningStyle: CSSProperties = {
  background: "#fffbeb",
  border: "1px solid #fcd34d",
  borderRadius: 6,
  padding: "8px 12px",
  fontSize: 13,
  color: "#92400e",
};

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  zIndex: 1000,
};

const modalStyle: CSSProperties = {
  background: "var(--surface)",
  borderRadius: 8,
  padding: 24,
  maxWidth: 480,
  width: "100%",
  boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
};

const refundRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const refundLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#6b7280",
};

const reasonTextareaStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  borderRadius: 6,
  border: "1px solid #d1d5db",
  fontFamily: "inherit",
  resize: "vertical",
  boxSizing: "border-box",
};

const modalFooterStyle: CSSProperties = {
  marginTop: 20,
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
};

function primaryBtnStyle(busy: boolean): CSSProperties {
  return {
    padding: "8px 16px",
    background: busy ? "var(--text-subtle)" : "var(--primary)",
    color: "var(--primary-contrast)",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "inherit",
  };
}

function secondaryBtnStyle(busy: boolean): CSSProperties {
  return {
    padding: "8px 16px",
    background: "var(--surface)",
    color: "var(--text-muted)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    fontSize: 13,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    opacity: busy ? 0.6 : 1,
  };
}
