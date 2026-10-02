import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../../supabase";
import SiteFooter from "../../components/SiteFooter";
import {
  buildTeams,
  computeMedals,
  computeStandings,
  groupStandingsByPool,
  poolLetter,
  teamByAnyRegId,
  type EventRegistration,
  type Match,
  type Medal,
  type Player,
} from "../../lib/bracketTeams";
import {
  bodyFontStack,
  contentColStyle,
  courtGreen,
  courtRed,
  cream,
  creamDeep,
  displayFontStack,
  ink,
  inkMuted,
  inkSoft,
  monoFontStack,
  pageWrapStyle,
  rule,
  ruleSoft,
} from "../../lib/publicTheme";

// Public LIVE RESULTS page: anyone can watch any bracket's current progress —
// standings (split by pool), scores played, and medals — without logging in.
// Data comes from the public_tournament_results RPC (a curated, money-free
// payload; see the 20261001130000 migration), and the page reuses the console's
// own buildTeams / computeStandings / computeMedals so public results match the
// admin view exactly (D-0049). It re-fetches every 30s so a spectator sees the
// bracket fill in live.

const REFRESH_MS = 30_000;

// public_tournament_results is a hand-written RPC (migration 20261001130000),
// not in the generated types — call it through an untyped client, like the
// other bespoke RPCs in this app (e.g. MergeEventsPage).
const untyped = supabase as unknown as SupabaseClient;

// The curated payload the RPC returns (safe subset of each row).
type EventLite = {
  id: string;
  name: string;
  format: string;
  gender: string;
  bracket_type: string | null;
  pool_count: number;
  teams_advancing_to_playoff: number;
  playoff_rounds: number;
  double_elim_final: "crossover" | "bronze_only" | null;
  status: string;
  scheduled_start_at: string | null;
  schedule_order: number | null;
};
type ResultsPayload = {
  tournament: { name: string; slug: string; starts_at: string; ends_at: string; status: string };
  events: EventLite[];
  registrations: EventRegistration[];
  players: Player[];
  matches: Match[];
};

type EventResult = {
  event: EventLite;
  groups: ReturnType<typeof groupStandingsByPool>;
  medals: Medal[];
  gamesPlayed: number;
  gamesTotal: number;
  phase: "not_started" | "in_progress" | "final";
};

function fmtRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const sameDay = start.toDateString() === end.toDateString();
  const dOpts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  if (sameDay) return start.toLocaleDateString(undefined, dOpts);
  return `${start.toLocaleDateString(undefined, dOpts)} – ${end.toLocaleDateString(undefined, dOpts)}`;
}

function fmtUpdated(ms: number | null): string {
  if (ms == null) return "";
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  return `${mins}m ago`;
}

