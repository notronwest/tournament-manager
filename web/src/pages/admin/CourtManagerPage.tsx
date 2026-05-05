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
  playoffStageLabel,
  playoffStageStyle,
} from "../../lib/matchLabel";
import { feedForwardPlayoffWinners } from "../../lib/playoffFeedForward";
import type { Database } from "../../types/supabase";

type Event = Database["public"]["Tables"]["events"]["Row"];
type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];
type EventRegistration =
  Database["public"]["Tables"]["event_registrations"]["Row"];
type Match = Database["public"]["Tables"]["matches"]["Row"];

type Team = {
  captainRegId: string;
  partnerRegId: string | null;
  label: string;
};

// Court manager: dispatches pending matches onto a configurable number of
// courts, biasing toward teams that have been resting longest. Score
// entry happens on the court card; completing a match frees the court
// and the next suggestion fills in.
//
// We use the matches.court (text) field plus matches.status to track
// occupancy: a court is "free" if no in_progress match is assigned to
// it. Suggestions exclude any team currently playing on another court.
//
// Court count is per-event in localStorage — a tournament-wide setting
// would mean a schema bump and we can punt on that.
export default function CourtManagerPage() {
  const { org } = useCurrentOrg();
  const { tournamentSlug, eventId } = useParams<{
    tournamentSlug: string;
    eventId: string;
  }>();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [event, setEvent] = useState<Event | null>(null);
  const [regs, setRegs] = useState<EventRegistration[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [numCourts, setNumCourts] = useState(() => {
    if (!eventId) return 4;
    const stored = localStorage.getItem(`courts:${eventId}`);
    const n = stored ? parseInt(stored, 10) : 4;
    return Number.isFinite(n) && n >= 1 && n <= 16 ? n : 4;
  });
  useEffect(() => {
    if (eventId) localStorage.setItem(`courts:${eventId}`, String(numCourts));
  }, [eventId, numCourts]);

  const reload = useCallback(async () => {
    if (!org || !tournamentSlug || !eventId) return;
    // Don't flip loading=true on subsequent reloads — flickers the
    // skeleton over live courts every time. Initial useState(true)
    // covers first paint.
    setError(null);

    const { data: ev, error: evErr } = await supabase
      .from("events")
      .select("*, tournaments!inner(*)")
      .eq("id", eventId)
      .is("deleted_at", null)
      .maybeSingle();
    if (evErr) {
      setError(evErr.message);
      setLoading(false);
      return;
    }
    if (!ev) {
      setError("Event not found.");
      setLoading(false);
      return;
    }
    const t = (ev as { tournaments: Tournament | null }).tournaments;
    if (!t || t.organization_id !== org.id || t.slug !== tournamentSlug) {
      setError("Event not found in this tournament.");
      setLoading(false);
      return;
    }
    setTournament(t);
    setEvent(ev as Event);

    const [regsRes, matchesRes] = await Promise.all([
      supabase
        .from("event_registrations")
        .select("*")
        .eq("event_id", eventId)
        .is("deleted_at", null),
      supabase
        .from("matches")
        .select("*")
        .eq("event_id", eventId)
        .order("round", { ascending: true })
        .order("position", { ascending: true }),
    ]);
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
    const regsData = regsRes.data ?? [];
    setRegs(regsData);
    setMatches(matchesRes.data ?? []);

    const playerIds = Array.from(new Set(regsData.map((r) => r.player_id)));
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
  }, [org, tournamentSlug, eventId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const teamByAnyRegId = useMemo(
    () => buildTeamLookup(regs, players),
    [regs, players],
  );

  const courts = useMemo(
    () => Array.from({ length: numCourts }, (_, i) => `Court ${i + 1}`),
    [numCourts],
  );

  const courtAssignments = useMemo(() => {
    const m = new Map<string, Match>();
    for (const x of matches) {
      if (x.status === "in_progress" && x.court && courts.includes(x.court)) {
        m.set(x.court, x);
      }
    }
    return m;
  }, [matches, courts]);

  // Matches currently on a court (any court, even if outside our visible list).
  const inProgressMatches = useMemo(
    () => matches.filter((m) => m.status === "in_progress"),
    [matches],
  );

  // Teams currently on courts — excluded from suggestions.
  const busyTeams = useMemo(() => {
    const s = new Set<string>();
    for (const m of inProgressMatches) {
      if (m.team_a_reg_id) s.add(m.team_a_reg_id);
      if (m.team_b_reg_id) s.add(m.team_b_reg_id);
    }
    return s;
  }, [inProgressMatches]);

  // For each team, the most recent updated_at across non-pending matches —
  // proxy for "when did they last play". Teams that haven't played get 0,
  // which sorts as longest rest.
  const lastPlayedAt = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of matches) {
      if (x.status === "pending") continue;
      const t = new Date(x.updated_at).getTime();
      for (const reg of [x.team_a_reg_id, x.team_b_reg_id]) {
        if (!reg) continue;
        const prev = m.get(reg) ?? 0;
        if (t > prev) m.set(reg, t);
      }
    }
    return m;
  }, [matches]);

  // Pending matches (RR or playoff) scored by "longest-rested team",
  // filtered to exclude busy teams. The score is max(lastPlayed_A,
  // lastPlayed_B): lower means the team that played most recently in
  // this pair did so longer ago — i.e. the pair as a whole has been
  // waiting. Playoff matches are eligible as soon as both teams are
  // populated (feedForwardPlayoffWinners fills these in after each
  // upstream match completes), so they appear in the queue exactly
  // when they're ready to play.
  const rankedPending = useMemo(() => {
    return matches
      .filter(
        (m) =>
          m.status === "pending" &&
          m.team_a_reg_id &&
          m.team_b_reg_id,
      )
      .map((m) => {
        const lastA = lastPlayedAt.get(m.team_a_reg_id!) ?? 0;
        const lastB = lastPlayedAt.get(m.team_b_reg_id!) ?? 0;
        // Stage tiebreak: when wait-time is equal, finish the RR
        // round before serving up playoff. Comparators below sort
        // by score, then stage (RR before playoff), then position.
        return {
          match: m,
          score: Math.max(lastA, lastB),
          stageRank: m.stage === "round_robin" ? 0 : 1,
        };
      })
      .sort(
        (x, y) =>
          x.score - y.score ||
          x.stageRank - y.stageRank ||
          x.match.round - y.match.round ||
          x.match.position - y.match.position,
      );
  }, [matches, lastPlayedAt]);

  const eligibleRanked = useMemo(
    () =>
      rankedPending.filter(
        ({ match }) =>
          !busyTeams.has(match.team_a_reg_id!) &&
          !busyTeams.has(match.team_b_reg_id!),
      ),
    [rankedPending, busyTeams],
  );

  // Suggestions per empty court, greedily picked so no two suggestions
  // share a team. We walk courts in order; each empty court gets the
  // top remaining suggestion that doesn't overlap previously-suggested
  // teams.
  const suggestionByCourt = useMemo(() => {
    const map = new Map<string, Match>();
    const used = new Set<string>();
    for (const c of courts) {
      if (courtAssignments.has(c)) continue;
      const next = eligibleRanked.find(
        ({ match }) =>
          !used.has(match.team_a_reg_id!) &&
          !used.has(match.team_b_reg_id!) &&
          !Array.from(map.values()).some((m) => m.id === match.id),
      );
      if (next) {
        map.set(c, next.match);
        used.add(next.match.team_a_reg_id!);
        used.add(next.match.team_b_reg_id!);
      }
    }
    return map;
  }, [courts, courtAssignments, eligibleRanked]);

  // Up-next list — pending matches not assigned + not suggested to a court.
  const upNext = useMemo(() => {
    const suggIds = new Set(
      Array.from(suggestionByCourt.values()).map((m) => m.id),
    );
    return rankedPending
      .filter(({ match }) => !suggIds.has(match.id))
      .slice(0, 8);
  }, [rankedPending, suggestionByCourt]);

  const completedCount = matches.filter((m) => m.status === "completed").length;
  const pendingCount = matches.filter((m) => m.status === "pending").length;

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
  if (!event || !tournament) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <Link
          to={`/admin/${org.slug}/tournaments/${tournament.slug}/events/${event.id}`}
          style={{ color: "#2563eb", textDecoration: "none", fontSize: 13 }}
        >
          ← {event.name}
        </Link>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "end",
            marginTop: 12,
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 22 }}>Court manager</h1>
            <p style={{ color: "#666", margin: "4px 0 0", fontSize: 13 }}>
              {completedCount} completed · {inProgressMatches.length} in
              progress · {pendingCount} pending
            </p>
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              color: "#555",
            }}
          >
            Courts:
            <input
              type="number"
              min="1"
              max="16"
              value={numCourts}
              onChange={(e) => {
                const n = parseInt(e.target.value || "1", 10);
                if (Number.isFinite(n) && n >= 1 && n <= 16) setNumCourts(n);
              }}
              style={{
                width: 60,
                padding: "6px 8px",
                border: "1px solid #e2e2e2",
                borderRadius: 6,
                fontSize: 13,
                fontFamily: "inherit",
              }}
            />
          </label>
        </div>
      </div>

      <div
        className="tcm-courts-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
          gap: 16,
        }}
      >
        {courts.map((court) => {
          const assigned = courtAssignments.get(court) ?? null;
          const suggestion = suggestionByCourt.get(court) ?? null;
          // Stage labels — only meaningful for playoff matches; null
          // for round-robin so the card doesn't show a badge during
          // pool play.
          const assignedStageLabel = assigned
            ? playoffStageLabel(assigned, matches, event)
            : null;
          const suggestionStageLabel = suggestion
            ? playoffStageLabel(suggestion, matches, event)
            : null;
          return (
            <CourtCard
              key={`${court}:${assigned?.id ?? "empty"}`}
              court={court}
              assigned={assigned}
              assignedStageLabel={assignedStageLabel}
              suggestion={suggestion}
              suggestionStageLabel={suggestionStageLabel}
              teamByAnyRegId={teamByAnyRegId}
              onLoad={(matchId) => onLoad(matchId, court)}
              onCancel={onCancel}
              onSubmitScore={onSubmitScore}
              pickerOptions={eligibleRanked
                .filter(
                  ({ match }) =>
                    match.id !== suggestion?.id &&
                    !Array.from(suggestionByCourt.values()).some(
                      (m) => m.id === match.id,
                    ),
                )
                .map(({ match }) => match)}
            />
          );
        })}
      </div>

      <section>
        <h2 style={{ margin: "0 0 12px", fontSize: 14, color: "#555" }}>
          Up next
        </h2>
        {upNext.length === 0 ? (
          <Empty>
            {pendingCount === 0
              ? "All matches are done."
              : "No more matches can start until current courts free up."}
          </Empty>
        ) : (
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
                <th style={thStyle}>Team A</th>
                <th style={thStyle}>Team B</th>
                <th style={thStyle}>Last played</th>
              </tr>
            </thead>
            <tbody>
              {upNext.map(({ match, score }, i) => {
                const teamA = match.team_a_reg_id
                  ? teamByAnyRegId.get(match.team_a_reg_id)
                  : null;
                const teamB = match.team_b_reg_id
                  ? teamByAnyRegId.get(match.team_b_reg_id)
                  : null;
                return (
                  <tr
                    key={match.id}
                    style={{ borderBottom: "1px solid #f3f4f6" }}
                  >
                    <td style={{ ...tdStyle, color: "#888" }}>{i + 1}</td>
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
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Court card
// ─────────────────────────────────────────────────────────────────────

function CourtCard({
  court,
  assigned,
  assignedStageLabel,
  suggestion,
  suggestionStageLabel,
  teamByAnyRegId,
  pickerOptions,
  onLoad,
  onCancel,
  onSubmitScore,
}: {
  court: string;
  assigned: Match | null;
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
  // Local state resets cleanly when assigned changes because the parent
  // keys this card by `${court}:${assigned?.id ?? "empty"}` — different
  // assignment ⇒ full remount.

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
        <CardHeader court={court} status="In progress" statusColor="#166534" />
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

  // Empty court
  return (
    <div style={cardStyle("#fafafa")}>
      <CardHeader court={court} status="Empty" statusColor="#888" />
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
  court,
  status,
  statusColor,
}: {
  court: string;
  status: string;
  statusColor: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 12,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{court}</h3>
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

function relativeMinutes(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

// ─────────────────────────────────────────────────────────────────────
// UI bits + styles
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

const teamNameStyle: CSSProperties = {
  fontWeight: 500,
};

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
