import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import {
  compactTierPriceLabel,
  groupTiersByTournament,
  type PricingTier,
} from "../../lib/pricingTiers";
import type { Database } from "../../types/supabase";
import {
  ink,
  inkSoft,
  inkMuted,
  bg,
  cream,
  rule,
  courtBlue,
  bodyFontStack,
  headingFontStack,
  displayFontStack,
  ctaPrimaryStyle,
  dangerBg,
  dangerFg,
  successBg,
  successFg,
  warnBg,
  warnFg,
  infoBg,
  infoFg,
} from "../../lib/publicTheme";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type TournamentStatus = Database["public"]["Enums"]["tournament_status"];

export default function TournamentsListPage() {
  const { org } = useCurrentOrg();
  const [tournaments, setTournaments] = useState<Tournament[] | null>(null);
  // Pricing tiers for the listed tournaments, keyed by tournament id.
  // Batch-loaded in one query to avoid N+1 across the table.
  const [tiersByTournament, setTiersByTournament] = useState<
    Map<string, PricingTier[]>
  >(new Map());
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
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org]);

  if (!org) return null;

  return (
    <div style={{ fontFamily: bodyFontStack, color: ink }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h1
          style={{
            margin: 0,
            fontFamily: displayFontStack,
            fontSize: "clamp(22px, 3.5vw, 32px)",
            lineHeight: 1.05,
            letterSpacing: "-0.2px",
            color: ink,
          }}
        >
          Tournaments
        </h1>
        <Link
          to={`/admin/${org.slug}/tournaments/new`}
          style={ctaPrimaryStyle}
        >
          + New tournament
        </Link>
      </header>

      {error && (
        <div
          style={{
            padding: "10px 14px",
            background: dangerBg,
            border: `1px solid ${dangerFg}`,
            borderRadius: 6,
            color: dangerFg,
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {tournaments === null ? (
        <div style={{ color: inkMuted, fontSize: 14 }}>Loading…</div>
      ) : tournaments.length === 0 ? (
        <div
          style={{
            padding: 32,
            textAlign: "center",
            background: bg,
            border: `1px dashed ${rule}`,
            borderRadius: 8,
            color: inkSoft,
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
                background: cream,
                borderBottom: `1px solid ${rule}`,
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
              <tr key={t.id} style={{ borderBottom: `1px solid ${rule}` }}>
                <td style={{ ...tdStyle, fontWeight: 500, color: ink }}>{t.name}</td>
                <td style={tdStyle}>
                  <StatusBadge status={t.status} />
                </td>
                <td style={{ ...tdStyle, color: inkSoft }}>
                  {fmtDate(t.starts_at)} – {fmtDate(t.ends_at)}
                </td>
                <td style={{ ...tdStyle, color: inkSoft }}>
                  {compactTierPriceLabel(tiersByTournament.get(t.id) ?? [])}
                </td>
                <td style={{ ...tdStyle, textAlign: "right" }}>
                  <Link
                    to={`/admin/${org.slug}/tournaments/${t.slug}`}
                    style={{
                      color: courtBlue,
                      textDecoration: "none",
                      fontSize: 13,
                      fontWeight: 500,
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
  fontSize: 11,
  color: inkMuted,
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  fontWeight: 600,
  fontFamily: headingFontStack,
};

const tdStyle = {
  padding: "12px",
};

function StatusBadge({ status }: { status: TournamentStatus }) {
  const palette: Record<TournamentStatus, { bg: string; fg: string }> = {
    draft:     { bg: cream,      fg: inkSoft   },
    published: { bg: successBg,  fg: successFg },
    closed:    { bg: warnBg,     fg: warnFg    },
    completed: { bg: infoBg,     fg: infoFg    },
    cancelled: { bg: dangerBg,   fg: dangerFg  },
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
        fontWeight: 600,
        fontFamily: bodyFontStack,
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
