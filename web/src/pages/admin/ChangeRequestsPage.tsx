import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { useAuth } from "../../auth/AuthProvider";
import type { Database } from "../../types/supabase";
import {
  ink,
  inkSoft,
  inkMuted,
  rule,
  ruleSoft,
  bg,
  cream,
  courtBlue,
  successBg,
  successFg,
  dangerBg,
  dangerFg,
  warnBg,
  warnFg,
  breadcrumbLinkStyle,
  pageH1Style,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
  bodyFontStack,
} from "../../lib/publicTheme";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type ChangeRequest =
  Database["public"]["Tables"]["tournament_change_requests"]["Row"];
type ChangeRequestKind =
  Database["public"]["Enums"]["change_request_kind"];
type ChangeRequestStatus =
  Database["public"]["Enums"]["change_request_status"];

type RequestRow = ChangeRequest & {
  player: { first_name: string; last_name: string; email: string | null } | null;
};

const KIND_LABELS: Record<ChangeRequestKind, string> = {
  division_change: "Division change",
  partner_change: "Partner change",
  withdrawal: "Withdrawal",
  other: "Other",
};

const STATUS_COLORS: Record<
  ChangeRequestStatus,
  { bg: string; fg: string }
> = {
  open: { bg: warnBg, fg: warnFg },
  approved: { bg: successBg, fg: successFg },
  denied: { bg: dangerBg, fg: dangerFg },
  cancelled: { bg: bg, fg: inkMuted },
};

function StatusBadge({ status }: { status: ChangeRequestStatus }) {
  const c = STATUS_COLORS[status];
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: c.bg,
        color: c.fg,
        textTransform: "capitalize",
        whiteSpace: "nowrap",
      }}
    >
      {status}
    </span>
  );
}

function KindBadge({ kind }: { kind: ChangeRequestKind }) {
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        background: bg,
        color: inkSoft,
        whiteSpace: "nowrap",
        border: `1px solid ${ruleSoft}`,
      }}
    >
      {KIND_LABELS[kind]}
    </span>
  );
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function extractNote(payload: unknown): string {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "note" in payload &&
    typeof (payload as Record<string, unknown>).note === "string"
  ) {
    return (payload as Record<string, string>).note;
  }
  return "";
}

