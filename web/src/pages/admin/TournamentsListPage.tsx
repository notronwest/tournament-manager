import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import {
  compactTierPriceLabel,
  groupTiersByTournament,
  type PricingTier,
} from "../../lib/pricingTiers";
import { ConfirmModal } from "../../components/ConfirmModal";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type TournamentStatus = Database["public"]["Enums"]["tournament_status"];
type View = "current" | "archived";

interface DeleteCandidate {
  tournament: Tournament;
  paidRegCount: number;
}

export default function TournamentsListPage() {
  const { org } = useCurrentOrg();
  const [view, setView] = useState<View>("current");
  const [tournaments, setTournaments] = useState<Tournament[] | null>(null);
  const [tiersByTournament, setTiersByTournament] = useState<
    Map<string, PricingTier[]>
  >(new Map());
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] =
    useState<DeleteCandidate | null>(null);

  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    (async () => {
      let query = supabase
        .from("tournaments")
        .select("*")
        .eq("organization_id", org.id)
        .is("deleted_at", null)
        .order("starts_at", { ascending: false });

      if (view === "current") {
        query = query.is("archived_at", null);
      } else {
        query = query.not("archived_at", "is", null);
      }

      const { data, error } = await query;

      if (cancelled) return;
      if (error) {
        setError(error.message);
        return;
      }
      setError(null);
      const rows = data ?? [];
      setTournaments(rows);

      if (rows.length > 0) {
        const { data: tierRows } = await supabase
          .from("tournament_pricing_tiers")
          .select("*")
          .in(
            "tournament_id",
            rows.map((t) => t.id),
          );
        if (cancelled) return;
        setTiersByTournament(groupTiersByTournament(tierRows ?? []));
      } else {
        setTiersByTournament(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org, view]);

  async function handleArchive(t: Tournament) {
    setLoadingAction(t.id);
    setActionError(null);
    const { error } = await supabase
      .from("tournaments")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", t.id);
    setLoadingAction(null);
    if (error) {
      setActionError(error.message);
      return;
    }
    setTournaments((prev) => prev?.filter((x) => x.id !== t.id) ?? prev);
  }

  async function handleUnarchive(t: Tournament) {
    setLoadingAction(t.id);
    setActionError(null);
    const { error } = await supabase
      .from("tournaments")
      .update({ archived_at: null })
      .eq("id", t.id);
    setLoadingAction(null);
    if (error) {
      setActionError(error.message);
      return;
    }
    setTournaments((prev) => prev?.filter((x) => x.id !== t.id) ?? prev);
  }

  async function initiateDelete(t: Tournament) {
    setPendingDeleteId(t.id);
    setActionError(null);
    const { count } = await supabase
      .from("registrations")
      .select("id", { count: "exact", head: true })
      .eq("tournament_id", t.id)
      .in("status", ["paid", "pending_payment"]);
    setPendingDeleteId(null);
    setDeleteCandidate({ tournament: t, paidRegCount: count ?? 0 });
  }

  async function executeDelete(t: Tournament) {
    const { error } = await supabase
      .from("tournaments")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", t.id);
    if (error) throw error;
    setTournaments((prev) => prev?.filter((x) => x.id !== t.id) ?? prev);
    setDeleteCandidate(null);
  }

  if (!org) return null;

  return (
    <div>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>Tournaments</h1>
        <Link
          to={`/admin/${org.slug}/tournaments/new`}
          style={{
            padding: "8px 16px",
            background: "var(--primary)",
            color: "var(--primary-contrast)",
            textDecoration: "none",
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          + New tournament
        </Link>
      </header>

      <div
        role="tablist"
        style={{
          display: "flex",
          borderBottom: "1px solid var(--border)",
          marginBottom: 20,
        }}
      >
        {(["current", "archived"] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            style={tabBtnStyle(view === v)}
          >
            {v === "current" ? "Current" : "Archived"}
          </button>
        ))}
      </div>

      {actionError && (
        <div
          style={{
            padding: 12,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 6,
            color: "#991b1b",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {actionError}
        </div>
      )}

      {error && (
        <div
          style={{
            padding: 12,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 6,
            color: "#991b1b",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {tournaments === null ? (
        <div style={{ color: "#666", fontSize: 14 }}>Loading…</div>
      ) : tournaments.length === 0 ? (
        <div
          style={{
            padding: 32,
            textAlign: "center",
            background: "#fafafa",
            border: "1px dashed #d1d5db",
            borderRadius: 6,
            color: "#666",
            fontSize: 14,
          }}
        >
          {view === "current"
            ? "No active tournaments. Create your first one to get started."
            : "No archived tournaments."}
        </div>
      ) : (
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}
        >
          <thead>
            <tr
              style={{
                background: "#fafafa",
                borderBottom: "1px solid #e2e2e2",
              }}
            >
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Dates</th>
              <th style={thStyle}>Entry fee</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {tournaments.map((t) => {
              const busy =
                loadingAction === t.id || pendingDeleteId === t.id;
              return (
                <tr key={t.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ ...tdStyle, fontWeight: 500 }}>
                    <Link
                      to={`/admin/${org.slug}/tournaments/${t.slug}`}
                      style={{
                        color: "var(--primary)",
                        textDecoration: "none",
                      }}
                    >
                      {t.name}
                    </Link>
                  </td>
                  <td style={tdStyle}>
                    <StatusBadge status={t.status} />
                  </td>
                  <td style={{ ...tdStyle, color: "#666" }}>
                    {fmtDate(t.starts_at)} – {fmtDate(t.ends_at)}
                  </td>
                  <td style={{ ...tdStyle, color: "#666" }}>
                    {compactTierPriceLabel(tiersByTournament.get(t.id) ?? [])}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {view === "current" ? (
                      <button
                        onClick={() => handleArchive(t)}
                        disabled={busy}
                        style={rowActionBtn(busy, false)}
                      >
                        {loadingAction === t.id ? "…" : "Archive"}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleUnarchive(t)}
                        disabled={busy}
                        style={rowActionBtn(busy, false)}
                      >
                        {loadingAction === t.id ? "…" : "Unarchive"}
                      </button>
                    )}
                    <button
                      onClick={() => initiateDelete(t)}
                      disabled={busy}
                      style={{ ...rowActionBtn(busy, true), marginLeft: 12 }}
                    >
                      {pendingDeleteId === t.id ? "…" : "Delete"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {deleteCandidate && (
        <ConfirmModal
          title="Delete tournament?"
          body={
            deleteCandidate.paidRegCount > 0 ? (
              <div>
                <p
                  style={{
                    margin: "0 0 12px",
                    fontWeight: 600,
                    color: "var(--danger)",
                  }}
                >
                  Warning: {deleteCandidate.paidRegCount} paid or pending
                  registration
                  {deleteCandidate.paidRegCount !== 1 ? "s" : ""} exist for
                  this tournament.
                </p>
                <p style={{ margin: "0 0 8px" }}>
                  Deleting{" "}
                  <strong>{deleteCandidate.tournament.name}</strong> will hide
                  it from all views. Payment and registration records are
                  preserved and remain recoverable by an admin.
                </p>
                <p style={{ margin: 0 }}>
                  Consider archiving instead — it hides the tournament without
                  affecting any records.
                </p>
              </div>
            ) : (
              <>
                Delete <strong>{deleteCandidate.tournament.name}</strong>? This
                is a soft delete — the tournament is hidden but its data remains
                recoverable.
              </>
            )
          }
          confirmLabel={
            deleteCandidate.paidRegCount > 0 ? "Delete anyway" : "Delete"
          }
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={() => executeDelete(deleteCandidate.tournament)}
        />
      )}
    </div>
  );
}

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 12,
  color: "#888",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontWeight: 500,
};

const tdStyle: CSSProperties = {
  padding: "12px",
};

function tabBtnStyle(selected: boolean): CSSProperties {
  return {
    padding: "10px 16px",
    background: "none",
    border: "none",
    borderBottom: selected
      ? "2px solid var(--primary)"
      : "2px solid transparent",
    color: selected ? "var(--primary)" : "var(--text-muted)",
    fontSize: 14,
    fontWeight: selected ? 600 : 400,
    cursor: "pointer",
    fontFamily: "inherit",
    marginBottom: -1,
  };
}

function rowActionBtn(busy: boolean, destructive: boolean): CSSProperties {
  return {
    background: "none",
    border: "none",
    color: destructive ? "var(--danger)" : "var(--text-muted)",
    fontSize: 13,
    cursor: busy ? "not-allowed" : "pointer",
    padding: "4px 0",
    fontFamily: "inherit",
    opacity: busy ? 0.5 : 1,
  };
}

function StatusBadge({ status }: { status: TournamentStatus }) {
  const palette: Record<TournamentStatus, { bg: string; fg: string }> = {
    draft: { bg: "#f3f4f6", fg: "#666" },
    published: { bg: "#dcfce7", fg: "#166534" },
    closed: { bg: "#fef3c7", fg: "#92400e" },
    completed: { bg: "#dbeafe", fg: "#1e40af" },
    cancelled: { bg: "#fee2e2", fg: "#991b1b" },
  };
  const c = palette[status];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        background: c.bg,
        color: c.fg,
        borderRadius: 4,
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      {status}
    </span>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
