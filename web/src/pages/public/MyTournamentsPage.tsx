import { useEffect, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../../supabase";
import { useAuth } from "../../auth/AuthProvider";
import type { Database } from "../../types/supabase";

type RegistrationStatus = Database["public"]["Enums"]["registration_status"];
type PartnerStatus = Database["public"]["Enums"]["partner_status"];

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
  regs: EventReg[];
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

function statusColor(
  regStatus: RegistrationStatus,
  partnerStatus: PartnerStatus
): string {
  if (
    regStatus === "cancelled" ||
    regStatus === "withdrawn" ||
    regStatus === "refunded"
  )
    return "#6b7280";
  if (regStatus === "pending_payment") return "#d97706";
  if (partnerStatus === "seeking" || partnerStatus === "pending")
    return "#2563eb";
  return "#16a34a";
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

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);

      // Resolve auth user → player record.
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

      // Group by tournament.
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

  const upcoming = groups
    .filter((g) => !isPast(g))
    .sort(
      (a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
    );
  const past = groups
    .filter(isPast)
    .sort(
      (a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime()
    );

  return (
    <div style={pageStyle}>
      <div style={contentStyle}>
        <h1 style={headingStyle}>My Tournaments</h1>

        {loading && (
          <p style={{ color: "#6b7280", marginTop: 24 }}>Loading…</p>
        )}

        {error && (
          <p style={{ color: "#dc2626", marginTop: 24 }}>{error}</p>
        )}

        {!loading && !error && groups.length === 0 && (
          <div style={emptyStyle}>
            <p style={{ margin: 0, fontSize: 16, color: "#374151" }}>
              You haven't registered for any tournaments yet.
            </p>
            <Link to="/" style={browseLinkStyle}>
              Browse upcoming events
            </Link>
          </div>
        )}

        {!loading && !error && upcoming.length > 0 && (
          <Section title="Upcoming & Running" groups={upcoming} />
        )}

        {!loading && !error && past.length > 0 && (
          <Section title="Past" groups={past} />
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  groups,
}: {
  title: string;
  groups: TournamentGroup[];
}) {
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={sectionHeadingStyle}>{title}</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {groups.map((g) => (
          <TournamentCard key={g.tournament_id} group={g} />
        ))}
      </div>
    </section>
  );
}

function TournamentCard({ group }: { group: TournamentGroup }) {
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
        {group.regs.map((reg) => (
          <div key={reg.id} style={regRowStyle}>
            <span style={eventNameStyle}>{reg.event_name}</span>
            <span
              style={{
                ...statusPillStyle,
                color: statusColor(reg.status, reg.partner_status),
                background: statusColor(reg.status, reg.partner_status) + "18",
              }}
            >
              {statusLabel(reg.status, reg.partner_status)}
            </span>
          </div>
        ))}
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

// ─── Styles ───────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  background: "#f9fafb",
  paddingBottom: 64,
};

const contentStyle: CSSProperties = {
  maxWidth: 720,
  margin: "0 auto",
  padding: "40px 24px 0",
};

const headingStyle: CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  color: "#111827",
  margin: 0,
};

const sectionHeadingStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: "#6b7280",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  margin: "0 0 12px",
};

const cardStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: "20px 24px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  cursor: "pointer",
};

const cardHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
};

const cardTitleStyle: CSSProperties = {
  fontSize: 17,
  fontWeight: 600,
  color: "#111827",
  textDecoration: "none",
};

const cardMetaStyle: CSSProperties = {
  fontSize: 13,
  color: "#6b7280",
  margin: "2px 0 0",
};

const regRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "6px 0",
  borderTop: "1px solid #f3f4f6",
};

const eventNameStyle: CSSProperties = {
  fontSize: 14,
  color: "#374151",
};

const statusPillStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  padding: "2px 8px",
  borderRadius: 9999,
  whiteSpace: "nowrap",
};

const emptyStyle: CSSProperties = {
  marginTop: 48,
  textAlign: "center",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 16,
};

const cardFooterStyle: CSSProperties = {
  borderTop: "1px solid #f3f4f6",
  paddingTop: 10,
  marginTop: 2,
};

const viewLinkStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: "#2563eb",
  textDecoration: "none",
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
