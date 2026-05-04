import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type TournamentStatus = Database["public"]["Enums"]["tournament_status"];

export default function TournamentsListPage() {
  const { org } = useCurrentOrg();
  const [tournaments, setTournaments] = useState<Tournament[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("tournaments")
        .select("*")
        .eq("organization_id", org.id)
        .is("deleted_at", null)
        .order("starts_at", { ascending: false });

      if (cancelled) return;
      if (error) {
        setError(error.message);
        return;
      }
      setTournaments(data ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [org]);

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
            background: "#2563eb",
            color: "#fff",
            textDecoration: "none",
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          + New tournament
        </Link>
      </header>

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
          No tournaments yet. Create your first one to get started.
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
            {tournaments.map((t) => (
              <tr key={t.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <td style={{ ...tdStyle, fontWeight: 500 }}>{t.name}</td>
                <td style={tdStyle}>
                  <StatusBadge status={t.status} />
                </td>
                <td style={{ ...tdStyle, color: "#666" }}>
                  {fmtDate(t.starts_at)} – {fmtDate(t.ends_at)}
                </td>
                <td style={{ ...tdStyle, color: "#666" }}>
                  ${(t.entry_fee_cents / 100).toFixed(2)}
                </td>
                <td style={{ ...tdStyle, textAlign: "right" }}>
                  <Link
                    to={`/admin/${org.slug}/tournaments/${t.slug}`}
                    style={{
                      color: "#2563eb",
                      textDecoration: "none",
                      fontSize: 13,
                    }}
                  >
                    Open →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const thStyle = {
  textAlign: "left" as const,
  padding: "10px 12px",
  fontSize: 12,
  color: "#888",
  textTransform: "uppercase" as const,
  letterSpacing: 0.5,
  fontWeight: 500,
};

const tdStyle = {
  padding: "12px",
};

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
