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
      <h2 style={sectionH2Style}>{title}</h2>
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
        {group.regs.map((reg) => {
          const tone = statusTone(reg.status, reg.partner_status);
          return (
            <div key={reg.id} style={regRowStyle}>
              <span style={eventNameStyle}>{reg.event_name}</span>
              <span
                style={{
                  ...statusPillStyle,
                  color: tone.color,
                  background: tone.background,
                }}
              >
                {statusLabel(reg.status, reg.partner_status)}
              </span>
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
