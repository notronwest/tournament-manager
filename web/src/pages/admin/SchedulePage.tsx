import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import {
  estimateMedalRound,
  estimatePoolPlay,
  fmtDuration,
} from "../../lib/estimator";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];
type EventCourt = Database["public"]["Tables"]["event_courts"]["Row"];

type EventRow = {
  event: Event;
  teamCount: number;
  teamsPerPool: number;
  courts: number;
  courtNumbers: number[];
  poolMinutes: number;
  medalMinutes: number;
  totalMinutes: number;
  poolBindingConstraint: "court" | "team";
};

// Per-tournament schedule view. Pulls each event's settings plus
// registration counts and court allocation, runs them through the
// shared estimator math, and reports per-event durations. Estimates
// the tournament total by detecting which events share courts
// (sequential) vs. run on disjoint courts (parallel).
//
// This is the planning surface: a TD can scan it before publishing
// to see whether the venue's rental window can absorb everything,
// and tweak event format / court allocation until it fits.
export default function SchedulePage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [eventCourts, setEventCourts] = useState<EventCourt[]>([]);
  const [teamsByEvent, setTeamsByEvent] = useState<Map<string, number>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      if (tErr) {
        setError(tErr.message);
        setLoading(false);
        return;
      }
      if (!t) {
        setError("Tournament not found.");
        setLoading(false);
        return;
      }
      setTournament(t);

      const [evRes, courtsRes, regsRes] = await Promise.all([
        supabase
          .from("events")
          .select("*")
          .eq("tournament_id", t.id)
          .is("deleted_at", null)
          .order("created_at", { ascending: true }),
        supabase
          .from("event_courts")
          .select("*, events!inner(tournament_id)")
          .eq("events.tournament_id", t.id),
        supabase
          .from("event_registrations")
          .select("event_id, events!inner(tournament_id)")
          .eq("events.tournament_id", t.id)
          .is("deleted_at", null),
      ]);
      if (cancelled) return;
      if (evRes.error) {
        setError(evRes.error.message);
        setLoading(false);
        return;
      }
      if (courtsRes.error) {
        setError(courtsRes.error.message);
        setLoading(false);
        return;
      }
      if (regsRes.error) {
        setError(regsRes.error.message);
        setLoading(false);
        return;
      }

      setEvents(evRes.data ?? []);
      setEventCourts((courtsRes.data ?? []) as unknown as EventCourt[]);

      // Count registrations per event so the schedule reflects the
      // *actual* registered team count, not just the max-teams config.
      const counts = new Map<string, number>();
      for (const r of regsRes.data ?? []) {
        counts.set(r.event_id, (counts.get(r.event_id) ?? 0) + 1);
      }
      setTeamsByEvent(counts);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [org, tournamentSlug]);

  const rows: EventRow[] = useMemo(() => {
    const courtsByEvent = new Map<string, number[]>();
    for (const ec of eventCourts) {
      const arr = courtsByEvent.get(ec.event_id) ?? [];
      arr.push(ec.court_number);
      courtsByEvent.set(ec.event_id, arr);
    }
    return events.map((event) => {
      const regCount = teamsByEvent.get(event.id) ?? 0;
      const teamCount =
        event.format === "doubles" ? Math.floor(regCount / 2) : regCount;
      const teamsPerPool =
        event.pool_count > 0
          ? Math.max(2, Math.ceil(teamCount / event.pool_count))
          : Math.max(2, teamCount);
      const courtNumbers = (courtsByEvent.get(event.id) ?? []).sort(
        (a, b) => a - b,
      );
      // Fall back to 1 court when an event hasn't claimed any — the
      // estimate still renders, just pessimistically.
      const courts = Math.max(1, courtNumbers.length);

      const pool = estimatePoolPlay({
        courts,
        pools: event.pool_count,
        teamsPerPool,
        minutesPerGame: event.pool_minutes_per_game,
        playEachOpponentTimes: event.play_each_team_times,
      });
      const medal =
        event.teams_advancing_to_playoff > 0
          ? estimateMedalRound({
              courts,
              teamsAdvancing: event.teams_advancing_to_playoff,
              rounds: (event.playoff_rounds as 1 | 2) ?? 1,
              format: event.medal_match_format,
              minutesPerGame: event.medal_minutes_per_game,
            })
          : null;
      return {
        event,
        teamCount,
        teamsPerPool,
        courts,
        courtNumbers,
        poolMinutes: pool.totalMinutes,
        medalMinutes: medal?.totalMinutes ?? 0,
        totalMinutes: pool.totalMinutes + (medal?.totalMinutes ?? 0),
        poolBindingConstraint: pool.bindingConstraint,
      };
    });
  }, [events, eventCourts, teamsByEvent]);

  // Tournament total = longest path through the court graph.
  // Two events that share at least one court can't run fully in
  // parallel, so we group events into "court clusters" (transitive
  // closure of court overlap) and sum durations within a cluster.
  // Tournament total is the max over clusters.
  const tournamentTotalMinutes = useMemo(() => {
    if (rows.length === 0) return 0;
    // Union-find over events. Two events merged if they share a court.
    const parent = new Map<string, string>();
    for (const r of rows) parent.set(r.event.id, r.event.id);
    const find = (x: string): string => {
      const p = parent.get(x) ?? x;
      if (p === x) return x;
      const root = find(p);
      parent.set(x, root);
      return root;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const ci = new Set(rows[i].courtNumbers);
        const overlap = rows[j].courtNumbers.some((c) => ci.has(c));
        if (overlap) union(rows[i].event.id, rows[j].event.id);
      }
    }
    const clusterMinutes = new Map<string, number>();
    for (const r of rows) {
      const root = find(r.event.id);
      clusterMinutes.set(
        root,
        (clusterMinutes.get(root) ?? 0) + r.totalMinutes,
      );
    }
    return Math.max(...clusterMinutes.values());
  }, [rows]);

  if (!org) return null;
  if (loading)
    return <div style={{ color: "#666", fontSize: 14 }}>Loading…</div>;
  if (error) {
    return (
      <div
        style={{
          padding: 12,
          background: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: 6,
          color: "#991b1b",
          fontSize: 13,
        }}
      >
        {error}
      </div>
    );
  }
  if (!tournament) return null;

  const totalSequentialMinutes = rows.reduce(
    (sum, r) => sum + r.totalMinutes,
    0,
  );

  return (
    <div>
      <Link
        to={`/admin/${org.slug}/tournaments/${tournament.slug}`}
        style={{ color: "#2563eb", textDecoration: "none", fontSize: 13 }}
      >
        ← {tournament.name}
      </Link>
      <h1 style={{ margin: "12px 0 4px", fontSize: 22 }}>Schedule</h1>
      <p style={{ color: "#666", margin: 0, fontSize: 13 }}>
        Time estimates per event based on registered teams, court allocation,
        and the format / scoring settings on each event. Numbers update as
        teams register and as you edit event settings.
      </p>

      {rows.length === 0 ? (
        <Empty>No events yet. Add one to start scheduling.</Empty>
      ) : (
        <>
          {/* Stats strip */}
          <div
            style={{
              marginTop: 24,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            <Stat
              label="Events"
              value={String(rows.length)}
              sub={`${rows.filter((r) => r.teamCount > 0).length} with teams registered`}
            />
            <Stat
              label="Tournament time"
              value={fmtDuration(tournamentTotalMinutes)}
              sub="Longest court-cluster — events on disjoint courts run in parallel."
              emphasize
            />
            <Stat
              label="If run end-to-end"
              value={fmtDuration(totalSequentialMinutes)}
              sub="Sum of all event durations, ignoring parallelism."
            />
          </div>

          {/* Per-event table */}
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
              marginTop: 24,
            }}
          >
            <thead>
              <tr
                style={{
                  background: "#fafafa",
                  borderBottom: "1px solid #e5e7eb",
                }}
              >
                <th style={thStyle}>Event</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Teams</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Courts</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Pool play</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Medal round</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.event.id}
                  style={{ borderBottom: "1px solid #f3f4f6" }}
                >
                  <td style={tdStyle}>
                    <Link
                      to={`/admin/${org.slug}/tournaments/${tournament.slug}/events/${r.event.id}`}
                      style={{
                        color: "#111",
                        textDecoration: "none",
                        fontWeight: 500,
                      }}
                    >
                      {r.event.name}
                    </Link>
                    <div
                      style={{ fontSize: 11, color: "#888", marginTop: 2 }}
                    >
                      {r.event.format} ·{" "}
                      {r.event.pool_count > 1
                        ? `${r.event.pool_count} pools of ${r.teamsPerPool}`
                        : "single pool"}
                      {r.event.play_each_team_times > 1
                        ? ` · play ${r.event.play_each_team_times}×`
                        : ""}{" "}
                      · {r.event.points_to_win} win by {r.event.win_by}
                      {r.event.teams_advancing_to_playoff > 0 ? (
                        <>
                          {" · "}
                          top {r.event.teams_advancing_to_playoff} (
                          {r.event.playoff_rounds} round
                          {r.event.playoff_rounds === 1 ? "" : "s"},{" "}
                          {r.event.medal_match_format === "best_of_3"
                            ? "best of 3"
                            : "1 game"}
                          )
                        </>
                      ) : (
                        " · no playoff"
                      )}
                    </div>
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      color: r.teamCount === 0 ? "#bbb" : "#444",
                    }}
                  >
                    {r.teamCount}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      color: r.courtNumbers.length === 0 ? "#bbb" : "#444",
                    }}
                    title={
                      r.courtNumbers.length === 0
                        ? "No courts assigned — estimate uses 1 court (pessimistic). Allocate courts on the tournament page."
                        : `Courts ${r.courtNumbers.join(", ")}`
                    }
                  >
                    {r.courtNumbers.length === 0 ? "—" : r.courts}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      color: "#444",
                    }}
                  >
                    {r.teamCount < 2 ? "—" : fmtDuration(r.poolMinutes)}
                    {r.teamCount >= 2 &&
                      r.poolBindingConstraint === "team" && (
                        <div
                          style={{
                            fontSize: 10,
                            color: "#92400e",
                            marginTop: 2,
                          }}
                          title="Team-bound: more courts than teams can fill simultaneously."
                        >
                          team-bound
                        </div>
                      )}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      color: "#444",
                    }}
                  >
                    {r.event.teams_advancing_to_playoff > 0
                      ? fmtDuration(r.medalMinutes)
                      : "—"}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: "right",
                      fontWeight: 600,
                      color: r.teamCount < 2 ? "#bbb" : "#111",
                    }}
                  >
                    {r.teamCount < 2 ? "—" : fmtDuration(r.totalMinutes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div
            style={{
              marginTop: 16,
              padding: 12,
              background: "#fafafa",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              fontSize: 12,
              color: "#555",
              lineHeight: 1.6,
            }}
          >
            <strong>How "Tournament time" is calculated.</strong> Events
            that share at least one court can't run fully in parallel —
            they're grouped into a court-cluster and their durations sum.
            Events on disjoint courts run truly in parallel. The
            tournament time is the longest of these clusters. If you want
            to compress further, give each event its own slice of courts
            on the tournament page.
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// UI bits
// ─────────────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  sub,
  emphasize,
}: {
  label: string;
  value: string;
  sub?: string;
  emphasize?: boolean;
}) {
  return (
    <div
      style={{
        padding: 12,
        background: emphasize ? "#eff6ff" : "#fafafa",
        border: `1px solid ${emphasize ? "#bfdbfe" : "#e5e7eb"}`,
        borderRadius: 6,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "#888",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: emphasize ? 22 : 18,
          fontWeight: 600,
          marginTop: 4,
          color: emphasize ? "#1e40af" : "#111",
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 12,
            color: "#666",
            marginTop: 4,
            lineHeight: 1.4,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        marginTop: 24,
        padding: 32,
        textAlign: "center",
        background: "#fafafa",
        border: "1px dashed #d1d5db",
        borderRadius: 6,
        color: "#666",
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontSize: 11,
  color: "#888",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontWeight: 500,
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  verticalAlign: "top",
};
