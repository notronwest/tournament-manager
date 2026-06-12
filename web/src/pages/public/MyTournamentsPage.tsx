import { useEffect, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import type { Database } from "../../types/supabase";
import {
  bg,
  bodyFontStack,
  contentColStyle,
  courtBlue,
  courtRed,
  ctaPrimaryStyle,
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
type CancellationPolicyPreset =
  Database["public"]["Enums"]["cancellation_policy_preset"];

type EventReg = {
  id: string;
  status: RegistrationStatus;
  partner_status: PartnerStatus;
  event_fee_cents: number;
  event_name: string;
  event_format: string;
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
  cancellation_policy_preset: CancellationPolicyPreset | null;
  regs: EventReg[];
};

type WithdrawPreview = {
  decision: "full" | "partial" | "none" | "unpaid" | "manual_required";
  paidCents: number;
  refundCents: number;
  partner: { name: string; willUnpair: boolean } | null;
};

type WithdrawFlow =
  | { regId: string; tournamentId: string; eventName: string; phase: "loading" }
  | {
      regId: string;
      tournamentId: string;
      eventName: string;
      phase: "preview";
      preview: WithdrawPreview;
    }
  | {
      regId: string;
      tournamentId: string;
      eventName: string;
      phase: "error";
      message: string;
    };

function statusLabel(
  regStatus: RegistrationStatus,
  partnerStatus: PartnerStatus
): string {
  if (regStatus === "cancelled") return "Cancelled";
  if (regStatus === "withdrawn") return "Withdrawn";
  if (regStatus === "refunded") return "Refunded";
  if (regStatus === "pending_payment") return "Pending payment";
  if (partnerStatus === "seeking") return "Paid · Seeking partner";
  if (partnerStatus === "pending") return "Paid · Awaiting partner";
  return "Paid";
}

type StatusTone = { color: string; background: string };

function statusTone(
  regStatus: RegistrationStatus,
  partnerStatus: PartnerStatus
): StatusTone {
  if (
    regStatus === "cancelled" ||
    regStatus === "withdrawn" ||
    regStatus === "refunded"
  )
    return { color: inkMuted, background: `${inkMuted}18` };
  if (regStatus === "pending_payment")
    return { color: warnFg, background: warnBg };
  if (partnerStatus === "seeking" || partnerStatus === "pending")
    return { color: courtBlue, background: `${courtBlue}18` };
  return { color: successFg, background: successBg };
}

function isWithdrawable(status: RegistrationStatus): boolean {
  return status === "paid" || status === "pending_payment";
}

function policyText(preset: CancellationPolicyPreset | null): string {
  switch (preset) {
    case "generous":
      return "Full refund if more than 7 days before start; no refund within 7 days of start.";
    case "standard":
      return "Full refund within 7 days of registration; half refund if more than 7 days before start; no refund within 7 days of start.";
    case "strict":
      return "No refunds after registration.";
    case "custom":
    case null:
    default:
      return "This tournament has a custom or unset cancellation policy.";
  }
}

function refundSummaryText(preview: WithdrawPreview): string {
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  switch (preview.decision) {
    case "full":
      return `You'll receive a full refund of ${fmt(preview.refundCents)}.`;
    case "partial":
      return `You'll receive a partial refund of ${fmt(preview.refundCents)} (of ${fmt(preview.paidCents)} paid).`;
    case "none":
      return "No refund will be issued per the cancellation policy.";
    case "unpaid":
      return "Your registration will be cancelled. No payment was charged.";
    case "manual_required":
      return "Your refund requires organizer review.";
  }
}

// Mirrors OrgStripeSettingsPage.extractError — reads the JSON body from
// fnErr.context where edge functions put their { error } payload.
async function extractError(fnErr: unknown): Promise<string> {
  const ctx = (fnErr as { context?: Response }).context;
  if (ctx) {
    try {
      const body = (await ctx.json()) as { error?: string };
      if (body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return (fnErr as { message?: string }).message ?? "Unknown error.";
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
  const [groups, setGroups] = useState<TournamentGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [withdrawFlow, setWithdrawFlow] = useState<WithdrawFlow | null>(null);

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
              cancellation_policy_preset,
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
            cancellation_policy_preset:
              (tour.cancellation_policy_preset as CancellationPolicyPreset | null) ??
              null,
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

  const startWithdraw = async (
    regId: string,
    tournamentId: string,
    eventName: string
  ) => {
    setWithdrawFlow({ regId, tournamentId, eventName, phase: "loading" });

    const { data, error: fnErr } = await supabase.functions.invoke(
      "stripe-refund",
      { body: { eventRegistrationId: regId, dryRun: true } }
    );

    if (fnErr) {
      const message = await extractError(fnErr);
      setWithdrawFlow({ regId, tournamentId, eventName, phase: "error", message });
      return;
    }

    const preview = data as WithdrawPreview;
    setWithdrawFlow({ regId, tournamentId, eventName, phase: "preview", preview });
  };

  const executeWithdraw = async () => {
    if (!withdrawFlow || withdrawFlow.phase !== "preview") return;
    const { regId, tournamentId, eventName } = withdrawFlow;

    const { data, error: fnErr } = await supabase.functions.invoke(
      "stripe-refund",
      { body: { eventRegistrationId: regId, dryRun: false } }
    );

    if (fnErr) {
      const message = await extractError(fnErr);
      setWithdrawFlow({ regId, tournamentId, eventName, phase: "error", message });
      return;
    }

    const result = data as {
      applied: boolean;
      newStatus: string | null;
    };

    if (result.newStatus) {
      setGroups((prev) =>
        prev.map((g) => {
          if (g.tournament_id !== tournamentId) return g;
          return {
            ...g,
            regs: g.regs.map((r) =>
              r.id === regId
                ? { ...r, status: result.newStatus as RegistrationStatus }
                : r
            ),
          };
        })
      );
    }

    setWithdrawFlow(null);
  };

  const cancelWithdraw = () => setWithdrawFlow(null);

  const activeGroup = withdrawFlow
    ? (groups.find((g) => g.tournament_id === withdrawFlow.tournamentId) ??
      null)
    : null;

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
          <p style={{ color: inkMuted, marginTop: 24, fontFamily: bodyFontStack }}>Loading…</p>
        )}

        {error && (
          <p style={{ color: courtRed, marginTop: 24, fontFamily: bodyFontStack }}>{error}</p>
        )}

        {!loading && !error && groups.length === 0 && (
          <div style={emptyStyle}>
            <p style={{ margin: 0, fontSize: 16, color: inkSoft, fontFamily: bodyFontStack }}>
              You haven't registered for any tournaments yet.
            </p>
            <Link to="/" style={ctaPrimaryStyle}>
              Browse upcoming events
            </Link>
          </div>
        )}

        {!loading && !error && upcoming.length > 0 && (
          <Section
            title="Upcoming & Running"
            groups={upcoming}
            onWithdraw={startWithdraw}
          />
        )}

        {!loading && !error && past.length > 0 && (
          <Section title="Past" groups={past} onWithdraw={startWithdraw} />
        )}
      </div>

      {withdrawFlow && (
        <WithdrawModal
          flow={withdrawFlow}
          policy={activeGroup?.cancellation_policy_preset ?? null}
          onConfirm={executeWithdraw}
          onCancel={cancelWithdraw}
        />
      )}
    </div>
  );
}

function Section({
  title,
  groups,
  onWithdraw,
}: {
  title: string;
  groups: TournamentGroup[];
  onWithdraw: (
    regId: string,
    tournamentId: string,
    eventName: string
  ) => void;
}) {
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={sectionH2Style}>{title}</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {groups.map((g) => (
          <TournamentCard key={g.tournament_id} group={g} onWithdraw={onWithdraw} />
        ))}
      </div>
    </section>
  );
}

function TournamentCard({
  group,
  onWithdraw,
}: {
  group: TournamentGroup;
  onWithdraw: (
    regId: string,
    tournamentId: string,
    eventName: string
  ) => void;
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
          const tone = statusTone(reg.status, reg.partner_status);
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
                  {statusLabel(reg.status, reg.partner_status)}
                </span>
                {isWithdrawable(reg.status) && (
                  <button
                    style={withdrawBtnStyle}
                    onClick={(e) => {
                      e.stopPropagation();
                      onWithdraw(reg.id, group.tournament_id, reg.event_name);
                    }}
                  >
                    Withdraw
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

function WithdrawModal({
  flow,
  policy,
  onConfirm,
  onCancel,
}: {
  flow: WithdrawFlow;
  policy: CancellationPolicyPreset | null;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [executing, setExecuting] = useState(false);

  const handleConfirm = async () => {
    setExecuting(true);
    try {
      await onConfirm();
    } finally {
      setExecuting(false);
    }
  };

  const isLoading = flow.phase === "loading";
  const isError = flow.phase === "error";
  const isPreview = flow.phase === "preview";
  const isManual =
    isPreview && (flow as { preview: WithdrawPreview }).preview.decision === "manual_required";
  const busy = isLoading || executing;
  const showConfirm = isPreview && !isManual;

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
        aria-labelledby="withdraw-modal-title"
        style={modalStyle}
      >
        <h2
          id="withdraw-modal-title"
          style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 600 }}
        >
          {isManual
            ? "Withdrawal requires organizer review"
            : `Withdraw from ${flow.eventName}`}
        </h2>

        <div style={{ fontSize: 13, color: "#444", lineHeight: 1.6 }}>
          {isLoading && (
            <p style={{ margin: 0, color: "#6b7280" }}>
              Loading refund preview…
            </p>
          )}

          {isError && (
            <p style={{ margin: 0, color: "#dc2626" }}>
              {(flow as { message: string }).message}
            </p>
          )}

          {isPreview && (() => {
            const { preview } = flow as {
              preview: WithdrawPreview;
            };
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={previewRowStyle}>
                  <span style={previewLabelStyle}>Cancellation policy</span>
                  <span>{policyText(policy)}</span>
                </div>

                <div style={previewRowStyle}>
                  <span style={previewLabelStyle}>Refund</span>
                  <span>{refundSummaryText(preview)}</span>
                </div>

                {isManual && (
                  <p style={{ margin: 0, color: "#374151" }}>
                    Contact the organizer to request your refund. They will
                    review your case and process it manually.
                  </p>
                )}

                {preview.partner?.willUnpair && (
                  <div style={partnerWarningStyle}>
                    <strong>Partner notice:</strong> Withdrawing will unpair
                    your doubles partner, {preview.partner.name}. They will be
                    moved back to "Seeking partner."
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        <div style={modalFooterStyle}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={secondaryBtnStyle(busy)}
          >
            {isManual || isError ? "Close" : "Cancel"}
          </button>

          {showConfirm && (
            <button
              onClick={handleConfirm}
              disabled={executing}
              style={destructiveBtnStyle(executing)}
            >
              {executing ? "Working…" : "Confirm Withdrawal"}
            </button>
          )}
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

const withdrawBtnStyle: CSSProperties = {
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

const previewRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const previewLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#6b7280",
};

const partnerWarningStyle: CSSProperties = {
  background: "#fffbeb",
  border: "1px solid #fcd34d",
  borderRadius: 6,
  padding: "8px 12px",
  fontSize: 13,
  color: "#92400e",
};

const modalFooterStyle: CSSProperties = {
  marginTop: 20,
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
};

function destructiveBtnStyle(busy: boolean): CSSProperties {
  return {
    padding: "8px 16px",
    background: busy ? "var(--text-subtle)" : "var(--danger)",
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
