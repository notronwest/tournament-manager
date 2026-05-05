import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { autoTransitionEventStatus } from "../../lib/eventStatus";
import {
  matchLabel,
  playoffStageLabel,
  playoffStageStyle,
} from "../../lib/matchLabel";
import { feedForwardPlayoffWinners } from "../../lib/playoffFeedForward";
import type { Database } from "../../types/supabase";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];
type EventRegistration =
  Database["public"]["Tables"]["event_registrations"]["Row"];
type EventCourt = Database["public"]["Tables"]["event_courts"]["Row"];
type Match = Database["public"]["Tables"]["matches"]["Row"];

type Team = {
  captainRegId: string;
  partnerRegId: string | null;
  label: string;
};

type RankedSuggestion = {
  match: Match;
  score: number;
};

// Tournament-level court manager.
//
// Walks 1..tournament.court_count. For each court:
//   * Find the active event holding the court (event_courts join).
//   * If no owner ⇒ "Unassigned" card.
//   * If an in_progress match on that court ⇒ score-entry card.
//   * Otherwise ⇒ suggest a pending match from the owning event,
//     coordinated with sibling courts of the same event so no team is
//     suggested twice.
//
// Suggestion ranking is per-event: max(lastPlayed_A, lastPlayed_B) ASC
// (oldest "most recent" timestamp = team that has waited longest).
export default function TournamentCourtManagerPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug } = useParams<{ tournamentSlug: string }>();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [activeEvents, setActiveEvents] = useState<Event[]>([]);
  const [eventCourts, setEventCourts] = useState<EventCourt[]>([]);
  const [regs, setRegs] = useState<EventRegistration[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!org || !tournamentSlug) return;
    // Don't flip loading=true on subsequent reloads — that flashes the
    // skeleton over the live courts grid every time you load a match or
    // submit a score. Initial useState(true) covers the first paint.
    setError(null);

    const { data: tData, error: tErr } = await supabase
      .from("tournaments")
      .select("*")
      .eq("organization_id", org.id)
      .eq("slug", tournamentSlug)
      .is("deleted_at", null)
      .maybeSingle();
    if (tErr) {
      setError(tErr.message);
      setLoading(false);
      return;
    }
    if (!tData) {
      setError("Tournament not found.");
      setLoading(false);
      return;
    }
    setTournament(tData);

    // Events currently in play — running or in their medal round. Paused
    // (on_hold) events keep their court allocation but don't load
    // suggestions; they show in the homepage's per-event cards instead.
    const { data: evData, error: evErr } = await supabase
      .from("events")
      .select("*")
      .eq("tournament_id", tData.id)
      .in("status", ["active", "medal_round"])
      .is("deleted_at", null);
    if (evErr) {
      setError(evErr.message);
      setLoading(false);
      return;
    }
    const activeEvs = evData ?? [];
    setActiveEvents(activeEvs);

    if (activeEvs.length === 0) {
      setEventCourts([]);
      setRegs([]);
      setPlayers([]);
      setMatches([]);
      setLoading(false);
      return;
    }

    const evIds = activeEvs.map((e) => e.id);
    const [courtsRes, regsRes, matchesRes] = await Promise.all([
      supabase.from("event_courts").select("*").in("event_id", evIds),
      supabase
        .from("event_registrations")
        .select("*")
        .in("event_id", evIds)
        .is("deleted_at", null),
      supabase
        .from("matches")
        .select("*")
        .in("event_id", evIds)
        .order("stage", { ascending: true })
        .order("round", { ascending: true })
        .order("position", { ascending: true }),
    ]);

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
    if (matchesRes.error) {
      setError(matchesRes.error.message);
      setLoading(false);
      return;
    }

    setEventCourts(courtsRes.data ?? []);
    setRegs(regsRes.data ?? []);
    setMatches(matchesRes.data ?? []);

    const playerIds = Array.from(
      new Set((regsRes.data ?? []).map((r) => r.player_id)),
    );
    if (playerIds.length === 0) {
      setPlayers([]);
    } else {
      const { data: playersData, error: playersErr } = await supabase
        .from("players")
        .select("*")
        .in("id", playerIds);
      if (playersErr) {
        setError(playersErr.message);
        setLoading(false);
        return;
      }
      setPlayers(playersData ?? []);
    }
    setLoading(false);
  }, [org, tournamentSlug]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const teamByAnyRegId = useMemo(
    () => buildTeamLookup(regs, players),
    [regs, players],
  );
  const eventById = useMemo(
    () => new Map(activeEvents.map((e) => [e.id, e])),
    [activeEvents],
  );
  // Per-event match set, used to compute matchLabel (which needs the
  // full event match list to disambiguate "Final" vs "Semi-1" etc).
  const matchesByEvent = useMemo(() => {
    const m = new Map<string, Match[]>();
    for (const x of matches) {
      const arr = m.get(x.event_id) ?? [];
      arr.push(x);
      m.set(x.event_id, arr);
    }
    return m;
  }, [matches]);

  // Active events whose round-robin is finished but whose playoff
  // bracket hasn't been generated yet — surface a banner above the
  // courts grid linking to the event console (where the actual
  // generator lives) so the organizer can transition without leaving
  // the dispatcher view.
  const eventsAwaitingPlayoff = useMemo(() => {
    return activeEvents.filter((ev) => {
      // No playoff configured for this event → nothing to generate.
      if (ev.teams_advancing_to_playoff <= 0) return false;
      const evMatches = matchesByEvent.get(ev.id) ?? [];
      const rr = evMatches.filter((m) => m.stage === "round_robin");
      const playoff = evMatches.filter((m) => m.stage === "playoff");
      const rrComplete =
        rr.length > 0 && rr.every((m) => m.status === "completed");
      return rrComplete && playoff.length === 0;
    });
  }, [activeEvents, matchesByEvent]);

  // Court number → owning active event id.
  const ownerByCourt = useMemo(() => {
    const m = new Map<number, string>();
    for (const ec of eventCourts) {
      if (eventById.has(ec.event_id)) m.set(ec.court_number, ec.event_id);
    }
    return m;
  }, [eventCourts, eventById]);

  const inProgressByCourt = useMemo(() => {
    const m = new Map<string, Match>();
    for (const x of matches) {
      if (x.status === "in_progress" && x.court) m.set(x.court, x);
    }
    return m;
  }, [matches]);

  // Per-event lastPlayed map (used for suggestion scoring).
  const lastPlayedByEvent = useMemo(() => {
    const out = new Map<string, Map<string, number>>();
    for (const m of matches) {
      if (m.status === "pending") continue;
      const map = out.get(m.event_id) ?? new Map<string, number>();
      const t = new Date(m.updated_at).getTime();
      for (const reg of [m.team_a_reg_id, m.team_b_reg_id]) {
        if (!reg) continue;
        const prev = map.get(reg) ?? 0;
        if (t > prev) map.set(reg, t);
      }
      out.set(m.event_id, map);
    }
    return out;
  }, [matches]);

  // Per-event busy teams (currently on a court anywhere).
  const busyTeamsByEvent = useMemo(() => {
    const out = new Map<string, Set<string>>();
    for (const m of matches) {
      if (m.status !== "in_progress") continue;
      const set = out.get(m.event_id) ?? new Set<string>();
      if (m.team_a_reg_id) set.add(m.team_a_reg_id);
      if (m.team_b_reg_id) set.add(m.team_b_reg_id);
      out.set(m.event_id, set);
    }
    return out;
  }, [matches]);

  // Suggestion list per event (ranked, eligible only).
  const rankedByEvent = useMemo(() => {
    const out = new Map<string, RankedSuggestion[]>();
    for (const ev of activeEvents) {
      const lastPlayed =
        lastPlayedByEvent.get(ev.id) ?? new Map<string, number>();
      const busy = busyTeamsByEvent.get(ev.id) ?? new Set<string>();
      const eligible = matches
        .filter(
          (m) =>
            m.event_id === ev.id &&
            m.status === "pending" &&
            m.team_a_reg_id &&
            m.team_b_reg_id &&
            !busy.has(m.team_a_reg_id) &&
            !busy.has(m.team_b_reg_id),
        )
        .map((m) => {
          const lastA = lastPlayed.get(m.team_a_reg_id!) ?? 0;
          const lastB = lastPlayed.get(m.team_b_reg_id!) ?? 0;
          return { match: m, score: Math.max(lastA, lastB) };
        })
        .sort(
          (x, y) =>
            x.score - y.score || x.match.position - y.match.position,
        );
      out.set(ev.id, eligible);
    }
    return out;
  }, [activeEvents, matches, lastPlayedByEvent, busyTeamsByEvent]);

  // For each court, work out the suggestion. We coordinate per event: a
  // single event's empty courts get disjoint suggestions (no shared
  // teams). We walk courts in number order so allocation is stable.
  const suggestionByCourt = useMemo(() => {
    const map = new Map<number, Match>();
    if (!tournament) return map;

    const usedTeamsByEvent = new Map<string, Set<string>>();

    const courts = Array.from({ length: tournament.court_count }, (_, i) => i + 1);
    for (const cn of courts) {
      const eventId = ownerByCourt.get(cn);
      if (!eventId) continue;
      if (inProgressByCourt.has(`Court ${cn}`)) continue;
      const ranked = rankedByEvent.get(eventId) ?? [];
      const used = usedTeamsByEvent.get(eventId) ?? new Set<string>();
      const next = ranked.find(
        ({ match }) =>
          !used.has(match.team_a_reg_id!) &&
          !used.has(match.team_b_reg_id!),
      );
      if (next) {
        map.set(cn, next.match);
        used.add(next.match.team_a_reg_id!);
        used.add(next.match.team_b_reg_id!);
        usedTeamsByEvent.set(eventId, used);
      }
    }
    return map;
  }, [tournament, ownerByCourt, inProgressByCourt, rankedByEvent]);

  // Flattened pending queue across all active events. Excludes whatever
  // is currently suggested onto a court (those are shown in the grid
  // above). Ordered by oldest "last played" first — same fairness
  // signal we use for per-court suggestions. This is the "what's next
  // when a court frees up" view.
  const availableMatches = useMemo(() => {
    const suggIds = new Set(
      Array.from(suggestionByCourt.values()).map((m) => m.id),
    );
    const items: RankedSuggestion[] = [];
    for (const ev of activeEvents) {
      for (const r of rankedByEvent.get(ev.id) ?? []) {
        if (!suggIds.has(r.match.id)) items.push(r);
      }
    }
    return items.sort(
      (a, b) =>
        a.score - b.score || a.match.position - b.match.position,
    );
  }, [activeEvents, rankedByEvent, suggestionByCourt]);

  const onLoad = async (matchId: string, court: string) => {
    setError(null);
    const { error: updErr } = await supabase
      .from("matches")
      .update({ court, status: "in_progress" })
      .eq("id", matchId);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    await reload();
  };

  const onCancel = async (matchId: string) => {
    setError(null);
    const { error: updErr } = await supabase
      .from("matches")
      .update({ court: null, status: "pending" })
      .eq("id", matchId);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    await reload();
  };

  const [simulating, setSimulating] = useState(false);

  // Dev/test helper: load every empty court with its current
  // suggestion, then auto-score every in-progress match using random
  // sample scores (winner = points_to_win, loser = 0..points_to_win
  // − win_by). One click ≈ one round of play. Uses the same code
  // paths as manual entry so feed-forward + status auto-transitions
  // run identically.
  const onSimulateRound = async () => {
    setError(null);
    setSimulating(true);

    // 1. Load suggestions onto empty courts. Suggestions are already
    //    coordinated so no team appears on two courts simultaneously.
    for (const [courtNum, match] of suggestionByCourt.entries()) {
      const { error: lErr } = await supabase
        .from("matches")
        .update({ court: `Court ${courtNum}`, status: "in_progress" })
        .eq("id", match.id);
      if (lErr) {
        setError(lErr.message);
        setSimulating(false);
        return;
      }
    }

    // 2. Re-fetch all in-progress matches across active events (will
    //    include both freshly-loaded and any previously running).
    const evIds = activeEvents.map((e) => e.id);
    if (evIds.length === 0) {
      setSimulating(false);
      return;
    }
    const { data: live, error: lqErr } = await supabase
      .from("matches")
      .select("*")
      .in("event_id", evIds)
      .eq("status", "in_progress");
    if (lqErr) {
      setError(lqErr.message);
      setSimulating(false);
      return;
    }

    // 3. Generate a sample score for each, run feed-forward + status
    //    update sequentially so playoff bronze-game writes stay
    //    consistent (we don't want two semis racing on the same
    //    final/bronze record).
    for (const m of live ?? []) {
      const ev = eventById.get(m.event_id);
      if (!ev) continue;
      const winnerScore = ev.points_to_win;
      const loserMax = Math.max(0, ev.points_to_win - ev.win_by);
      const loserScore = Math.floor(Math.random() * (loserMax + 1));
      const flip = Math.random() < 0.5;
      const a = flip ? winnerScore : loserScore;
      const b = flip ? loserScore : winnerScore;
      const winnerRegId = a > b ? m.team_a_reg_id : m.team_b_reg_id;
      const loserRegId = a > b ? m.team_b_reg_id : m.team_a_reg_id;
      const { error: updErr } = await supabase
        .from("matches")
        .update({
          team_a_score: a,
          team_b_score: b,
          winner_reg_id: winnerRegId,
          status: "completed",
        })
        .eq("id", m.id);
      if (updErr) {
        setError(updErr.message);
        setSimulating(false);
        return;
      }
      if (winnerRegId) {
        await feedForwardPlayoffWinners(m, winnerRegId, loserRegId);
      }
      await autoTransitionEventStatus(m.event_id);
    }

    setSimulating(false);
    await reload();
  };

  const onSubmitScore = async (
    match: Match,
    scoreA: number,
    scoreB: number,
  ) => {
    setError(null);
    const winnerRegId =
      scoreA > scoreB ? match.team_a_reg_id : match.team_b_reg_id;
    const loserRegId =
      scoreA > scoreB ? match.team_b_reg_id : match.team_a_reg_id;
    const { error: updErr } = await supabase
      .from("matches")
      .update({
        team_a_score: scoreA,
        team_b_score: scoreB,
        winner_reg_id: winnerRegId,
        status: "completed",
      })
      .eq("id", match.id);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    if (winnerRegId) {
      await feedForwardPlayoffWinners(match, winnerRegId, loserRegId);
    }
    await autoTransitionEventStatus(match.event_id);
    await reload();
  };

  if (!org) return null;
  if (loading)
    return <div style={{ color: "#666", fontSize: 14 }}>Loading…</div>;
  if (error) return <ErrorBox message={error} />;
  if (!tournament) return null;

  const courts = Array.from(
    { length: tournament.court_count },
    (_, i) => i + 1,
  );
  const completedCount = matches.filter((m) => m.status === "completed").length;
  const inProgressCount = matches.filter((m) => m.status === "in_progress").length;
  const pendingCount = matches.filter((m) => m.status === "pending").length;

  const canSimulate =
    activeEvents.length > 0 &&
    (suggestionByCourt.size > 0 || inProgressCount > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "end",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <Link
            to={`/admin/${org.slug}/tournaments/${tournament.slug}`}
            style={{ color: "#2563eb", textDecoration: "none", fontSize: 13 }}
          >
            ← {tournament.name}
          </Link>
          <h1 style={{ margin: "12px 0 4px", fontSize: 22 }}>Court manager</h1>
          <p style={{ color: "#666", margin: 0, fontSize: 13 }}>
            {activeEvents.length}{" "}
            {activeEvents.length === 1 ? "active event" : "active events"} ·{" "}
            {completedCount} completed · {inProgressCount} in progress ·{" "}
            {pendingCount} pending
          </p>
        </div>
        <button
          onClick={onSimulateRound}
          disabled={!canSimulate || simulating}
          title="Loads next-best suggestions onto empty courts and auto-scores every in-progress match. Useful for stress-testing the bracket — uses random sample scores."
          style={{
            padding: "6px 12px",
            background: "#fff",
            color: "#7c3aed",
            border: "1px solid #c4b5fd",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 500,
            cursor: !canSimulate || simulating ? "not-allowed" : "pointer",
            fontFamily: "inherit",
            opacity: !canSimulate || simulating ? 0.5 : 1,
          }}
        >
          {simulating ? "Simulating…" : "Simulate round"}
        </button>
      </div>

      {activeEvents.length === 0 && (
        <Empty>
          No active events. Start an event from the tournament page to begin.
        </Empty>
      )}

      {eventsAwaitingPlayoff.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {eventsAwaitingPlayoff.map((ev) => (
            <div
              key={ev.id}
              style={{
                padding: "12px 16px",
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                borderRadius: 8,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div style={{ fontSize: 13, color: "#1e3a8a" }}>
                <strong>{ev.name}</strong>: round-robin complete. Time to
                generate the playoff bracket.
              </div>
              <Link
                to={`/admin/${org.slug}/tournaments/${tournament.slug}/events/${ev.id}`}
                style={{
                  padding: "6px 12px",
                  background: "#2563eb",
                  color: "#fff",
                  textDecoration: "none",
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                }}
              >
                Generate playoffs →
              </Link>
            </div>
          ))}
        </div>
      )}

      <div
        className="tcm-courts-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
          gap: 16,
        }}
      >
        {courts.map((cn) => {
          const courtName = `Court ${cn}`;
          const ownerId = ownerByCourt.get(cn) ?? null;
          const owner = ownerId ? eventById.get(ownerId) ?? null : null;
          const assigned = inProgressByCourt.get(courtName) ?? null;
          const assignedEvent = assigned
            ? eventById.get(assigned.event_id) ?? null
            : null;
          const suggestion = suggestionByCourt.get(cn) ?? null;

          // Stage labels for the in-progress match and the suggested
          // next match. Null for round-robin so the card only shows
          // a stage badge during medal-round play.
          const assignedStageLabel =
            assigned && assignedEvent
              ? playoffStageLabel(
                  assigned,
                  matchesByEvent.get(assignedEvent.id) ?? [],
                  assignedEvent,
                )
              : null;
          const suggestionStageLabel =
            suggestion && owner
              ? playoffStageLabel(
                  suggestion,
                  matchesByEvent.get(owner.id) ?? [],
                  owner,
                )
              : null;

          return (
            <CourtCard
              key={`${cn}:${assigned?.id ?? "empty"}:${owner?.id ?? "none"}`}
              courtName={courtName}
              owner={owner}
              assigned={assigned}
              assignedEvent={assignedEvent}
              assignedStageLabel={assignedStageLabel}
              suggestion={suggestion}
              suggestionStageLabel={suggestionStageLabel}
              teamByAnyRegId={teamByAnyRegId}
              onLoad={(matchId) => onLoad(matchId, courtName)}
              onCancel={onCancel}
              onSubmitScore={onSubmitScore}
              pickerOptions={
                ownerId
                  ? (rankedByEvent.get(ownerId) ?? [])
                      .filter(({ match }) => match.id !== suggestion?.id)
                      .map(({ match }) => match)
                  : []
              }
            />
          );
        })}
      </div>

      {activeEvents.length > 0 && (
        <section>
          <h2 style={{ margin: "0 0 12px", fontSize: 14, color: "#555" }}>
            Available matches{" "}
            <span style={{ color: "#888", fontWeight: 400 }}>
              ({availableMatches.length})
            </span>
          </h2>
          {availableMatches.length === 0 ? (
            <Empty>
              {pendingCount === 0
                ? "All matches are scheduled."
                : "No more matches can start until current courts free up."}
            </Empty>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 13,
                }}
              >
                <thead>
                  <tr style={{ background: "#fafafa" }}>
                    <th style={thStyle}>#</th>
                    <th style={thStyle}>Match</th>
                    <th style={thStyle}>Event</th>
                    <th style={thStyle}>Team A</th>
                    <th style={thStyle}>Team B</th>
                    <th style={thStyle}>Last played</th>
                  </tr>
                </thead>
                <tbody>
                  {availableMatches.map(({ match, score }, i) => {
                    const ev = eventById.get(match.event_id);
                    const teamA = match.team_a_reg_id
                      ? teamByAnyRegId.get(match.team_a_reg_id)
                      : null;
                    const teamB = match.team_b_reg_id
                      ? teamByAnyRegId.get(match.team_b_reg_id)
                      : null;
                    const eventMatches =
                      matchesByEvent.get(match.event_id) ?? [];
                    // Prefer verbose playoff label so the queue says
                    // "Gold Medal Match" — same vocabulary as the
                    // printed scorecard and the in-card stage badge.
                    const label =
                      (ev && playoffStageLabel(match, eventMatches, ev)) ||
                      matchLabel(match, eventMatches);
                    return (
                      <tr
                        key={match.id}
                        style={{ borderBottom: "1px solid #f3f4f6" }}
                      >
                        <td style={{ ...tdStyle, color: "#888" }}>{i + 1}</td>
                        <td
                          style={{
                            ...tdStyle,
                            fontFamily:
                              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                            fontSize: 12,
                            color: "#555",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {label}
                        </td>
                        <td style={tdStyle}>{ev?.name ?? "—"}</td>
                        <td style={tdStyle}>{teamA?.label ?? "—"}</td>
                        <td style={tdStyle}>{teamB?.label ?? "—"}</td>
                        <td style={{ ...tdStyle, color: "#888" }}>
                          {score === 0 ? "Never" : relativeMinutes(score)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Court card
// ─────────────────────────────────────────────────────────────────────

function CourtCard({
  courtName,
  owner,
  assigned,
  assignedEvent,
  assignedStageLabel,
  suggestion,
  suggestionStageLabel,
  teamByAnyRegId,
  pickerOptions,
  onLoad,
  onCancel,
  onSubmitScore,
}: {
  courtName: string;
  owner: Event | null;
  assigned: Match | null;
  assignedEvent: Event | null;
  assignedStageLabel: string | null;
  suggestion: Match | null;
  suggestionStageLabel: string | null;
  teamByAnyRegId: Map<string, Team>;
  pickerOptions: Match[];
  onLoad: (matchId: string) => Promise<void>;
  onCancel: (matchId: string) => Promise<void>;
  onSubmitScore: (m: Match, a: number, b: number) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [scoreA, setScoreA] = useState("");
  const [scoreB, setScoreB] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerValue, setPickerValue] = useState("");
  // Local state resets cleanly on assignment change because the parent
  // keys this card on assigned + owner.

  const teamLabel = (regId: string | null) =>
    regId ? (teamByAnyRegId.get(regId)?.label ?? "—") : "—";

  if (assigned) {
    const submit = async () => {
      const a = parseInt(scoreA, 10);
      const b = parseInt(scoreB, 10);
      if (Number.isNaN(a) || Number.isNaN(b)) {
        setErr("Both scores required.");
        return;
      }
      if (a < 0 || b < 0) {
        setErr("Scores can't be negative.");
        return;
      }
      if (a === b) {
        setErr("Scores can't be tied.");
        return;
      }
      setBusy(true);
      await onSubmitScore(assigned, a, b);
      setBusy(false);
    };

    return (
      <div style={cardStyle("#dcfce7")}>
        <CardHeader
          courtName={courtName}
          eventName={assignedEvent?.name ?? null}
          status="In progress"
          statusColor="#166534"
        />
        <StageBadge label={assignedStageLabel} />
        <div style={teamRow}>
          <span style={teamNameStyle}>{teamLabel(assigned.team_a_reg_id)}</span>
        </div>
        <div style={{ ...teamRow, color: "#999" }}>vs</div>
        <div style={teamRow}>
          <span style={teamNameStyle}>{teamLabel(assigned.team_b_reg_id)}</span>
        </div>

        <div
          style={{
            marginTop: 12,
            display: "flex",
            alignItems: "center",
            gap: 6,
            justifyContent: "center",
          }}
        >
          <input
            type="number"
            inputMode="numeric"
            min="0"
            value={scoreA}
            onChange={(e) => setScoreA(e.target.value)}
            disabled={busy}
            style={bigScoreInput}
            placeholder="A"
            autoFocus
          />
          <span style={{ color: "#999", fontSize: 18 }}>–</span>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            value={scoreB}
            onChange={(e) => setScoreB(e.target.value)}
            disabled={busy}
            style={bigScoreInput}
            placeholder="B"
          />
        </div>

        {err && (
          <div
            style={{
              color: "#991b1b",
              fontSize: 12,
              marginTop: 8,
              textAlign: "center",
            }}
          >
            {err}
          </div>
        )}

        <div
          style={{
            marginTop: 12,
            display: "flex",
            gap: 8,
            justifyContent: "center",
          }}
        >
          <button onClick={submit} disabled={busy} style={primaryBtn(busy)}>
            {busy ? "Saving…" : "Submit & free court"}
          </button>
          <button
            onClick={() => onCancel(assigned.id)}
            disabled={busy}
            style={secondaryBtn}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (!owner) {
    return (
      <div style={cardStyle("#fafafa")}>
        <CardHeader
          courtName={courtName}
          eventName={null}
          status="Unassigned"
          statusColor="#888"
        />
        <div
          style={{
            color: "#888",
            fontSize: 13,
            padding: "20px 0",
            textAlign: "center",
          }}
        >
          Assign this court to an event from the tournament page.
        </div>
      </div>
    );
  }

  return (
    <div style={cardStyle("#fafafa")}>
      <CardHeader
        courtName={courtName}
        eventName={owner.name}
        status="Empty"
        statusColor="#888"
      />
      <StageBadge label={suggestionStageLabel} />

      {suggestion ? (
        <>
          <div style={{ ...teamRow, color: "#444" }}>
            <span style={{ ...teamNameStyle, fontWeight: 500 }}>
              {teamLabel(suggestion.team_a_reg_id)}
            </span>
          </div>
          <div style={{ ...teamRow, color: "#999" }}>vs</div>
          <div style={{ ...teamRow, color: "#444" }}>
            <span style={{ ...teamNameStyle, fontWeight: 500 }}>
              {teamLabel(suggestion.team_b_reg_id)}
            </span>
          </div>
          <div
            style={{
              marginTop: 12,
              display: "flex",
              gap: 8,
              justifyContent: "center",
            }}
          >
            <button
              onClick={async () => {
                setBusy(true);
                await onLoad(suggestion.id);
                setBusy(false);
              }}
              disabled={busy}
              style={primaryBtn(busy)}
            >
              {busy ? "Loading…" : "Load this match"}
            </button>
            <button
              onClick={() => setShowPicker((v) => !v)}
              style={secondaryBtn}
            >
              Pick…
            </button>
          </div>
        </>
      ) : (
        <div
          style={{
            color: "#888",
            fontSize: 13,
            padding: "20px 0",
            textAlign: "center",
          }}
        >
          {pickerOptions.length === 0
            ? "No eligible matches."
            : "No suggestion — pick a match below."}
          {pickerOptions.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <button
                onClick={() => setShowPicker(true)}
                style={primaryBtn(false)}
              >
                Pick a match
              </button>
            </div>
          )}
        </div>
      )}

      {showPicker && pickerOptions.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <select
            value={pickerValue}
            onChange={(e) => setPickerValue(e.target.value)}
            style={{
              width: "100%",
              padding: "6px 8px",
              border: "1px solid #e2e2e2",
              borderRadius: 6,
              fontSize: 13,
              fontFamily: "inherit",
            }}
          >
            <option value="">Pick a match…</option>
            {pickerOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {teamLabel(m.team_a_reg_id)} vs {teamLabel(m.team_b_reg_id)}
              </option>
            ))}
          </select>
          <div
            style={{
              marginTop: 8,
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
            }}
          >
            <button
              onClick={() => {
                setShowPicker(false);
                setPickerValue("");
              }}
              style={secondaryBtn}
            >
              Cancel
            </button>
            <button
              disabled={!pickerValue || busy}
              onClick={async () => {
                if (!pickerValue) return;
                setBusy(true);
                await onLoad(pickerValue);
                setShowPicker(false);
                setPickerValue("");
                setBusy(false);
              }}
              style={primaryBtn(busy || !pickerValue)}
            >
              Load
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CardHeader({
  courtName,
  eventName,
  status,
  statusColor,
}: {
  courtName: string;
  eventName: string | null;
  status: string;
  statusColor: string;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{courtName}</h3>
        <span
          style={{
            fontSize: 11,
            color: statusColor,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            fontWeight: 600,
          }}
        >
          {status}
        </span>
      </div>
      {eventName && (
        <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
          {eventName}
        </div>
      )}
    </div>
  );
}

// Small chip rendered between the card header and the team rows when
// the match is part of a playoff. Gold/Bronze get the warm palettes
// from playoffStageStyle; semis/quarters/final stay neutral blue.
function StageBadge({ label }: { label: string | null }) {
  if (!label) return null;
  const palette = playoffStageStyle(label);
  if (!palette) return null;
  return (
    <div
      style={{
        margin: "0 0 12px",
        padding: "4px 10px",
        background: palette.background,
        color: palette.color,
        border: `1px solid ${palette.border}`,
        borderRadius: 4,
        fontSize: 12,
        fontWeight: 600,
        textAlign: "center",
        letterSpacing: 0.3,
      }}
    >
      {label}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function buildTeamLookup(
  regs: EventRegistration[],
  players: Player[],
): Map<string, Team> {
  const playerById = new Map(players.map((p) => [p.id, p]));
  const regById = new Map(regs.map((r) => [r.id, r]));
  const lookup = new Map<string, Team>();

  const seen = new Set<string>();
  for (const r of regs) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);

    let captainReg: EventRegistration = r;
    let partnerReg: EventRegistration | null = null;
    if (r.partner_registration_id) {
      const pr = regById.get(r.partner_registration_id);
      if (pr) {
        seen.add(pr.id);
        if (pr.id < captainReg.id) {
          partnerReg = captainReg;
          captainReg = pr;
        } else {
          partnerReg = pr;
        }
      }
    }

    const captain = playerById.get(captainReg.player_id);
    if (!captain) continue;
    const partner = partnerReg ? playerById.get(partnerReg.player_id) : null;
    const label = partner
      ? `${captain.first_name} ${captain.last_name} / ${partner.first_name} ${partner.last_name}`
      : `${captain.first_name} ${captain.last_name}`;
    const team: Team = {
      captainRegId: captainReg.id,
      partnerRegId: partnerReg?.id ?? null,
      label,
    };
    lookup.set(captainReg.id, team);
    if (partnerReg) lookup.set(partnerReg.id, team);
  }
  return lookup;
}

// ─────────────────────────────────────────────────────────────────────
// UI bits
// ─────────────────────────────────────────────────────────────────────

function ErrorBox({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: 10,
        background: "#fef2f2",
        border: "1px solid #fecaca",
        borderRadius: 6,
        color: "#991b1b",
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: 24,
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

function cardStyle(bg: string): CSSProperties {
  return {
    padding: 16,
    background: bg,
    border: "1px solid #e5e7eb",
    borderRadius: 8,
  };
}

const teamRow: CSSProperties = {
  fontSize: 14,
  textAlign: "center",
  padding: "4px 0",
};
const teamNameStyle: CSSProperties = { fontWeight: 500 };

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
  padding: "8px 12px",
};

function relativeMinutes(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

const bigScoreInput: CSSProperties = {
  width: 64,
  padding: "8px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 24,
  fontFamily: "inherit",
  textAlign: "center",
  fontWeight: 600,
};

function primaryBtn(busy: boolean): CSSProperties {
  return {
    padding: "8px 16px",
    background: busy ? "#9ca3af" : "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "inherit",
  };
}

const secondaryBtn: CSSProperties = {
  padding: "8px 16px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "inherit",
};
