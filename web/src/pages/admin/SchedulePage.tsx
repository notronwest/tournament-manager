import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import {
  estimateMedalRound,
  estimatePoolPlay,
  fmtDuration,
} from "../../lib/estimator";
import { NoCourtCountNotice } from "../../components/NoCourtCountNotice";
import type { Database } from "../../types/supabase";

// Court count now lives on the selected venue (locations.court_count),
// joined in on the tournament fetch below.
type Tournament = Database["public"]["Tables"]["tournaments"]["Row"] & {
  locations: { court_count: number | null } | null;
};
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

type Overlap =
  | {
      type: "court";
      a: EventRow;
      b: EventRow;
      courts: number[];
      windowStart: Date;
      windowEnd: Date;
    }
  | {
      type: "player";
      a: EventRow;
      b: EventRow;
      sharedPlayerCount: number;
      windowStart: Date;
      windowEnd: Date;
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
  const [searchParams, setSearchParams] = useSearchParams();
  // View tab driven by ?view= so refresh + back keep the user where
  // they were. Table is the default since it's the editable view.
  const view: "table" | "calendar" =
    searchParams.get("view") === "calendar" ? "calendar" : "table";
  const setView = (v: "table" | "calendar") => {
    const next = new URLSearchParams(searchParams);
    if (v === "table") next.delete("view");
    else next.set("view", v);
    setSearchParams(next, { replace: true });
  };
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [eventCourts, setEventCourts] = useState<EventCourt[]>([]);
  const [teamsByEvent, setTeamsByEvent] = useState<Map<string, number>>(
    new Map(),
  );
  // Player-id set per event, used for cross-event player-conflict
  // detection. Counts come from teamsByEvent; this is the membership
  // map.
  const [playersByEvent, setPlayersByEvent] = useState<
    Map<string, Set<string>>
  >(new Map());
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
        .select("*, locations(court_count)")
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
          .select("event_id, player_id, events!inner(tournament_id)")
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
      // Also track which players are in which events so we can flag
      // a player registered in two events scheduled at the same time.
      const counts = new Map<string, number>();
      const players = new Map<string, Set<string>>();
      type RegRow = { event_id: string; player_id: string };
      for (const r of (regsRes.data ?? []) as unknown as RegRow[]) {
        counts.set(r.event_id, (counts.get(r.event_id) ?? 0) + 1);
        const set = players.get(r.event_id) ?? new Set<string>();
        set.add(r.player_id);
        players.set(r.event_id, set);
      }
      setTeamsByEvent(counts);
      setPlayersByEvent(players);
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
  // ─── Overlap detection ─────────────────────────────────────────────
  // Two flavors of conflict, both surfaced to the organizer:
  //
  //   1. Court overlap — two events share at least one court AND
  //      their time windows touch. Hard conflict; one of them won't
  //      actually be able to play.
  //
  //   2. Player overlap — a player registered in two events whose
  //      time windows touch. Soft conflict (they can't be on two
  //      courts at once, but in practice some no-shows / late
  //      starts make it survivable). Surfaced as a warning, not an
  //      error.
  //
  // Both are pair-wise comparisons. Only events with a
  // scheduled_start_at participate.
  const overlaps = useMemo<Overlap[]>(() => {
    const list: Overlap[] = [];
    const scheduled = rows.filter(
      (r) => r.scheduledStart !== null && r.scheduledEnd !== null,
    );
    for (let i = 0; i < scheduled.length; i++) {
      for (let j = i + 1; j < scheduled.length; j++) {
        const a = scheduled[i];
        const b = scheduled[j];
        const aStart = a.scheduledStart!.getTime();
        const aEnd = a.scheduledEnd!.getTime();
        const bStart = b.scheduledStart!.getTime();
        const bEnd = b.scheduledEnd!.getTime();
        // Half-open intervals — events that touch end-to-start aren't
        // a conflict (one ends exactly when the other begins).
        const overlapStart = Math.max(aStart, bStart);
        const overlapEnd = Math.min(aEnd, bEnd);
        if (overlapStart >= overlapEnd) continue;

        // Court overlap
        const aCourts = new Set(a.courtNumbers);
        const sharedCourts = b.courtNumbers.filter((c) => aCourts.has(c));
        if (sharedCourts.length > 0) {
          list.push({
            type: "court",
            a,
            b,
            courts: sharedCourts,
            windowStart: new Date(overlapStart),
            windowEnd: new Date(overlapEnd),
          });
        }

        // Player overlap — count players appearing in both events.
        const aPlayers = playersByEvent.get(a.event.id);
        const bPlayers = playersByEvent.get(b.event.id);
        if (aPlayers && bPlayers) {
          let shared = 0;
          for (const id of aPlayers) if (bPlayers.has(id)) shared++;
          if (shared > 0) {
            list.push({
              type: "player",
              a,
              b,
              sharedPlayerCount: shared,
              windowStart: new Date(overlapStart),
              windowEnd: new Date(overlapEnd),
            });
          }
        }
      }
    }
    return list;
  }, [rows, playersByEvent]);

  // Per-event lookup so the table can render badges on affected rows.
  const overlapsByEventId = useMemo(() => {
    const m = new Map<string, Overlap[]>();
    for (const o of overlaps) {
      for (const id of [o.a.event.id, o.b.event.id]) {
        const arr = m.get(id) ?? [];
        arr.push(o);
        m.set(id, arr);
      }
    }
    return m;
  }, [overlaps]);

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

  const courtCount = tournament.locations?.court_count ?? null;
  if (courtCount == null || courtCount < 1) {
    return (
      <NoCourtCountNotice
        orgSlug={org.slug}
        tournamentSlug={tournament.slug}
        hasVenue={tournament.location_id != null}
      />
    );
  }

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

          {overlaps.length > 0 && (
            <ConflictsPanel overlaps={overlaps} />
          )}

          {/* View tabs — Table is editable, Calendar is read-only
              visual. URL-driven so refresh + back behave. */}
          <ViewTabs view={view} onChange={setView} />

          {view === "calendar" && (
            <CourtTimeline
              courtCount={courtCount}
              rows={rows}
            />
          )}

          {view === "table" && (
            <>
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
                <th style={thStyle}>Courts</th>
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
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        flexWrap: "wrap",
                      }}
                    >
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
                      <RowConflictBadges
                        conflicts={overlapsByEventId.get(r.event.id) ?? []}
                        thisEventId={r.event.id}
                      />
                    </div>
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
                    style={tdStyle}
                    title={
                      r.courtNumbers.length === 0
                        ? "No courts assigned — estimate uses 1 court (pessimistic). Allocate courts on the tournament page."
                        : undefined
                    }
                  >
                    <CourtPills
                      total={courtCount}
                      assigned={r.courtNumbers}
                    />
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
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// UI bits
// ─────────────────────────────────────────────────────────────────────

// Compact court chips mirroring the tournament-homepage event-card
// look: one pill per court (1..total). Assigned courts render
// solid-blue; unassigned render outlined-gray. Numbers-only so the
// row stays compact even at 16 courts.
function CourtPills({
  total,
  assigned,
}: {
  total: number;
  assigned: number[];
}) {
  const claimed = new Set(assigned);
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
      }}
    >
      {Array.from({ length: total }, (_, i) => i + 1).map((n) => {
        const mine = claimed.has(n);
        return (
          <span
            key={n}
            style={{
              minWidth: 22,
              padding: "2px 6px",
              background: mine ? "#2563eb" : "#fff",
              color: mine ? "#fff" : "#9ca3af",
              border: `1px solid ${mine ? "#2563eb" : "#d1d5db"}`,
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 500,
              textAlign: "center",
              lineHeight: 1.4,
            }}
          >
            {n}
          </span>
        );
      })}
    </div>
  );
}

