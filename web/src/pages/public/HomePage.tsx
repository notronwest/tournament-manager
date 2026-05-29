import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../supabase";
import {
  compactTierPriceLabel,
  type PricingTier,
} from "../../lib/pricingTiers";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Organization = Database["public"]["Tables"]["organizations"]["Row"];

// A tournament joined to its org + its pricing tiers. Supabase's
// PostgREST returns the related org as a single object (not an array)
// for to-one relations, but the generated types insist on
// `Organization | null` so we have to be defensive on read. Pricing
// tiers are a to-many embed.
type TournamentWithOrg = Tournament & {
  organizations: Pick<Organization, "name" | "slug"> | null;
  tournament_pricing_tiers: PricingTier[] | null;
};

// Public landing page at /. Lists every published tournament across
// every org, sorted by start date, with a name/org search box on
// top. Anon-readable thanks to existing RLS (tournaments + orgs in
// statuses published/closed/completed). Each card links to the
// existing /t/:orgSlug/:tournamentSlug detail page.
//
// "Upcoming" is defined as `ends_at >= today` — that way a tournament
// that's currently underway still shows up; it only disappears the
// day after it wraps.
//
// We load all matching tournaments in one shot and filter in-memory.
// Volumes will stay small (probably double digits of published
// tournaments at any moment), and server-side joined-table search
// via PostgREST is awkward. Revisit if we ever break a few hundred.
export default function HomePage() {
  const [tournaments, setTournaments] = useState<TournamentWithOrg[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);

      // today-at-midnight so the filter is stable across the day —
      // a tournament ending today is "upcoming" all the way until
      // tomorrow morning.
      const todayIso = new Date(
        new Date().getFullYear(),
        new Date().getMonth(),
        new Date().getDate(),
      ).toISOString();

      const { data, error: err } = await supabase
        .from("tournaments")
        .select(
          "id, name, slug, starts_at, ends_at, location_name, location_address, entry_fee_cents, status, organization_id, court_count, inter_event_buffer_minutes, registration_opens_at, registration_closes_at, description, created_at, updated_at, deleted_at, organizations:organization_id (name, slug), tournament_pricing_tiers (id, sort_order, label, starts_at, ends_at, first_event_fee_cents, additional_event_fee_cents, tournament_id, created_at, updated_at)",
        )
        .eq("status", "published")
        .gte("ends_at", todayIso)
        .is("deleted_at", null)
        .order("starts_at", { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      // The PostgREST embed gives us `organizations` as a single
      // object on to-one relations, but the generated TS thinks it
      // could be an array. Cast through unknown to flatten.
      setTournaments(
        (data ?? []) as unknown as TournamentWithOrg[],
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tournaments;
    return tournaments.filter((t) => {
      const haystack = [
        t.name,
        t.organizations?.name ?? "",
        t.location_name ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [tournaments, query]);

  return (
    <Shell>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>
          Find a pickleball tournament
        </h1>
        <p
          style={{
            color: "#555",
            margin: "8px 0 0",
            fontSize: 15,
            lineHeight: 1.5,
          }}
        >
          Upcoming events from every organizer on Tournament Manager.
          Pick one to see the details and register.
        </p>
      </header>

      <div style={{ marginBottom: 20 }}>
        <input
          type="search"
          placeholder="Search by tournament, organizer, or location…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            width: "100%",
            padding: "12px 14px",
            border: "1px solid #e2e2e2",
            borderRadius: 8,
            fontSize: 15,
            fontFamily: "inherit",
            background: "#fff",
          }}
        />
      </div>

      {loading ? (
        <p style={{ color: "#666", fontSize: 14 }}>Loading…</p>
      ) : error ? (
        <ErrorPanel>{error}</ErrorPanel>
      ) : filtered.length === 0 ? (
        <Empty>
          {query
            ? (
              <>
                No tournaments match <strong>"{query}"</strong>.{" "}
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  style={clearBtnStyle}
                >
                  Clear search
                </button>
              </>
            )
            : tournaments.length === 0
              ? "No upcoming tournaments yet. Check back soon."
              : "No matches."}
        </Empty>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {filtered.map((t) => (
            <TournamentCard key={t.id} tournament={t} />
          ))}
        </div>
      )}

    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Card
// ─────────────────────────────────────────────────────────────────────

function TournamentCard({ tournament }: { tournament: TournamentWithOrg }) {
  const org = tournament.organizations;
  // Defensive: if RLS hid the org row somehow, we can't link safely.
  // In practice this shouldn't happen — RLS lets us see published
  // tournament rows AND their org row — but skipping the card beats
  // rendering a broken link.
  if (!org) return null;

  const dateRange = fmtDateRange(tournament.starts_at, tournament.ends_at);

  return (
    <Link
      to={`/t/${org.slug}/${tournament.slug}`}
      style={{
        display: "block",
        padding: 16,
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        textDecoration: "none",
        color: "inherit",
        transition: "border-color 120ms, box-shadow 120ms",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "#bfdbfe";
        e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "#e5e7eb";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
          {tournament.name}
        </h2>
        <span style={{ color: "#666", fontSize: 13 }}>{dateRange}</span>
      </div>
      <div
        style={{
          marginTop: 6,
          color: "#666",
          fontSize: 13,
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span>{org.name}</span>
        {tournament.location_name && (
          <span style={{ color: "#888" }}>· {tournament.location_name}</span>
        )}
        {(() => {
          const tiers = tournament.tournament_pricing_tiers ?? [];
          const label = compactTierPriceLabel(tiers);
          // Hide the chip for free tournaments / when no tiers loaded.
          if (label === "Free" || label === "—") return null;
          return <span style={{ color: "#888" }}>· {label} entry</span>;
        })()}
      </div>
    </Link>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bits
// ─────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: ReactNode }) {
  return (
    <main
      style={{
        padding: "32px 24px",
        maxWidth: 760,
        margin: "0 auto",
      }}
    >
      {children}
    </main>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: 32,
        textAlign: "center",
        background: "#fafafa",
        border: "1px dashed #d1d5db",
        borderRadius: 8,
        color: "#666",
        fontSize: 14,
      }}
    >
      {children}
    </div>
  );
}

function ErrorPanel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: 14,
        background: "#fef2f2",
        border: "1px solid #fecaca",
        borderRadius: 6,
        color: "#991b1b",
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

const clearBtnStyle = {
  background: "none",
  border: "none",
  color: "#2563eb",
  cursor: "pointer",
  fontSize: 13,
  textDecoration: "underline",
  fontFamily: "inherit",
  padding: 0,
};

// "Mon Jun 1, 2026" or "Jun 1–3, 2026" when the range is short and in
// the same month, etc. Tries to be compact without losing precision.
function fmtDateRange(startsIso: string, endsIso: string): string {
  const s = new Date(startsIso);
  const e = new Date(endsIso);
  const sameDay = s.toDateString() === e.toDateString();
  const sameMonth =
    s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth();
  const sameYear = s.getFullYear() === e.getFullYear();

  if (sameDay) {
    return s.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  if (sameMonth) {
    // Jun 1–3, 2026
    return `${s.toLocaleDateString(undefined, { month: "short", day: "numeric" })}–${e.getDate()}, ${e.getFullYear()}`;
  }
  if (sameYear) {
    // Jun 28 – Jul 2, 2026
    return `${s.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${e.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${e.getFullYear()}`;
  }
  // Dec 30, 2026 – Jan 2, 2027
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
  };
  return `${s.toLocaleDateString(undefined, opts)} – ${e.toLocaleDateString(undefined, opts)}`;
}
