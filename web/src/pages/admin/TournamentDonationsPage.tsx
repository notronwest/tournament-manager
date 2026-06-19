import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { formatUsd } from "../../lib/pricing";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Donation = Database["public"]["Tables"]["donations"]["Row"];

// Read-only organizer report for charity donations (#377). Shows total
// raised (succeeded only) + the donor list. RLS already restricts the
// donations table to org members, so a non-member can't read donor PII even
// if they reach this route.
export default function TournamentDonationsPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [donations, setDonations] = useState<Donation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!org || !tournamentSlug) return;
    setError(null);

    const { data: tData, error: tErr } = await supabase
      .from("tournaments")
      .select("*")
      .eq("organization_id", org.id)
      .eq("slug", tournamentSlug)
      .is("deleted_at", null)
      .maybeSingle();
    if (tErr) { setError(tErr.message); setLoading(false); return; }
    if (!tData) { setError("Tournament not found."); setLoading(false); return; }
    setTournament(tData);

    const { data: dData, error: dErr } = await supabase
      .from("donations")
      .select("*")
      .eq("tournament_id", tData.id)
      .order("created_at", { ascending: false });
    if (dErr) { setError(dErr.message); setLoading(false); return; }
    setDonations(dData ?? []);
    setLoading(false);
  }, [org, tournamentSlug]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  if (!org || loading) return <div style={pageStyle}>Loading…</div>;
  if (error) return <div style={pageStyle}><div style={errorStyle}>{error}</div></div>;
  if (!tournament) return null;

  // "Paid" = the succeeded enum value (mirrors payments). Only successful
  // donations count toward the total raised.
  const paid = donations.filter((d) => d.status === "succeeded");
  const totalRaised = paid.reduce((sum, d) => sum + d.amount_cents, 0);

  return (
    <div style={pageStyle}>
      <nav style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
        <Link
          to={`/admin/${org.slug}/tournaments/${tournament.slug}`}
          style={{ color: "#2563eb", textDecoration: "none" }}
        >
          {tournament.name}
        </Link>
        {" / Donations"}
      </nav>

      <h1 style={{ margin: "0 0 20px", fontSize: 20, fontWeight: 700 }}>
        Donations
      </h1>

      <div style={statRowStyle}>
        <Stat label="Total raised" value={formatUsd(totalRaised)} />
        <Stat label="Donations" value={String(paid.length)} />
      </div>

      {donations.length === 0 ? (
        <div style={emptyStyle}>
          No donations yet. They’ll appear here once supporters give through
          the public “Donate” button.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {donations.map((d) => (
            <DonationRow key={d.id} donation={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={statCardStyle}>
      <div style={{ fontSize: 12, color: "#777", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: "#14181f" }}>{value}</div>
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function DonationRow({ donation: d }: { donation: Donation }) {
  return (
    <div style={rowCardStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{d.donor_name}</span>
          <span style={{ fontSize: 13, color: "#555" }}>{d.donor_email}</span>
          <StatusBadge status={d.status} />
        </div>
        {d.message && (
          <div style={{ marginTop: 4, fontSize: 13, color: "#444", fontStyle: "italic" }}>
            “{d.message}”
          </div>
        )}
        <div style={{ marginTop: 4, fontSize: 12, color: "#777" }}>
          {fmtDate(d.created_at)}
        </div>
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, flexShrink: 0, color: "#14181f" }}>
        {formatUsd(d.amount_cents)}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Donation["status"] }) {
  // succeeded → "Paid"; everything else shows its raw state.
  const map: Record<string, { label: string; bg: string; fg: string }> = {
    succeeded: { label: "Paid", bg: "#dcfce7", fg: "#16a34a" },
    pending: { label: "Pending", bg: "#fef9c3", fg: "#a16207" },
    processing: { label: "Processing", bg: "#fef9c3", fg: "#a16207" },
    failed: { label: "Failed", bg: "#fee2e2", fg: "#dc2626" },
    refunded: { label: "Refunded", bg: "#f3f4f6", fg: "#6b7280" },
    partially_refunded: { label: "Partially refunded", bg: "#f3f4f6", fg: "#6b7280" },
  };
  const s = map[status] ?? { label: status, bg: "#f3f4f6", fg: "#6b7280" };
  return (
    <span
      style={{
        padding: "2px 6px",
        background: s.bg,
        color: s.fg,
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 500,
      }}
    >
      {s.label}
    </span>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  padding: "24px 32px",
  maxWidth: 720,
};

const errorStyle: CSSProperties = {
  color: "#dc2626",
  fontSize: 13,
};

const emptyStyle: CSSProperties = {
  padding: "24px 0",
  color: "#888",
  fontSize: 13,
};

const statRowStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  marginBottom: 24,
};

const statCardStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: "16px 20px",
  minWidth: 140,
};

const rowCardStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: "12px 16px",
  display: "flex",
  gap: 12,
  alignItems: "center",
};