function ViewTabs({
  view,
  onChange,
}: {
  view: "table" | "calendar";
  onChange: (v: "table" | "calendar") => void;
}) {
  const tabs: { key: "table" | "calendar"; label: string }[] = [
    { key: "table", label: "Table" },
    { key: "calendar", label: "Calendar" },
  ];
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: 4,
        marginTop: 16,
        borderBottom: "1px solid #e5e7eb",
      }}
    >
      {tabs.map((t) => {
        const active = t.key === view;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: "none",
              borderBottom: `2px solid ${active ? "#2563eb" : "transparent"}`,
              color: active ? "#2563eb" : "#555",
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// Pixels per minute for the timeline. 1.4 ≈ 84px per hour — readable
// at typical viewport widths without burning vertical space.
const PIXELS_PER_MIN = 1.4;
// Minimum block height for very short events so the label still fits.
const MIN_BLOCK_PX = 28;

// Color palette for event blocks. Cycled by event index so the same
// event keeps the same color across renders. Hand-picked for decent
// contrast against the white timeline background and white block
// text.
const EVENT_PALETTE = [
  { bg: "#2563eb", border: "#1e40af" }, // blue
  { bg: "#16a34a", border: "#15803d" }, // green
  { bg: "#9333ea", border: "#6b21a8" }, // purple
  { bg: "#ea580c", border: "#9a3412" }, // orange
  { bg: "#0891b2", border: "#155e75" }, // teal
  { bg: "#db2777", border: "#9d174d" }, // pink
  { bg: "#65a30d", border: "#3f6212" }, // lime
  { bg: "#7c3aed", border: "#5b21b6" }, // violet
];

// Visual schedule: one column per court, time runs top-to-bottom,
// events render as colored blocks positioned by start time and sized
// by duration. Events using multiple courts appear in each of their
// court columns so multi-court events are obvious at a glance.
//
// Multi-day tournaments render one timeline section per calendar
// day (events grouped by their start date) so a 4-day tournament
// doesn't collapse into one unreadable 96-hour column.
//
// Skips rendering when no event has a scheduled_start_at — there's
// nothing to draw yet, and a blank timeline is worse than no
// timeline.
function CourtTimeline({
  courtCount,
  rows,
}: {
  courtCount: number;
  rows: EventRow[];
}) {
  const scheduled = rows.filter(
    (r) => r.scheduledStart !== null && r.scheduledEnd !== null,
  );
  if (scheduled.length === 0) return null;

  // Color assignment by stable event index — sorting by scheduled
  // start so colors map to chronological order, which makes the
  // visual flow easier to track. The map is shared across days so
  // an event appears in the same color on every day it touches.
  const colorByEvent = new Map<string, (typeof EVENT_PALETTE)[number]>();
  const sortedByStart = scheduled
    .slice()
    .sort(
      (a, b) =>
        a.scheduledStart!.getTime() - b.scheduledStart!.getTime() ||
        a.event.name.localeCompare(b.event.name),
    );
  sortedByStart.forEach((r, i) => {
    colorByEvent.set(r.event.id, EVENT_PALETTE[i % EVENT_PALETTE.length]);
  });

  // Group events by start day. Events that cross midnight stay
  // attached to their start day; in practice pickleball events
  // rarely span midnight, and the alternative (clipping at midnight
  // and continuing the next day) adds a lot of UI complexity for
  // very little win.
  const byDay = new Map<string, EventRow[]>();
  for (const r of scheduled) {
    const key = dayKey(r.scheduledStart!);
    const arr = byDay.get(key) ?? [];
    arr.push(r);
    byDay.set(key, arr);
  }
  const days = Array.from(byDay.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    <section style={{ marginTop: 16 }}>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#666" }}>
        Each column is one court. Events using multiple courts appear in
        every column they claim, so multi-court events are obvious at a
        glance. Hover a block for details.
      </p>
      {days.map(([key, dayRows]) => (
        <DayTimeline
          key={key}
          dayLabel={fmtDayHeading(new Date(key))}
          rows={dayRows}
          courtCount={courtCount}
          colorByEvent={colorByEvent}
          showHeading={days.length > 1}
        />
      ))}
    </section>
  );
}

// Stable per-day key (YYYY-MM-DD in local time) so two events on the
// same calendar day group together even when they were entered
// minutes apart.
function dayKey(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDayHeading(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function DayTimeline({
  dayLabel,
  rows,
  courtCount,
  colorByEvent,
  showHeading,
}: {
  dayLabel: string;
  rows: EventRow[];
  courtCount: number;
  colorByEvent: Map<string, (typeof EVENT_PALETTE)[number]>;
  showHeading: boolean;
}) {
  // Window for this day's timeline: clamp to the hour on both sides
  // so the gridlines land cleanly.
  let minMs = Math.min(...rows.map((r) => r.scheduledStart!.getTime()));
  let maxMs = Math.max(...rows.map((r) => r.scheduledEnd!.getTime()));
  minMs = floorToHour(minMs);
  maxMs = ceilToHour(maxMs);
  const totalMinutes = (maxMs - minMs) / 60_000;
  const totalHeight = Math.max(120, totalMinutes * PIXELS_PER_MIN);

  const hourTicks: number[] = [];
  for (let t = minMs; t <= maxMs; t += 3600_000) hourTicks.push(t);

  const courts = Array.from({ length: courtCount }, (_, i) => i + 1);
  const eventsOnCourt = (court: number) =>
    rows.filter((r) => r.courtNumbers.includes(court));

  return (
    <div style={{ marginBottom: 24 }}>
      {showHeading && (
        <h3
          style={{
            margin: "0 0 8px",
            fontSize: 13,
            fontWeight: 600,
            color: "#444",
          }}
        >
          {dayLabel}
        </h3>
      )}
      <div
        style={{
          display: "flex",
          gap: 8,
          overflowX: "auto",
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 6,
          padding: 12,
        }}
      >
        {/* Time axis column */}
        <div
          style={{
            width: 56,
            position: "relative",
            flexShrink: 0,
            paddingTop: 24, // align with court column headers
          }}
        >
          <div style={{ position: "relative", height: totalHeight }}>
            {hourTicks.map((t) => {
              const top = ((t - minMs) / 60_000) * PIXELS_PER_MIN;
              return (
                <div
                  key={t}
                  style={{
                    position: "absolute",
                    top,
                    left: 0,
                    right: 0,
                    fontSize: 10,
                    color: "#888",
                    textAlign: "right",
                    paddingRight: 6,
                    transform: "translateY(-50%)",
                  }}
                >
                  {fmtHourTick(t)}
                </div>
              );
            })}
          </div>
        </div>

        {/* One column per court */}
        {courts.map((court) => {
          const events = eventsOnCourt(court);
          return (
            <div
              key={court}
              style={{
                flex: "1 1 140px",
                minWidth: 140,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: "#444",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  textAlign: "center",
                  paddingBottom: 4,
                  marginBottom: 4,
                  borderBottom: "1px solid #e5e7eb",
                }}
              >
                Court {court}
              </div>
              <div
                style={{
                  position: "relative",
                  height: totalHeight,
                  background: "#fafafa",
                  borderRadius: 4,
                  border: "1px solid #e5e7eb",
                }}
              >
                {/* Hour gridlines inside the column */}
                {hourTicks.map((t, i) => {
                  if (i === 0) return null; // top edge already shown by border
                  const top = ((t - minMs) / 60_000) * PIXELS_PER_MIN;
                  return (
                    <div
                      key={t}
                      style={{
                        position: "absolute",
                        top,
                        left: 0,
                        right: 0,
                        height: 1,
                        background: "#e5e7eb",
                        pointerEvents: "none",
                      }}
                    />
                  );
                })}

                {events.length === 0 ? (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#bbb",
                      fontSize: 11,
                      fontStyle: "italic",
                    }}
                  >
                    No events
                  </div>
                ) : (
                  events.map((r) => {
                    const start = r.scheduledStart!.getTime();
                    const end = r.scheduledEnd!.getTime();
                    const top = ((start - minMs) / 60_000) * PIXELS_PER_MIN;
                    const height = Math.max(
                      MIN_BLOCK_PX,
                      ((end - start) / 60_000) * PIXELS_PER_MIN,
                    );
                    const color =
                      colorByEvent.get(r.event.id) ?? EVENT_PALETTE[0];
                    return (
                      <div
                        key={r.event.id}
                        title={`${r.event.name} — ${fmtRange(
                          r.scheduledStart!,
                          r.scheduledEnd!,
                        )}`}
                        style={{
                          position: "absolute",
                          top: top + 2,
                          left: 2,
                          right: 2,
                          height: Math.max(MIN_BLOCK_PX - 4, height - 4),
                          background: color.bg,
                          border: `1px solid ${color.border}`,
                          borderRadius: 4,
                          color: "#fff",
                          padding: "4px 6px",
                          fontSize: 11,
                          fontWeight: 500,
                          lineHeight: 1.2,
                          overflow: "hidden",
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "flex-start",
                        }}
                      >
                        <div
                          style={{
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {r.event.name}
                        </div>
                        <div
                          style={{
                            fontSize: 10,
                            opacity: 0.85,
                            marginTop: 1,
                          }}
                        >
                          {fmtTime(r.scheduledStart!)}–
                          {fmtTime(r.scheduledEnd!)}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function fmtHourTick(ms: number): string {
  const d = new Date(ms);
  // Compact label: drop the ":00" so the axis isn't visually noisy.
  return d
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    .replace(":00", "");
}

function floorToHour(ms: number): number {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function ceilToHour(ms: number): number {
  const floored = floorToHour(ms);
  return floored === ms ? floored : floored + 3600_000;
}

// Summary panel rendered above the table when any conflict exists.
// Court conflicts are hard errors (red); player conflicts are
// warnings (amber, per docs/DESIGN_PREFERENCES.md "amber = note").
function ConflictsPanel({ overlaps }: { overlaps: Overlap[] }) {
  const courtCount = overlaps.filter((o) => o.type === "court").length;
  const playerCount = overlaps.filter((o) => o.type === "player").length;
  return (
    <div
      style={{
        marginTop: 16,
        padding: 12,
        background: courtCount > 0 ? "#fef2f2" : "#fffbeb",
        border: `1px solid ${courtCount > 0 ? "#fecaca" : "#fde68a"}`,
        borderRadius: 6,
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: courtCount > 0 ? "#991b1b" : "#92400e",
          marginBottom: 8,
        }}
      >
        {courtCount > 0
          ? `${courtCount} court conflict${courtCount === 1 ? "" : "s"}`
          : ""}
        {courtCount > 0 && playerCount > 0 ? " · " : ""}
        {playerCount > 0
          ? `${playerCount} player conflict${playerCount === 1 ? "" : "s"}`
          : ""}
      </div>
      <ul
        style={{
          margin: 0,
          paddingLeft: 18,
          fontSize: 12,
          color: "#444",
          lineHeight: 1.6,
        }}
      >
        {overlaps.map((o, i) => (
          <li key={i}>
            {o.type === "court" ? (
              <>
                <strong>Court {o.courts.join(", ")}</strong> double-booked:{" "}
                <em>{o.a.event.name}</em> and <em>{o.b.event.name}</em> both
                use{" "}
                {o.courts.length === 1
                  ? `court ${o.courts[0]}`
                  : `courts ${o.courts.join(", ")}`}{" "}
                during {fmtRange(o.windowStart, o.windowEnd)}.
              </>
            ) : (
              <>
                <strong>{o.sharedPlayerCount} player(s)</strong> registered
                in both <em>{o.a.event.name}</em> and{" "}
                <em>{o.b.event.name}</em>, which overlap during{" "}
                {fmtRange(o.windowStart, o.windowEnd)}.
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Per-row badges, shown next to the event name in the table. Compact
// — just dot-count of court (red) and player (amber) conflicts that
// involve this row.
function RowConflictBadges({
  conflicts,
  thisEventId,
}: {
  conflicts: Overlap[];
  thisEventId: string;
}) {
  const courtConflicts = conflicts.filter((o) => o.type === "court");
  const playerConflicts = conflicts.filter((o) => o.type === "player");
  if (courtConflicts.length === 0 && playerConflicts.length === 0) return null;

  const partnerNames = (list: Overlap[]) =>
    list
      .map((o) => (o.a.event.id === thisEventId ? o.b.event.name : o.a.event.name))
      .join(", ");

  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      {courtConflicts.length > 0 && (
        <span
          title={`Court conflict with: ${partnerNames(courtConflicts)}`}
          style={{
            padding: "1px 6px",
            background: "#fef2f2",
            color: "#991b1b",
            border: "1px solid #fecaca",
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.3,
          }}
        >
          ⚠ Court
        </span>
      )}
      {playerConflicts.length > 0 && (
        <span
          title={`Player conflict with: ${partnerNames(playerConflicts)}`}
          style={{
            padding: "1px 6px",
            background: "#fffbeb",
            color: "#92400e",
            border: "1px solid #fde68a",
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.3,
          }}
        >
          ⚠ Player
        </span>
      )}
    </span>
  );
}

function fmtRange(start: Date, end: Date): string {
  const time = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) {
    return `${time(start)} – ${time(end)}`;
  }
  return `${start.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} – ${end.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

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

