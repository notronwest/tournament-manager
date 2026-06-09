import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../supabase";
import {
  compactTierPriceLabel,
  pickActivePricingTier,
  type PricingTier,
} from "../../lib/pricingTiers";
import {
  bodyFontStack,
  bg,
  cream,
  creamDeep,
  ctaPrimaryStyle,
  ctaSecondaryStyle,
  courtGreen,
  courtRed,
  courtYellow,
  displayFontStack,
  ghostButtonStyle,
  headingFontStack,
  ink,
  inkSoft,
  inputStyle,
  pillStyle,
  rule,
  statusPanelStyle,
} from "../../lib/publicTheme";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Organization = Database["public"]["Tables"]["organizations"]["Row"];

// A tournament joined to its org + its pricing tiers. PostgREST returns
// the related org as a single object on to-one relations, but the
// generated TS thinks it could be an array — cast through unknown on
// receipt.
type TournamentWithOrg = Tournament & {
  organizations: Pick<Organization, "name" | "slug"> | null;
  tournament_pricing_tiers: PricingTier[] | null;
};

// Public homepage at `/`. Built to mockup 01 (mockups/layouts-v5.html):
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │  Hero — cream bg w/ court-yellow radial glow, Alfa Slab      │
//   │  headline (red accent line), two CTAs.                       │
//   ├──────────────────────────────────────────────────────────────┤
//   │  Section head: "Upcoming Tournaments" (Anton) + search box.  │
//   │  3-up card grid, colored top stripes cycle G/Y/R, each card  │
//   │  surfaces pill + Alfa Slab title + meta + price.             │
//   └──────────────────────────────────────────────────────────────┘
//
// SiteHeader renders the global logo + auth nav above. This page only
// owns the hero downward.
//
// Tokens (colors, fonts, primitive styles) come from src/lib/publicTheme
// so the homepage stays in lockstep with the rest of the public flow.
// Hero-specific styles (oversized H1, hero CTAs) are built locally by
// spreading the theme bases.
//
// Data: same query as the prior list-style homepage — every published
// tournament whose ends_at hasn't passed, RLS-anon-readable. Volumes
// stay small (low-double-digit published tournaments at any moment)
// so we filter in-memory.
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

      // today-at-midnight so the filter is stable across the day — a
      // tournament ending today stays "upcoming" until tomorrow morning.
      const todayIso = new Date(
        new Date().getFullYear(),
        new Date().getMonth(),
        new Date().getDate(),
      ).toISOString();

      const { data, error: err } = await supabase
        .from("tournaments")
        .select(
          "id, name, slug, starts_at, ends_at, location_name, location_address, status, organization_id, inter_event_buffer_minutes, registration_opens_at, registration_closes_at, description, created_at, updated_at, deleted_at, organizations:organization_id (name, slug), tournament_pricing_tiers (id, sort_order, label, starts_at, ends_at, first_event_fee_cents, additional_event_fee_cents, tournament_id, created_at, updated_at)",
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
    <main style={{ background: bg, color: ink, fontFamily: bodyFontStack }}>
      {/* ─── Hero ──────────────────────────────────────────────── */}
      <section style={heroStyle}>
        <div style={heroInnerStyle}>
          <h1 style={heroH1Style}>
            Run a pickleball tournament.<br />
            <span style={{ color: courtRed }}>Skip the spreadsheets.</span>
          </h1>
          <p style={heroPStyle}>
            Bracket generation, court dispatch, partner search,
            pay-with-Stripe checkout. Built by clubs, for clubs.
          </p>
          <div style={heroCtaRowStyle}>
            <a href="#tournaments" style={heroCtaPrimaryStyle}>
              Browse tournaments
            </a>
            <Link to="/admin" style={heroCtaSecondaryStyle}>
              For organizers
            </Link>
          </div>
        </div>
      </section>

      {/* ─── Tournaments grid ───────────────────────────────────── */}
      <section id="tournaments" style={tournamentsSectionStyle}>
        <div style={sectionHeadStyle}>
          <h2 style={sectionH2Style}>Upcoming Tournaments</h2>
          <div style={searchWrapStyle}>
            <input
              type="search"
              placeholder="Search tournaments…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={searchInputStyle}
              aria-label="Search tournaments"
            />
          </div>
        </div>

        {loading ? (
          <p style={statusTextStyle}>Loading tournaments…</p>
        ) : error ? (
          <ErrorPanel>{error}</ErrorPanel>
        ) : filtered.length === 0 ? (
          <EmptyState
            queryText={query}
            hasAny={tournaments.length > 0}
            onClear={() => setQuery("")}
          />
        ) : (
          <div style={gridStyle}>
            {filtered.map((t, i) => (
              <TournamentCard
                key={t.id}
                tournament={t}
                stripeIdx={i % 3 as 0 | 1 | 2}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Card
// ─────────────────────────────────────────────────────────────────────

function TournamentCard({
  tournament,
  stripeIdx,
}: {
  tournament: TournamentWithOrg;
  stripeIdx: 0 | 1 | 2;
}) {
  const org = tournament.organizations;
  // Defensive: if RLS hid the org row somehow we can't link safely.
  if (!org) return null;

  const dateRange = fmtDateRange(tournament.starts_at, tournament.ends_at);
  const tiers = tournament.tournament_pricing_tiers ?? [];
  const activeTier = pickActivePricingTier(tiers);
  const priceLabel = compactTierPriceLabel(tiers);
  const stripeColor =
    stripeIdx === 0 ? courtGreen : stripeIdx === 1 ? courtYellow : courtRed;

  // Pill copy — prefer the active tier label (e.g. "Early bird") so
  // the chip describes *why* this card is interesting. Falls back to
  // "Registration open" when tiers aren't loaded or the active tier
  // is unnamed.
  const pillText = activeTier?.label?.trim()
    ? activeTier.label
    : "Registration open";

  return (
    <Link
      to={`/t/${org.slug}/${tournament.slug}`}
      style={cardStyle}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = "0 4px 16px rgba(20,24,31,0.10)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = "0 1px 0 rgba(20,24,31,0.04)";
      }}
    >
      <div style={{ ...cardStripeStyle, background: stripeColor }} />
      <div style={cardBodyStyle}>
        <span style={cardPillStyle}>{pillText}</span>
        <h3 style={cardH3Style}>{tournament.name}</h3>
        <p style={cardMetaStyle}>
          {[org.name, dateRange, tournament.location_name]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {priceLabel !== "—" && (
          <div style={cardPriceRowStyle}>
            {priceLabel !== "Free" && (
              <span style={cardPriceFromStyle}>From</span>
            )}
            <span style={cardPriceValStyle}>{priceLabel}</span>
          </div>
        )}
      </div>
    </Link>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bits
// ─────────────────────────────────────────────────────────────────────

function EmptyState({
  queryText,
  hasAny,
  onClear,
}: {
  queryText: string;
  hasAny: boolean;
  onClear: () => void;
}) {
  return (
    <div style={emptyStyle}>
      {queryText ? (
        <>
          No tournaments match <strong>"{queryText}"</strong>.{" "}
          <button type="button" onClick={onClear} style={ghostButtonStyle}>
            Clear search
          </button>
        </>
      ) : hasAny ? (
        "No matches."
      ) : (
        "No upcoming tournaments yet. Check back soon."
      )}
    </div>
  );
}

function ErrorPanel({ children }: { children: ReactNode }) {
  // Lean on the shared danger surface so errors here read the same as
  // errors on every other public page.
  return <div style={statusPanelStyle("danger")}>{children}</div>;
}

// "Jun 14–15" or "Jun 28 – Jul 2" — short form for the card meta line.
// Year omitted because every card already implies the same season (we
// only show "upcoming" tournaments).
function fmtDateRange(startsIso: string, endsIso: string): string {
  const s = new Date(startsIso);
  const e = new Date(endsIso);
  const sameDay = s.toDateString() === e.toDateString();
  const sameMonth =
    s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth();

  if (sameDay) {
    return s.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  if (sameMonth) {
    return `${s.toLocaleDateString(undefined, { month: "short", day: "numeric" })}–${e.getDate()}`;
  }
  return `${s.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${e.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

// ─────────────────────────────────────────────────────────────────────
// Styles — homepage-local. Tokens / fonts / shared primitives come
// from publicTheme.ts; the styles below are the hero-and-grid pieces
// that only the homepage uses (oversized H1, big CTAs, card layout).
// Inline per project convention.
// ─────────────────────────────────────────────────────────────────────

const heroStyle: CSSProperties = {
  padding: "clamp(56px, 9vw, 96px) clamp(20px, 5vw, 48px) clamp(48px, 7vw, 72px)",
  // Court-yellow radial bloom over cream — the V5 signature.
  background: `radial-gradient(ellipse 50% 70% at 80% 20%, ${courtYellow} 0%, transparent 70%), ${cream}`,
};

const heroInnerStyle: CSSProperties = {
  maxWidth: 1080,
  margin: "0 auto",
};

const heroH1Style: CSSProperties = {
  fontFamily: displayFontStack,
  // clamp so the headline scales on phones without going microscopic
  // or banging into the viewport edge. Bigger than the shared
  // pageH1Style because this is the marketing hero, not a form title.
  fontSize: "clamp(36px, 7vw, 64px)",
  lineHeight: 0.95,
  margin: "0 0 16px",
  maxWidth: 720,
  letterSpacing: "-0.5px",
};

const heroPStyle: CSSProperties = {
  fontSize: "clamp(15px, 1.8vw, 18px)",
  maxWidth: 540,
  margin: "0 0 28px",
  color: inkSoft,
  lineHeight: 1.5,
};

const heroCtaRowStyle: CSSProperties = {
  display: "inline-flex",
  gap: 12,
  alignItems: "center",
  flexWrap: "wrap",
};

// Hero CTAs are bigger than the standard form CTAs — same shape and
// type stack, just larger padding + fontSize. Spread the theme bases
// so any future tweak to ctaPrimaryStyle / ctaSecondaryStyle still
// propagates here.
const heroCtaPrimaryStyle: CSSProperties = {
  ...ctaPrimaryStyle,
  padding: "14px 22px",
  fontSize: 15,
};

const heroCtaSecondaryStyle: CSSProperties = {
  ...ctaSecondaryStyle,
  padding: "14px 22px",
  fontSize: 15,
};

const tournamentsSectionStyle: CSSProperties = {
  padding: "clamp(36px, 6vw, 56px) clamp(20px, 5vw, 48px) clamp(48px, 8vw, 80px)",
  maxWidth: 1080,
  margin: "0 auto",
};

const sectionHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 12,
  marginBottom: 22,
};

// Bigger than the shared sectionH2Style — that one is sized for inline
// form sections, this one anchors the "Upcoming Tournaments" billboard
// on the homepage.
const sectionH2Style: CSSProperties = {
  fontFamily: headingFontStack,
  fontSize: "clamp(22px, 3vw, 28px)",
  textTransform: "uppercase",
  letterSpacing: "0.02em",
  margin: 0,
};

const searchWrapStyle: CSSProperties = {
  flex: "0 1 280px",
  minWidth: 200,
};

// Spread the shared inputStyle base, then override radius/padding so
// the search field reads as a chip rather than a form field.
const searchInputStyle: CSSProperties = {
  ...inputStyle,
  padding: "10px 14px",
  borderRadius: 8,
};

const gridStyle: CSSProperties = {
  display: "grid",
  // auto-fill keeps the grid pleasant at every width: 3-up on
  // desktop, 2-up on tablet, 1-up on phone. minmax floors at 280px
  // so each card stays comfortable.
  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
  gap: 16,
};

const cardStyle: CSSProperties = {
  background: cream,
  border: `1px solid ${rule}`,
  borderRadius: 10,
  overflow: "hidden",
  textDecoration: "none",
  color: "inherit",
  display: "block",
  transition: "transform 160ms ease, box-shadow 160ms ease",
  boxShadow: "0 1px 0 rgba(20,24,31,0.04)",
};

const cardStripeStyle: CSSProperties = {
  height: 10,
};

const cardBodyStyle: CSSProperties = {
  padding: "18px 20px 20px",
};

// Reuse the shared status pill; just add the margin we need below it
// inside the card.
const cardPillStyle: CSSProperties = {
  ...pillStyle,
  marginBottom: 12,
};

const cardH3Style: CSSProperties = {
  fontFamily: displayFontStack,
  fontSize: 22,
  lineHeight: 1.15,
  margin: "0 0 10px",
  letterSpacing: "-0.2px",
};

const cardMetaStyle: CSSProperties = {
  fontSize: 13,
  color: inkSoft,
  margin: "0 0 16px",
  lineHeight: 1.45,
};

const cardPriceRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
};

const cardPriceFromStyle: CSSProperties = {
  fontFamily: bodyFontStack,
  fontSize: 11,
  color: inkSoft,
  fontWeight: 500,
};

const cardPriceValStyle: CSSProperties = {
  fontFamily: headingFontStack,
  fontSize: 22,
  letterSpacing: "0.02em",
};

const statusTextStyle: CSSProperties = {
  color: inkSoft,
  fontSize: 14,
  margin: 0,
};

// Quieter than statusPanelStyle("info") — dashed border + larger
// padding signals "you've drilled into an empty slot, not an error".
const emptyStyle: CSSProperties = {
  padding: 32,
  textAlign: "center",
  background: cream,
  border: `1px dashed ${creamDeep}`,
  borderRadius: 8,
  color: inkSoft,
  fontSize: 14,
};