export default function LiveResultsPage() {
  const { orgSlug, tournamentSlug } = useParams<{ orgSlug: string; tournamentSlug: string }>();
  const [payload, setPayload] = useState<ResultsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  // Re-render the "updated Xs ago" label on a 1s tick without re-fetching.
  const [, setNowTick] = useState(0);
  const refreshing = useRef(false);

  const load = useCallback(
    async (initial: boolean) => {
      if (!orgSlug || !tournamentSlug) return;
      if (refreshing.current) return;
      refreshing.current = true;
      if (initial) setLoading(true);
      const { data, error: rpcErr } = await untyped.rpc("public_tournament_results", {
        p_org_slug: orgSlug,
        p_tournament_slug: tournamentSlug,
      });
      refreshing.current = false;
      if (rpcErr) {
        if (initial) setError(rpcErr.message);
        setLoading(false);
        return;
      }
      if (data == null) {
        setPayload(null);
        setError(null);
        setLoading(false);
        return;
      }
      setPayload(data as ResultsPayload);
      setError(null);
      setUpdatedAt(Date.now());
      setLoading(false);
    },
    [orgSlug, tournamentSlug],
  );

  useEffect(() => {
    void load(true);
    const poll = setInterval(() => void load(false), REFRESH_MS);
    const tick = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  const results: EventResult[] = useMemo(() => {
    if (!payload) return [];
    const { events, registrations, players, matches } = payload;
    return events.map((event) => {
      const regs = registrations.filter((r) => r.event_id === event.id);
      const teams = buildTeams(regs, players);
      const evMatches = matches.filter((m) => m.event_id === event.id);
      const rrMatches = evMatches.filter((m) => m.stage === "round_robin");
      const playoffMatches = evMatches.filter((m) => m.stage === "playoff");
      const standings = computeStandings(teams, rrMatches);
      const medals = computeMedals(
        event as unknown as Parameters<typeof computeMedals>[0],
        playoffMatches,
        teamByAnyRegId(teams),
      );
      const gamesPlayed = evMatches.filter((m) => m.status === "completed").length;
      const gamesTotal = evMatches.length;
      const phase: EventResult["phase"] =
        medals.some((m) => m.place === "gold")
          ? "final"
          : gamesPlayed > 0 || evMatches.some((m) => m.status === "active")
            ? "in_progress"
            : "not_started";
      return {
        event,
        groups: groupStandingsByPool(standings, event.pool_count > 1),
        medals,
        gamesPlayed,
        gamesTotal,
        phase,
      };
    });
  }, [payload]);

  if (loading) {
    return (
      <main style={pageWrapStyle}>
        <div style={contentColStyle(760)}>
          <p style={{ color: inkMuted, fontSize: 14 }}>Loading results…</p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main style={pageWrapStyle}>
        <div style={contentColStyle(760)}>
          <p style={{ color: courtRed, fontSize: 14 }}>{error}</p>
        </div>
      </main>
    );
  }

  if (!payload) {
    return (
      <main style={pageWrapStyle}>
        <div style={contentColStyle(760)}>
          <h1 style={{ fontFamily: displayFontStack, fontSize: 28, color: ink, margin: "0 0 10px" }}>
            Results aren't public yet
          </h1>
          <p style={{ color: inkSoft, fontSize: 15, lineHeight: 1.6, fontFamily: bodyFontStack }}>
            This tournament hasn't been published, or it doesn't exist. Once the organizer publishes
            it, live standings and scores will appear here.
          </p>
        </div>
        <SiteFooter />
      </main>
    );
  }

  const t = payload.tournament;

  return (
    <main style={pageWrapStyle}>
      <div style={contentColStyle(760)}>
        <div style={{ marginBottom: 8 }}>
          <Link
            to={`/t/${orgSlug}/${tournamentSlug}`}
            style={{ fontSize: 13, color: inkMuted, textDecoration: "none" }}
          >
            ← {t.name}
          </Link>
        </div>

        <header
          style={{
            background: `linear-gradient(180deg, ${cream} 0%, ${creamDeep} 100%)`,
            borderRadius: 10,
            padding: "32px 28px 24px",
            marginBottom: 24,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontFamily: monoFontStack,
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.2em",
              color: courtRed,
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            <LiveDot />
            Live results
          </div>
          <h1
            style={{
              fontFamily: displayFontStack,
              fontSize: "clamp(28px, 5vw, 44px)",
              lineHeight: 0.98,
              margin: "0 0 12px",
              color: ink,
            }}
          >
            {t.name}
          </h1>
          <p style={{ margin: 0, fontSize: 15, color: inkSoft, lineHeight: 1.55, fontFamily: bodyFontStack }}>
            {fmtRange(t.starts_at, t.ends_at)} · {results.length} bracket{results.length === 1 ? "" : "s"}
          </p>
          <p style={{ margin: "10px 0 0", fontSize: 12, color: inkMuted, fontFamily: bodyFontStack }}>
            Updates automatically · last refreshed {fmtUpdated(updatedAt)}
          </p>
        </header>

        {/* Jump nav across brackets */}
        {results.length > 1 && (
          <nav
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              marginBottom: 24,
            }}
          >
            {results.map((r) => (
              <a
                key={r.event.id}
                href={`#event-${r.event.id}`}
                style={{
                  fontSize: 12,
                  color: inkSoft,
                  textDecoration: "none",
                  padding: "4px 10px",
                  border: `1px solid ${rule}`,
                  borderRadius: 999,
                  background: "#fff",
                  fontFamily: bodyFontStack,
                }}
              >
                {shortEventName(r.event.name)}
              </a>
            ))}
          </nav>
        )}

        {results.length === 0 && (
          <p style={{ color: inkMuted, fontSize: 14 }}>No brackets to show yet.</p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          {results.map((r) => (
            <EventResultCard key={r.event.id} result={r} />
          ))}
        </div>
      </div>
      <SiteFooter />
    </main>
  );
}

function EventResultCard({ result }: { result: EventResult }) {
  const { event, groups, medals, gamesPlayed, gamesTotal, phase } = result;
  const empty = groups.every((g) => g.rows.length === 0);
  return (
    <section id={`event-${event.id}`} style={{ scrollMarginTop: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 10,
          borderBottom: `2px solid ${ruleSoft}`,
          paddingBottom: 8,
        }}
      >
        <h2 style={{ fontFamily: displayFontStack, fontSize: 21, color: ink, margin: 0 }}>
          {event.name}
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {gamesTotal > 0 && (
            <span style={{ fontSize: 12, color: inkMuted, fontFamily: monoFontStack }}>
              {gamesPlayed}/{gamesTotal} games
            </span>
          )}
          <PhaseChip phase={phase} />
        </div>
      </div>

      {medals.length > 0 && <Podium medals={medals} />}

      {empty ? (
        <p style={{ color: inkMuted, fontSize: 13, fontFamily: bodyFontStack, margin: "4px 0 0" }}>
          Teams and standings appear once the bracket is built.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {groups.map((g, gi) => (
            <div key={g.pool ?? `unassigned-${gi}`}>
              {groups.length > 1 && (
                <h3
                  style={{
                    fontSize: 12,
                    color: inkMuted,
                    margin: "0 0 6px",
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    fontFamily: monoFontStack,
                  }}
                >
                  {g.pool == null ? "Not yet pooled" : `Pool ${poolLetter(g.pool)}`}
                </h3>
              )}
              <StandingsTable rows={g.rows} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function StandingsTable({ rows }: { rows: EventResult["groups"][number]["rows"] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: bodyFontStack }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, width: 32, textAlign: "left" }}>#</th>
            <th style={{ ...thStyle, textAlign: "left" }}>Team</th>
            <th style={numTh}>W</th>
            <th style={numTh}>L</th>
            <th style={numTh}>PF</th>
            <th style={numTh}>PA</th>
            <th style={numTh}>Diff</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => (
            <tr key={s.team.captainRegId} style={{ borderTop: `1px solid ${ruleSoft}` }}>
              <td style={{ ...tdStyle, color: inkMuted }}>{i + 1}</td>
              <td style={{ ...tdStyle, fontWeight: 500, color: ink }}>{s.team.label}</td>
              <td style={numTd}>{s.wins}</td>
              <td style={numTd}>{s.losses}</td>
              <td style={{ ...numTd, color: inkMuted }}>{s.pf}</td>
              <td style={{ ...numTd, color: inkMuted }}>{s.pa}</td>
              <td style={{ ...numTd, color: s.diff > 0 ? courtGreen : s.diff < 0 ? courtRed : inkMuted }}>
                {s.diff > 0 ? `+${s.diff}` : s.diff}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Podium({ medals }: { medals: Medal[] }) {
  const order: Medal["place"][] = ["gold", "silver", "bronze"];
  const byPlace = new Map(medals.map((m) => [m.place, m]));
  const palette: Record<Medal["place"], { bg: string; fg: string; label: string }> = {
    gold: { bg: "#fbf3d0", fg: "#8a6500", label: "1st" },
    silver: { bg: "#eceef1", fg: "#5b6672", label: "2nd" },
    bronze: { bg: "#f4e6da", fg: "#8a5a2b", label: "3rd" },
  };
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: 10,
        margin: "0 0 14px",
      }}
    >
      {order
        .filter((p) => byPlace.has(p))
        .map((p) => {
          const m = byPlace.get(p)!;
          const c = palette[p];
          return (
            <div
              key={p}
              style={{
                padding: "12px 14px",
                background: c.bg,
                borderRadius: 8,
                border: `1px solid ${ruleSoft}`,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: c.fg,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  fontWeight: 700,
                  fontFamily: monoFontStack,
                  marginBottom: 4,
                }}
              >
                {c.label}
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: ink, fontFamily: bodyFontStack }}>
                {m.team.label}
              </div>
            </div>
          );
        })}
    </div>
  );
}

function PhaseChip({ phase }: { phase: EventResult["phase"] }) {
  const map: Record<EventResult["phase"], { label: string; bg: string; fg: string }> = {
    not_started: { label: "Not started", bg: "#eef0f2", fg: inkMuted },
    in_progress: { label: "In progress", bg: "#fef6d6", fg: "#8a6500" },
    final: { label: "Final", bg: "#e8f4eb", fg: "#1e6b2c" },
  };
  const c = map[phase];
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: "2px 9px",
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        fontFamily: monoFontStack,
        textTransform: "uppercase",
        letterSpacing: 0.4,
        whiteSpace: "nowrap",
      }}
    >
      {c.label}
    </span>
  );
}

function LiveDot() {
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: courtRed,
        display: "inline-block",
        boxShadow: `0 0 0 0 ${courtRed}`,
        animation: "livePulse 2s infinite",
      }}
    >
      <style>{`@keyframes livePulse{0%{box-shadow:0 0 0 0 rgba(216,52,28,.5)}70%{box-shadow:0 0 0 6px rgba(216,52,28,0)}100%{box-shadow:0 0 0 0 rgba(216,52,28,0)}}`}</style>
    </span>
  );
}

// "Mens Doubles Skill: (3.0 To 3.49)" → "Mens Doubles 3.0–3.49" for the nav pill.
function shortEventName(name: string): string {
  const m = name.match(/\(([^)]+)\)/);
  const base = name.replace(/\s*Skill:.*$/i, "").replace(/\s*Age:.*$/i, "").trim();
  return m ? `${base} ${m[1].replace(/\s*to\s*/i, "–")}` : base;
}

const thStyle: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: inkMuted,
  fontWeight: 700,
  padding: "6px 8px",
  fontFamily: monoFontStack,
};
const numTh: CSSProperties = { ...thStyle, textAlign: "right", width: 54 };
const tdStyle: CSSProperties = { fontSize: 14, padding: "7px 8px", fontFamily: bodyFontStack };
const numTd: CSSProperties = {
  ...tdStyle,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
  color: ink,
};
