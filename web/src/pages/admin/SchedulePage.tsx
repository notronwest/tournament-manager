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
  // Persisted start time on the event, if any. End is computed from
  // start + totalMinutes.
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
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
  const [busy, setBusy] = useState(false);

  // Anchor for auto-schedule. Defaults from tournament.starts_at the
  // first time the tournament loads; the user can override before
  // clicking "Auto-schedule". Stored as a datetime-local-style string
  // (YYYY-MM-DDTHH:MM) so the input renders without timezone goop.
  const [anchorLocal, setAnchorLocal] = useState<string>("");
  // Buffer in minutes inserted between consecutive events sharing a
  // court (announcements, court turnover, etc.). Lives on the
  // tournament row; saved on change.
  const [bufferLocal, setBufferLocal] = useState<string>("");

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
      // Seed the anchor input from the tournament's start once on
      // first load. Re-seeds on subsequent reloads only if the
      // organizer hasn't typed a different value yet.
      setAnchorLocal((prev) => prev || toLocalInput(t.starts_at));
      setBufferLocal((prev) => prev || String(t.inter_event_buffer_minutes));

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
      const totalMinutes = pool.totalMinutes + (medal?.totalMinutes ?? 0);
      const scheduledStart = event.scheduled_start_at
        ? new Date(event.scheduled_start_at)
        : null;
      const scheduledEnd = scheduledStart
        ? new Date(scheduledStart.getTime() + totalMinutes * 60_000)
        : null;
      return {
        event,
        teamCount,
        teamsPerPool,
        courts,
        courtNumbers,
        poolMinutes: pool.totalMinutes,
        medalMinutes: medal?.totalMinutes ?? 0,
        totalMinutes,
        poolBindingConstraint: pool.bindingConstraint,
        scheduledStart,
        scheduledEnd,
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

  // ─── Schedule mutations ────────────────────────────────────────────
  // Optimistic local-state updates keep the UI snappy without a full
  // reload of all the joined data each click.

  const updateLocalEventScheduled = (
    eventId: string,
    iso: string | null,
  ) => {
    setEvents((prev) =>
      prev.map((e) =>
        e.id === eventId ? { ...e, scheduled_start_at: iso } : e,
      ),
    );
  };

  // Auto-schedule walks each court-cluster in court-number order and
  // packs events back-to-back starting at the anchor. Different
  // clusters all start at the same anchor (parallel tracks).
  const onAutoSchedule = async () => {
    setError(null);
    const anchorIso = fromLocalInput(anchorLocal);
    if (!anchorIso) {
      setError("Pick a start date/time first.");
      return;
    }
    if (rows.length === 0) return;
    setBusy(true);

    // Cluster events by shared courts (same union-find as the totals).
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
        if (rows[j].courtNumbers.some((c) => ci.has(c))) {
          union(rows[i].event.id, rows[j].event.id);
        }
      }
    }

    // Group rows by cluster root, ordered within a cluster by the
    // minimum court number (so the schedule is stable + matches the
    // organizer's mental model of "Court 1 → Court 2 → …").
    const clusters = new Map<string, EventRow[]>();
    for (const r of rows) {
      const root = find(r.event.id);
      const arr = clusters.get(root) ?? [];
      arr.push(r);
      clusters.set(root, arr);
    }
    const updates: { id: string; scheduled_start_at: string }[] = [];
    const anchorMs = new Date(anchorIso).getTime();
    for (const cluster of clusters.values()) {
      cluster.sort((a, b) => {
        const ca = a.courtNumbers[0] ?? 1e9;
        const cb = b.courtNumbers[0] ?? 1e9;
        if (ca !== cb) return ca - cb;
        // Tie-break by creation order so reruns are deterministic.
        return a.event.created_at.localeCompare(b.event.created_at);
      });
      let cursorMs = anchorMs;
      const bufferMs =
        Math.max(0, parseInt(bufferLocal || "0", 10)) * 60_000;
      cluster.forEach((r, i) => {
        // First event in the cluster starts at the anchor; each
        // subsequent event is preceded by the buffer (court
        // turnover, announcements, etc.).
        if (i > 0) cursorMs += bufferMs;
        const iso = new Date(cursorMs).toISOString();
        updates.push({ id: r.event.id, scheduled_start_at: iso });
        cursorMs += r.totalMinutes * 60_000;
      });
    }

    // Run updates in parallel — they're on disjoint rows.
    const results = await Promise.all(
      updates.map((u) =>
        supabase
          .from("events")
          .update({ scheduled_start_at: u.scheduled_start_at })
          .eq("id", u.id),
      ),
    );
    const firstErr = results.find((r) => r.error)?.error;
    if (firstErr) {
      setError(firstErr.message);
      setBusy(false);
      return;
    }
    setEvents((prev) =>
      prev.map((e) => {
        const u = updates.find((x) => x.id === e.id);
        return u ? { ...e, scheduled_start_at: u.scheduled_start_at } : e;
      }),
    );
    setBusy(false);
  };

  const onClearSchedule = async () => {
    setError(null);
    if (rows.length === 0) return;
    setBusy(true);
    const { error: updErr } = await supabase
      .from("events")
      .update({ scheduled_start_at: null })
      .in(
        "id",
        rows.map((r) => r.event.id),
      );
    if (updErr) {
      setError(updErr.message);
      setBusy(false);
      return;
    }
    setEvents((prev) => prev.map((e) => ({ ...e, scheduled_start_at: null })));
    setBusy(false);
  };

  // Persist the buffer onto the tournament row. Called on input blur
  // (rather than every keystroke) so we don't hammer the DB while
  // typing.
  const onSaveBuffer = async () => {
    if (!tournament) return;
    const value = Math.max(0, Math.min(240, parseInt(bufferLocal || "0", 10) || 0));
    if (value === tournament.inter_event_buffer_minutes) return;
    setError(null);
    const { error: updErr } = await supabase
      .from("tournaments")
      .update({ inter_event_buffer_minutes: value })
      .eq("id", tournament.id);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    setTournament({ ...tournament, inter_event_buffer_minutes: value });
    setBufferLocal(String(value));
  };

  const onSetEventStart = async (eventId: string, localValue: string) => {
    setError(null);
    const iso = localValue ? fromLocalInput(localValue) : null;
    const { error: updErr } = await supabase
      .from("events")
      .update({ scheduled_start_at: iso })
      .eq("id", eventId);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    updateLocalEventScheduled(eventId, iso);
  };

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

      {/* Auto-schedule controls — visible whenever there are events
          to schedule, so the user can lay out a daily plan from a
          start anchor in one click. */}
      {rows.length > 0 && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: "#fafafa",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            display: "flex",
            gap: 12,
            alignItems: "end",
            flexWrap: "wrap",
          }}
        >
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontSize: 12,
              color: "#555",
            }}
          >
            <span>Tournament start</span>
            <input
              type="datetime-local"
              value={anchorLocal}
              onChange={(e) => setAnchorLocal(e.target.value)}
              style={{
                padding: "6px 10px",
                border: "1px solid #e2e2e2",
                borderRadius: 6,
                fontSize: 13,
                fontFamily: "inherit",
              }}
            />
          </label>
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontSize: 12,
              color: "#555",
            }}
            title="Inserted between consecutive events on the same court (turnover, announcements, etc.). Not added within a single event's pool play."
          >
            <span>Buffer between events (min)</span>
            <input
              type="number"
              min={0}
              max={240}
              value={bufferLocal}
              onChange={(e) => setBufferLocal(e.target.value)}
              onBlur={() => void onSaveBuffer()}
              style={{
                padding: "6px 10px",
                border: "1px solid #e2e2e2",
                borderRadius: 6,
                fontSize: 13,
                fontFamily: "inherit",
                width: 90,
              }}
            />
          </label>
          <button
            onClick={onAutoSchedule}
            disabled={busy || !anchorLocal}
            style={{
              padding: "8px 16px",
              background: busy || !anchorLocal ? "#9ca3af" : "#2563eb",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              cursor: busy || !anchorLocal ? "not-allowed" : "pointer",
              fontFamily: "inherit",
            }}
            title="Pack each court-cluster back-to-back starting at the chosen time. Parallel clusters all start at the anchor."
          >
            {busy ? "Scheduling…" : "Auto-schedule"}
          </button>
          <button
            onClick={onClearSchedule}
            disabled={busy || !rows.some((r) => r.scheduledStart)}
            style={{
              padding: "8px 16px",
              background: "#fff",
              color: "#555",
              border: "1px solid #e2e2e2",
              borderRadius: 6,
              fontSize: 13,
              cursor:
                busy || !rows.some((r) => r.scheduledStart)
                  ? "not-allowed"
                  : "pointer",
              fontFamily: "inherit",
              opacity:
                busy || !rows.some((r) => r.scheduledStart) ? 0.6 : 1,
            }}
          >
            Clear schedule
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "#888" }}>
            You can also edit any event's start time directly in the
            table below.
          </span>
        </div>
      )}

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
                <th style={thStyle}>Start</th>
                <th style={thStyle}>End</th>
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
                  <td style={tdStyle}>
                    <input
                      type="datetime-local"
                      value={toLocalInput(r.event.scheduled_start_at)}
                      onChange={(e) =>
                        void onSetEventStart(r.event.id, e.target.value)
                      }
                      disabled={busy}
                      style={{
                        padding: "4px 6px",
                        border: "1px solid #e2e2e2",
                        borderRadius: 4,
                        fontSize: 12,
                        fontFamily: "inherit",
                        background: "#fff",
                      }}
                    />
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      color: r.scheduledEnd ? "#444" : "#bbb",
                    }}
                  >
                    {r.scheduledEnd ? fmtTime(r.scheduledEnd) : "—"}
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

// `<input type="datetime-local">` expects "YYYY-MM-DDTHH:MM" in
// **local** time with no timezone suffix. Going either direction:
//   - toLocalInput: ISO/timestamptz → local-time slug for the input
//   - fromLocalInput: local-time slug → ISO with the browser's offset
// Both round-trip the same wall-clock moment the organizer sees.
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(local: string): string | null {
  if (!local) return null;
  // new Date("YYYY-MM-DDTHH:MM") parses as local time in browsers,
  // then .toISOString() gives us the UTC-equivalent storage form.
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