export default function ChangeRequestsPage() {
  const { org } = useCurrentOrg();
  const { user } = useAuth();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"open" | "all">("open");

  // Expanded row tracking + resolution form state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");
  const [resolutionStatus, setResolutionStatus] = useState<"approved" | "denied">("approved");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // Increment to trigger a reload after resolve
  const [loadTick, setLoadTick] = useState(0);

  useEffect(() => {
    if (!org || !tournamentSlug) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);

      const { data: t, error: tErr } = await supabase
        .from("tournaments")
        .select("*")
        .eq("organization_id", org.id)
        .eq("slug", tournamentSlug)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (tErr) { setError(tErr.message); setLoading(false); return; }
      if (!t) { setError("Tournament not found."); setLoading(false); return; }
      setTournament(t);

      const { data, error: rErr } = await supabase
        .from("tournament_change_requests")
        .select("*, player:players!player_id(first_name, last_name, email)")
        .eq("tournament_id", t.id)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (rErr) { setError(rErr.message); setLoading(false); return; }

      setRows((data ?? []) as unknown as RequestRow[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [org, tournamentSlug, loadTick]);

  const resolve = async (req: RequestRow, status: "approved" | "denied") => {
    if (!user) return;
    setResolving(true);
    setResolveError(null);
    const { error: err } = await supabase
      .from("tournament_change_requests")
      .update({
        status,
        organizer_resolution: resolution.trim() || null,
        resolved_by: user.id,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.id);
    setResolving(false);
    if (err) { setResolveError(err.message); return; }
    setExpandedId(null);
    setResolution("");
    setLoadTick((t) => t + 1);
  };

  if (!org) return null;

  if (loading)
    return <div style={{ color: inkMuted, fontSize: 14, fontFamily: bodyFontStack }}>Loading…</div>;

  if (error) {
    return (
      <div
        style={{
          padding: 12,
          background: dangerBg,
          border: `1px solid ${dangerFg}40`,
          borderRadius: 6,
          color: dangerFg,
          fontSize: 14,
          fontFamily: bodyFontStack,
        }}
      >
        {error}
      </div>
    );
  }

  if (!tournament) return null;

  const visible =
    tab === "open" ? rows.filter((r) => r.status === "open") : rows;

  const openCount = rows.filter((r) => r.status === "open").length;

  const tabBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: "6px 16px",
    borderRadius: 6,
    border: "1px solid",
    borderColor: active ? ink : rule,
    background: active ? ink : "#fff",
    color: active ? bg : inkSoft,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: bodyFontStack,
  });

  return (
    <div style={{ fontFamily: bodyFontStack }}>
      <Link
        to={`/admin/${org.slug}/tournaments/${tournament.slug}`}
        style={breadcrumbLinkStyle}
      >
        ← {tournament.name}
      </Link>

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          margin: "16px 0 20px",
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ ...pageH1Style, fontSize: 22, margin: 0 }}>
          Change requests
        </h1>
        {openCount > 0 && (
          <span
            style={{
              padding: "2px 10px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 700,
              background: warnBg,
              color: warnFg,
            }}
          >
            {openCount} open
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button style={tabBtnStyle(tab === "open")} onClick={() => setTab("open")}>
          Open ({openCount})
        </button>
        <button style={tabBtnStyle(tab === "all")} onClick={() => setTab("all")}>
          All ({rows.length})
        </button>
      </div>

      {visible.length === 0 ? (
        <div
          style={{
            padding: "32px 0",
            textAlign: "center",
            color: inkMuted,
            fontSize: 14,
          }}
        >
          {tab === "open" ? "No open requests." : "No requests yet."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {visible.map((req) => {
            const expanded = expandedId === req.id;
            const playerName = req.player
              ? `${req.player.first_name} ${req.player.last_name}`.trim()
              : "Unknown player";
            const note = extractNote(req.payload);

            return (
              <div
                key={req.id}
                style={{
                  border: `1px solid ${req.status === "open" ? `${courtBlue}40` : rule}`,
                  borderRadius: 8,
                  background: req.status === "open" ? cream : "#fff",
                  overflow: "hidden",
                }}
              >
                {/* Row header */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "12px 16px",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ flexGrow: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: 14,
                        color: ink,
                        marginBottom: 2,
                      }}
                    >
                      {playerName}
                    </div>
                    {req.player?.email && (
                      <div style={{ fontSize: 12, color: inkMuted }}>
                        {req.player.email}
                      </div>
                    )}
                    {note && (
                      <div
                        style={{
                          fontSize: 13,
                          color: inkSoft,
                          marginTop: 4,
                          lineHeight: 1.45,
                        }}
                      >
                        {note}
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                      flexShrink: 0,
                    }}
                  >
                    <KindBadge kind={req.kind} />
                    <StatusBadge status={req.status} />
                    <span
                      style={{ fontSize: 11, color: inkMuted, whiteSpace: "nowrap" }}
                    >
                      {fmtDate(req.created_at)}
                    </span>
                  </div>

                  {req.status === "open" && (
                    <button
                      type="button"
                      onClick={() => {
                        setExpandedId(expanded ? null : req.id);
                        setResolution("");
                        setResolutionStatus("approved");
                        setResolveError(null);
                      }}
                      style={{
                        padding: "6px 14px",
                        borderRadius: 6,
                        border: `1px solid ${rule}`,
                        background: "#fff",
                        color: inkSoft,
                        fontSize: 13,
                        fontWeight: 500,
                        cursor: "pointer",
                        fontFamily: bodyFontStack,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      {expanded ? "Close" : "Respond"}
                    </button>
                  )}
                </div>

                {/* Resolution panel */}
                {req.status !== "open" && req.organizer_resolution && (
                  <div
                    style={{
                      borderTop: `1px solid ${rule}`,
                      padding: "10px 16px",
                      background: bg,
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 600, color: inkMuted, marginBottom: 2 }}>
                      Organizer reply
                    </div>
                    <div style={{ fontSize: 13, color: inkSoft }}>
                      {req.organizer_resolution}
                    </div>
                  </div>
                )}

                {expanded && req.status === "open" && (
                  <div
                    style={{
                      borderTop: `1px solid ${rule}`,
                      padding: "14px 16px",
                      background: "#fff",
                    }}
                  >
                    <label
                      style={{ fontSize: 12, fontWeight: 600, color: inkSoft }}
                    >
                      Resolution
                    </label>
                    <select
                      value={resolutionStatus}
                      onChange={(e) =>
                        setResolutionStatus(e.target.value as "approved" | "denied")
                      }
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: 6,
                        padding: "8px 10px",
                        border: `1px solid ${rule}`,
                        borderRadius: 6,
                        fontSize: 13,
                        fontFamily: bodyFontStack,
                        background: "#fff",
                        color: ink,
                        boxSizing: "border-box",
                      }}
                    >
                      <option value="approved">Approved</option>
                      <option value="denied">Denied</option>
                    </select>

                    <label
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: inkSoft,
                        display: "block",
                        marginTop: 12,
                      }}
                    >
                      Reply to player (optional)
                    </label>
                    <textarea
                      value={resolution}
                      onChange={(e) => setResolution(e.target.value)}
                      rows={3}
                      placeholder="Explain your decision…"
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: 6,
                        padding: "8px 10px",
                        border: `1px solid ${rule}`,
                        borderRadius: 6,
                        fontSize: 13,
                        fontFamily: bodyFontStack,
                        resize: "vertical",
                        boxSizing: "border-box",
                        color: ink,
                      }}
                    />
                    {resolveError && (
                      <div
                        style={{
                          marginTop: 8,
                          fontSize: 13,
                          color: dangerFg,
                        }}
                      >
                        {resolveError}
                      </div>
                    )}
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        marginTop: 12,
                        flexWrap: "wrap",
                      }}
                    >
                      <button
                        type="button"
                        disabled={resolving}
                        onClick={() => void resolve(req, resolutionStatus)}
                        style={resolving ? { ...ctaPrimaryStyle, opacity: 0.7, cursor: "not-allowed" } : ctaPrimaryStyle}
                      >
                        {resolving ? "Sending…" : "Send"}
                      </button>
                      <button
                        type="button"
                        disabled={resolving}
                        onClick={() => {
                          setExpandedId(null);
                          setResolution("");
                          setResolutionStatus("approved");
                          setResolveError(null);
                        }}
                        style={resolving ? { ...ctaSecondaryStyle, opacity: 0.7, cursor: "not-allowed" } : ctaSecondaryStyle}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
