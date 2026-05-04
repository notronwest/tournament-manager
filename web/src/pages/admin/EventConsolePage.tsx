import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { eligibilityChips } from "../../lib/eligibility";
import { autoTransitionEventStatus } from "../../lib/eventStatus";
import { feedForwardPlayoffWinners } from "../../lib/playoffFeedForward";
import type { Database } from "../../types/supabase";

type Event = Database["public"]["Tables"]["events"]["Row"];
type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];
type EventRegistration =
  Database["public"]["Tables"]["event_registrations"]["Row"];
type Match = Database["public"]["Tables"]["matches"]["Row"];

type Team = {
  // Captain reg id is the canonical id we use in matches. For doubles it
  // is one of the pair (lowest UUID, deterministic). For singles it's
  // just the one reg.
  captainRegId: string;
  partnerRegId: string | null;
  captain: Player;
  partner: Player | null;
  label: string;
  registeredAt: string;
  poolIndex: number | null;
  seed: number | null;
};

type Standing = {
  team: Team;
  wins: number;
  losses: number;
  pf: number;
  pa: number;
  diff: number;
};

// Single-page console for running an event:
//   1. Add teams (creates players + paired event_registrations)
//   2. Generate round-robin matches (n choose 2 pairings)
//   3. Enter scores; standings update live
//   4. Once RR is complete, set up a single-elim playoff bracket
//      (top 2 = final only; top 4 = semis + final)
//
// "Bare-bones" scope per the request — we skip Stripe, status changes,
// court scheduling (round = 1, position = sequence), partner invites,
// and seed editing. Doubles teams are entered with both player names
// directly by the organizer.
export default function EventConsolePage() {
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

  const reload = useCallback(async () => {
    if (!org || !tournamentSlug || !eventId) return;
    setLoading(true);
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
        .is("deleted_at", null)
        .order("registered_at", { ascending: true }),
      supabase
        .from("matches")
        .select("*")
        .eq("event_id", eventId)
        .order("stage", { ascending: true })
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

  const teams = useMemo(() => buildTeams(regs, players), [regs, players]);
  const teamByCaptainId = useMemo(
    () => new Map(teams.map((t) => [t.captainRegId, t])),
    [teams],
  );
  const teamByAnyRegId = useMemo(() => {
    const m = new Map<string, Team>();
    for (const t of teams) {
      m.set(t.captainRegId, t);
      if (t.partnerRegId) m.set(t.partnerRegId, t);
    }
    return m;
  }, [teams]);

  const rrMatches = useMemo(
    () => matches.filter((m) => m.stage === "round_robin"),
    [matches],
  );
  const playoffMatches = useMemo(
    () => matches.filter((m) => m.stage === "playoff"),
    [matches],
  );
  const standings = useMemo(
    () => computeStandings(teams, rrMatches),
    [teams, rrMatches],
  );

  const rrComplete =
    rrMatches.length > 0 && rrMatches.every((m) => m.status === "completed");

  if (!org) return null;
  if (loading) return <div style={{ color: "#666", fontSize: 14 }}>Loading…</div>;
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
  if (!event || !tournament) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <div>
        <Link
          to={`/admin/${org.slug}/tournaments/${tournament.slug}`}
          style={{ color: "#2563eb", textDecoration: "none", fontSize: 13 }}
        >
          ← {tournament.name}
        </Link>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "end",
            gap: 16,
            marginTop: 12,
          }}
        >
          <div>
            <h1 style={{ margin: "0 0 4px", fontSize: 22 }}>{event.name}</h1>
            <p style={{ color: "#666", margin: 0, fontSize: 13 }}>
              {capitalize(event.format)} · {capitalize(event.gender)} ·{" "}
              {event.points_to_win} win by {event.win_by}
              {event.pool_count > 1 ? ` · ${event.pool_count} pools` : ""}
              {event.play_each_team_times > 1
                ? ` · play ${event.play_each_team_times}×`
                : ""}
              {event.teams_advancing_to_playoff > 0
                ? ` · top ${event.teams_advancing_to_playoff} (${event.playoff_rounds} round${event.playoff_rounds === 1 ? "" : "s"})`
                : " · no playoff"}
              {event.max_teams ? ` · max ${event.max_teams} teams` : ""}
            </p>
            {eligibilityChips(event).length > 0 && (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 4,
                  marginTop: 6,
                }}
              >
                {eligibilityChips(event).map((c) => (
                  <span
                    key={c}
                    style={{
                      padding: "2px 8px",
                      background: "#eff6ff",
                      color: "#1e40af",
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 500,
                    }}
                  >
                    {c}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link
              to={`/admin/${org.slug}/tournaments/${tournament.slug}/events/${event.id}/edit`}
              style={{
                padding: "8px 16px",
                background: "#fff",
                color: "#555",
                textDecoration: "none",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                border: "1px solid #e2e2e2",
                whiteSpace: "nowrap",
              }}
            >
              Edit format
            </Link>
            {rrMatches.length > 0 && (
              <Link
                to={`/admin/${org.slug}/tournaments/${tournament.slug}/events/${event.id}/scorecards`}
                style={{
                  padding: "8px 16px",
                  background: "#fff",
                  color: "#2563eb",
                  textDecoration: "none",
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  border: "1px solid #2563eb",
                  whiteSpace: "nowrap",
                }}
              >
                Print scorecards
              </Link>
            )}
          </div>
        </div>
      </div>

      <TeamsSection
        event={event}
        teams={teams}
        canDelete={matches.length === 0}
        onChange={reload}
      />

      <RoundRobinSection
        event={event}
        teams={teams}
        matches={rrMatches}
        teamByAnyRegId={teamByAnyRegId}
        onChange={reload}
      />

      <StandingsSection event={event} standings={standings} />

      <PlayoffSection
        event={event}
        standings={standings}
        teamByAnyRegId={teamByAnyRegId}
        teamByCaptainId={teamByCaptainId}
        playoffMatches={playoffMatches}
        rrComplete={rrComplete}
        onChange={reload}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Teams
// ─────────────────────────────────────────────────────────────────────

function TeamsSection({
  event,
  teams,
  canDelete,
  onChange,
}: {
  event: Event;
  teams: Team[];
  canDelete: boolean;
  onChange: () => Promise<void>;
}) {
  const isDoubles = event.format === "doubles";
  const [aFirst, setAFirst] = useState("");
  const [aLast, setALast] = useState("");
  const [bFirst, setBFirst] = useState("");
  const [bLast, setBLast] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAdd = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!aFirst.trim() || !aLast.trim()) {
      setError("Player A first and last name are required.");
      return;
    }
    if (isDoubles && (!bFirst.trim() || !bLast.trim())) {
      setError("Player B first and last name are required.");
      return;
    }
    setBusy(true);

    const { data: playerA, error: pAErr } = await supabase
      .from("players")
      .insert({
        first_name: aFirst.trim(),
        last_name: aLast.trim(),
      })
      .select()
      .single();
    if (pAErr || !playerA) {
      setError(pAErr?.message ?? "Failed to create player A.");
      setBusy(false);
      return;
    }

    let playerB: Player | null = null;
    if (isDoubles) {
      const res = await supabase
        .from("players")
        .insert({
          first_name: bFirst.trim(),
          last_name: bLast.trim(),
        })
        .select()
        .single();
      if (res.error || !res.data) {
        setError(res.error?.message ?? "Failed to create player B.");
        setBusy(false);
        return;
      }
      playerB = res.data;
    }

    const { data: regA, error: rAErr } = await supabase
      .from("event_registrations")
      .insert({
        event_id: event.id,
        player_id: playerA.id,
        event_fee_cents: 0,
        status: "paid",
        partner_status: isDoubles ? "confirmed" : "solo",
      })
      .select()
      .single();
    if (rAErr || !regA) {
      setError(rAErr?.message ?? "Failed to register player A.");
      setBusy(false);
      return;
    }

    if (isDoubles && playerB) {
      const { data: regB, error: rBErr } = await supabase
        .from("event_registrations")
        .insert({
          event_id: event.id,
          player_id: playerB.id,
          event_fee_cents: 0,
          status: "paid",
          partner_status: "confirmed",
          partner_registration_id: regA.id,
        })
        .select()
        .single();
      if (rBErr || !regB) {
        setError(rBErr?.message ?? "Failed to register player B.");
        setBusy(false);
        return;
      }
      const { error: updErr } = await supabase
        .from("event_registrations")
        .update({ partner_registration_id: regB.id })
        .eq("id", regA.id);
      if (updErr) {
        setError(updErr.message);
        setBusy(false);
        return;
      }
    }

    setAFirst("");
    setALast("");
    setBFirst("");
    setBLast("");
    setBusy(false);
    await onChange();
  };

  const onDelete = async (team: Team) => {
    if (!canDelete) return;
    const ids = [team.captainRegId];
    if (team.partnerRegId) ids.push(team.partnerRegId);
    // First null out the partner FK to avoid FK ordering issues, then delete.
    await supabase
      .from("event_registrations")
      .update({ partner_registration_id: null })
      .in("id", ids);
    const { error: delErr } = await supabase
      .from("event_registrations")
      .delete()
      .in("id", ids);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await onChange();
  };

  const onSetPool = async (team: Team, poolIndex: number | null) => {
    setError(null);
    const ids = [team.captainRegId];
    if (team.partnerRegId) ids.push(team.partnerRegId);
    const { error: updErr } = await supabase
      .from("event_registrations")
      .update({ pool_index: poolIndex })
      .in("id", ids);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    await onChange();
  };

  // Drag-and-drop reordering for seeding. We track the row being
  // dragged and the row currently hovered so the table can render a
  // drop indicator. After drop, every team's seed is rewritten to
  // match its new position (1..N) — keeps seeds tidy and means a
  // freshly-added team naturally lands at the bottom unseeded until
  // dragged into rank.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const persistOrder = async (ordered: Team[]) => {
    setBusy(true);
    setError(null);
    for (let i = 0; i < ordered.length; i++) {
      const t = ordered[i];
      const ids = [t.captainRegId];
      if (t.partnerRegId) ids.push(t.partnerRegId);
      const { error: updErr } = await supabase
        .from("event_registrations")
        .update({ seed: i + 1 })
        .in("id", ids);
      if (updErr) {
        setError(updErr.message);
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    await onChange();
  };

  const onDrop = async (toIdx: number) => {
    const fromIdx = dragIdx;
    setDragIdx(null);
    setOverIdx(null);
    if (fromIdx === null || fromIdx === toIdx) return;
    const reordered = teams.slice();
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    await persistOrder(reordered);
  };

  // Snake-draft pool assignment from current seeds: seed 1 → A, 2 → B,
  // 3 → B, 4 → A, 5 → A, 6 → B, … Unseeded teams sort last and slot
  // into whichever side of the snake they fall on. Run sequentially
  // since each request mutates two rows on the same row-set.
  const onDistributeToPools = async () => {
    setError(null);
    if (event.pool_count < 2) return;
    setBusy(true);
    const sorted = teams
      .slice()
      .sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9));
    for (let i = 0; i < sorted.length; i++) {
      const round = Math.floor(i / event.pool_count);
      const within = i % event.pool_count;
      const idx = round % 2 === 0 ? within : event.pool_count - 1 - within;
      const team = sorted[i];
      const ids = [team.captainRegId];
      if (team.partnerRegId) ids.push(team.partnerRegId);
      const { error: updErr } = await supabase
        .from("event_registrations")
        .update({ pool_index: idx + 1 })
        .in("id", ids);
      if (updErr) {
        setError(updErr.message);
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    await onChange();
  };

  const showPoolColumn = event.pool_count > 1;
  const showSeedColumn = event.pool_count > 1;

  return (
    <section>
      <SectionHeader
        title={`Teams (${teams.length}${event.max_teams ? ` / ${event.max_teams}` : ""})`}
        right={
          showPoolColumn ? (
            <button
              onClick={onDistributeToPools}
              disabled={busy || teams.length === 0}
              style={tinyPrimaryBtn}
              title="Snake-draft teams into pools using the current seeded order."
            >
              Distribute to pools
            </button>
          ) : null
        }
      />

      <form
        onSubmit={onAdd}
        style={{
          display: "grid",
          gridTemplateColumns: isDoubles ? "1fr 1fr 1fr 1fr auto" : "1fr 1fr auto",
          gap: 8,
          alignItems: "end",
          marginBottom: 16,
          padding: 12,
          background: "#fafafa",
          border: "1px solid #e5e7eb",
          borderRadius: 6,
        }}
      >
        <Mini label="Player A first">
          <input
            value={aFirst}
            onChange={(e) => setAFirst(e.target.value)}
            style={miniInput}
          />
        </Mini>
        <Mini label="Player A last">
          <input
            value={aLast}
            onChange={(e) => setALast(e.target.value)}
            style={miniInput}
          />
        </Mini>
        {isDoubles && (
          <>
            <Mini label="Player B first">
              <input
                value={bFirst}
                onChange={(e) => setBFirst(e.target.value)}
                style={miniInput}
              />
            </Mini>
            <Mini label="Player B last">
              <input
                value={bLast}
                onChange={(e) => setBLast(e.target.value)}
                style={miniInput}
              />
            </Mini>
          </>
        )}
        <button type="submit" disabled={busy} style={primaryBtn(busy)}>
          {busy ? "Adding…" : "Add team"}
        </button>
      </form>

      {error && <ErrorBox message={error} />}

      {teams.length === 0 ? (
        <Empty>No teams yet — add one above.</Empty>
      ) : (
        <>
          {showSeedColumn && (
            <p
              style={{
                margin: "0 0 8px",
                fontSize: 12,
                color: "#888",
              }}
            >
              Drag rows to rank teams. Seeds are saved automatically and
              power "Distribute to pools".
            </p>
          )}
          <table style={tableStyle}>
            <thead>
              <tr style={tableHeadRow}>
                {showSeedColumn && (
                  <th style={{ ...thStyle, width: 36 }} aria-label="Drag" />
                )}
                <th style={{ ...thStyle, width: 40 }}>#</th>
                <th style={thStyle}>Team</th>
                {showPoolColumn && (
                  <th style={{ ...thStyle, width: 110 }}>Pool</th>
                )}
                {canDelete && <th style={{ ...thStyle, width: 80 }} />}
              </tr>
            </thead>
            <tbody>
              {teams.map((team, i) => {
                const isDragged = dragIdx === i;
                const isOver = overIdx === i && dragIdx !== null && dragIdx !== i;
                const dropAbove = isOver && (dragIdx ?? -1) > i;
                const dropBelow = isOver && (dragIdx ?? -1) < i;
                return (
                  <tr
                    key={team.captainRegId}
                    draggable={showSeedColumn}
                    onDragStart={(e) => {
                      if (!showSeedColumn) return;
                      setDragIdx(i);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => {
                      if (!showSeedColumn || dragIdx === null) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (overIdx !== i) setOverIdx(i);
                    }}
                    onDragLeave={() => {
                      if (overIdx === i) setOverIdx(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      void onDrop(i);
                    }}
                    onDragEnd={() => {
                      setDragIdx(null);
                      setOverIdx(null);
                    }}
                    style={{
                      ...tableRow,
                      opacity: isDragged ? 0.4 : 1,
                      borderTop: dropAbove
                        ? "2px solid #2563eb"
                        : tableRow.borderTop,
                      borderBottom: dropBelow
                        ? "2px solid #2563eb"
                        : tableRow.borderBottom,
                      cursor: showSeedColumn ? "grab" : undefined,
                    }}
                  >
                    {showSeedColumn && (
                      <td
                        style={{
                          ...tdStyle,
                          color: "#9ca3af",
                          textAlign: "center",
                          userSelect: "none",
                          fontSize: 16,
                          letterSpacing: -2,
                        }}
                        title="Drag to rank"
                        aria-hidden="true"
                      >
                        ⋮⋮
                      </td>
                    )}
                    <td style={{ ...tdStyle, color: "#888" }}>{i + 1}</td>
                    <td style={{ ...tdStyle, fontWeight: 500 }}>{team.label}</td>
                    {showPoolColumn && (
                      <td style={tdStyle}>
                        <select
                          value={team.poolIndex ?? ""}
                          onChange={(e) =>
                            onSetPool(
                              team,
                              e.target.value === ""
                                ? null
                                : parseInt(e.target.value, 10),
                            )
                          }
                          // Native drag on a parent <tr> would otherwise
                          // start a row-drag the moment the user starts
                          // adjusting this control on touch.
                          onMouseDown={(e) => e.stopPropagation()}
                          style={{
                            padding: "4px 6px",
                            border: "1px solid #e2e2e2",
                            borderRadius: 4,
                            fontSize: 12,
                            fontFamily: "inherit",
                            background: "#fff",
                          }}
                        >
                          <option value="">—</option>
                          {Array.from(
                            { length: event.pool_count },
                            (_, idx) => idx + 1,
                          ).map((p) => (
                            <option key={p} value={p}>
                              Pool {poolLetter(p)}
                            </option>
                          ))}
                        </select>
                      </td>
                    )}
                    {canDelete && (
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        <button
                          onClick={() => onDelete(team)}
                          onMouseDown={(e) => e.stopPropagation()}
                          style={tinyDangerBtn}
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

// Pool labels are A, B, C, … in the UI for organizer familiarity, but
// we store the 1-based numeric index in the DB.
function poolLetter(index: number): string {
  return String.fromCharCode("A".charCodeAt(0) + index - 1);
}

// ─────────────────────────────────────────────────────────────────────
// Round Robin
// ─────────────────────────────────────────────────────────────────────

function RoundRobinSection({
  event,
  teams,
  matches,
  teamByAnyRegId,
  onChange,
}: {
  event: Event;
  teams: Team[];
  matches: Match[];
  teamByAnyRegId: Map<string, Team>;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onGenerate = async () => {
    setError(null);
    if (teams.length < 2) {
      setError("Need at least 2 teams.");
      return;
    }
    if (event.pool_count > 1) {
      const unassigned = teams.filter((t) => t.poolIndex === null);
      if (unassigned.length > 0) {
        setError(
          `Assign every team to a pool first — ${unassigned.length} unassigned.`,
        );
        return;
      }
      // Smallest-pool >= 4 rule: any pool below that and pool play
      // becomes degenerate (1-2 matches per team).
      for (let p = 1; p <= event.pool_count; p++) {
        const inPool = teams.filter((t) => t.poolIndex === p).length;
        if (inPool < 4) {
          setError(
            `Pool ${poolLetter(p)} only has ${inPool} team${inPool === 1 ? "" : "s"} — each pool needs at least 4.`,
          );
          return;
        }
      }
    }
    setBusy(true);
    const rows: Database["public"]["Tables"]["matches"]["Insert"][] = [];
    let position = 0;
    const poolGroups: Team[][] =
      event.pool_count > 1
        ? Array.from({ length: event.pool_count }, (_, idx) =>
            teams.filter((t) => t.poolIndex === idx + 1),
          )
        : [teams];
    // Each pairing is generated once per `play_each_team_times`.
    // Multi-pool: pairings only happen within a single pool. The match
    // doesn't carry a pool_index column — pool membership is derived
    // from either team's event_registration.pool_index at read time.
    for (let rep = 0; rep < event.play_each_team_times; rep++) {
      for (const group of poolGroups) {
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            rows.push({
              event_id: event.id,
              stage: "round_robin",
              round: 1,
              position: position++,
              team_a_reg_id: group[i].captainRegId,
              team_b_reg_id: group[j].captainRegId,
              status: "pending",
            });
          }
        }
      }
    }
    const { error: insErr } = await supabase.from("matches").insert(rows);
    if (insErr) {
      setBusy(false);
      setError(insErr.message);
      return;
    }
    await autoTransitionEventStatus(event.id);
    setBusy(false);
    await onChange();
  };

  const onResetAll = async () => {
    setError(null);
    setBusy(true);
    const { error: delErr } = await supabase
      .from("matches")
      .delete()
      .eq("event_id", event.id)
      .eq("stage", "round_robin");
    if (delErr) {
      setError(delErr.message);
      setBusy(false);
      return;
    }
    // Also clear playoff if it depends on RR results.
    await supabase
      .from("matches")
      .delete()
      .eq("event_id", event.id)
      .eq("stage", "playoff");
    setBusy(false);
    await onChange();
  };

  return (
    <section>
      <SectionHeader
        title={`Round-robin matches (${matches.length})`}
        right={
          matches.length === 0 ? (
            <button onClick={onGenerate} disabled={busy} style={primaryBtn(busy)}>
              {busy ? "Generating…" : "Generate matches"}
            </button>
          ) : (
            <button onClick={onResetAll} disabled={busy} style={tinyDangerBtn}>
              Reset all matches
            </button>
          )
        }
      />

      {error && <ErrorBox message={error} />}

      {matches.length === 0 ? (
        <Empty>
          {teams.length < 2
            ? "Add at least 2 teams to generate matches."
            : "No matches yet. Click “Generate matches” to create the round-robin pairings."}
        </Empty>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={tableHeadRow}>
              <th style={{ ...thStyle, width: 40 }}>#</th>
              <th style={thStyle}>Team A</th>
              <th style={{ ...thStyle, width: 80, textAlign: "center" }}>Score</th>
              <th style={thStyle}>Team B</th>
              <th style={{ ...thStyle, width: 100 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {matches.map((m, i) => (
              <MatchRow
                key={m.id}
                match={m}
                index={i + 1}
                teamByAnyRegId={teamByAnyRegId}
                onSaved={onChange}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Match row (used by both RR and playoff sections)
// ─────────────────────────────────────────────────────────────────────

function MatchRow({
  match,
  index,
  teamByAnyRegId,
  onSaved,
}: {
  match: Match;
  index: number;
  teamByAnyRegId: Map<string, Team>;
  onSaved: () => Promise<void>;
}) {
  const teamA = match.team_a_reg_id
    ? teamByAnyRegId.get(match.team_a_reg_id) ?? null
    : null;
  const teamB = match.team_b_reg_id
    ? teamByAnyRegId.get(match.team_b_reg_id) ?? null
    : null;

  const [scoreA, setScoreA] = useState(
    match.team_a_score === null ? "" : String(match.team_a_score),
  );
  const [scoreB, setScoreB] = useState(
    match.team_b_score === null ? "" : String(match.team_b_score),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canPlay = teamA !== null && teamB !== null;

  const onSave = async () => {
    if (!canPlay) return;
    setErr(null);
    const a = scoreA === "" ? null : parseInt(scoreA, 10);
    const b = scoreB === "" ? null : parseInt(scoreB, 10);
    if (a === null || b === null || Number.isNaN(a) || Number.isNaN(b)) {
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
    const winnerRegId =
      a > b ? match.team_a_reg_id : match.team_b_reg_id;
    const loserRegId =
      a > b ? match.team_b_reg_id : match.team_a_reg_id;
    const { error: updErr } = await supabase
      .from("matches")
      .update({
        team_a_score: a,
        team_b_score: b,
        winner_reg_id: winnerRegId,
        status: "completed",
      })
      .eq("id", match.id);
    if (updErr) {
      setErr(updErr.message);
      setBusy(false);
      return;
    }

    if (winnerRegId) {
      await feedForwardPlayoffWinners(match, winnerRegId, loserRegId);
    }
    await autoTransitionEventStatus(match.event_id);

    setBusy(false);
    await onSaved();
  };

  return (
    <tr style={tableRow}>
      <td style={{ ...tdStyle, color: "#888" }}>{index}</td>
      <td
        style={{
          ...tdStyle,
          fontWeight: match.winner_reg_id === match.team_a_reg_id ? 600 : 400,
          color: teamA ? "#111" : "#999",
        }}
      >
        {teamA?.label ?? "TBD"}
      </td>
      <td
        style={{
          ...tdStyle,
          textAlign: "center",
          whiteSpace: "nowrap",
        }}
      >
        <input
          type="number"
          min="0"
          value={scoreA}
          onChange={(e) => setScoreA(e.target.value)}
          disabled={!canPlay || busy}
          style={scoreInputStyle}
        />
        <span style={{ margin: "0 4px", color: "#999" }}>–</span>
        <input
          type="number"
          min="0"
          value={scoreB}
          onChange={(e) => setScoreB(e.target.value)}
          disabled={!canPlay || busy}
          style={scoreInputStyle}
        />
        <button
          onClick={onSave}
          disabled={!canPlay || busy}
          style={{ ...tinyPrimaryBtn, marginLeft: 8 }}
        >
          {busy ? "…" : "Save"}
        </button>
        {err && (
          <div style={{ color: "#991b1b", fontSize: 11, marginTop: 4 }}>
            {err}
          </div>
        )}
      </td>
      <td
        style={{
          ...tdStyle,
          fontWeight: match.winner_reg_id === match.team_b_reg_id ? 600 : 400,
          color: teamB ? "#111" : "#999",
        }}
      >
        {teamB?.label ?? "TBD"}
      </td>
      <td style={tdStyle}>
        <MatchStatusBadge status={match.status} />
      </td>
    </tr>
  );
}

function MatchStatusBadge({
  status,
}: {
  status: Database["public"]["Enums"]["match_status"];
}) {
  const c =
    status === "completed"
      ? { bg: "#dcfce7", fg: "#166534", label: "Completed" }
      : status === "in_progress"
        ? { bg: "#fef3c7", fg: "#92400e", label: "In progress" }
        : { bg: "#f3f4f6", fg: "#666", label: "Pending" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        background: c.bg,
        color: c.fg,
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 500,
      }}
    >
      {c.label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Standings
// ─────────────────────────────────────────────────────────────────────

function StandingsSection({
  event,
  standings,
}: {
  event: Event;
  standings: Standing[];
}) {
  const multiPool = event.pool_count > 1;
  const grouped = useMemo(() => {
    if (!multiPool) return [{ pool: null as number | null, rows: standings }];
    const map = new Map<number, Standing[]>();
    const unassigned: Standing[] = [];
    for (const s of standings) {
      const p = s.team.poolIndex;
      if (p == null) {
        unassigned.push(s);
        continue;
      }
      const arr = map.get(p) ?? [];
      arr.push(s);
      map.set(p, arr);
    }
    const groups = Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([pool, rows]) => ({ pool: pool as number | null, rows }));
    if (unassigned.length > 0) {
      groups.push({ pool: null, rows: unassigned });
    }
    return groups;
  }, [standings, multiPool]);

  return (
    <section>
      <SectionHeader title="Standings" />
      {standings.length === 0 ? (
        <Empty>Standings will appear once matches are scored.</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {grouped.map((g, gi) => (
            <div key={g.pool ?? `unassigned-${gi}`}>
              {multiPool && (
                <h3
                  style={{
                    fontSize: 12,
                    color: "#888",
                    margin: "0 0 6px",
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  {g.pool == null ? "Unassigned" : `Pool ${poolLetter(g.pool)}`}
                </h3>
              )}
              <table style={tableStyle}>
                <thead>
                  <tr style={tableHeadRow}>
                    <th style={{ ...thStyle, width: 40 }}>#</th>
                    <th style={thStyle}>Team</th>
                    <th style={{ ...thStyle, width: 60, textAlign: "right" }}>W</th>
                    <th style={{ ...thStyle, width: 60, textAlign: "right" }}>L</th>
                    <th style={{ ...thStyle, width: 70, textAlign: "right" }}>PF</th>
                    <th style={{ ...thStyle, width: 70, textAlign: "right" }}>PA</th>
                    <th style={{ ...thStyle, width: 70, textAlign: "right" }}>Diff</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((s, i) => (
                    <tr key={s.team.captainRegId} style={tableRow}>
                      <td style={{ ...tdStyle, color: "#888" }}>{i + 1}</td>
                      <td style={{ ...tdStyle, fontWeight: 500 }}>
                        {s.team.label}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>{s.wins}</td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        {s.losses}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right", color: "#666" }}>
                        {s.pf}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right", color: "#666" }}>
                        {s.pa}
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          textAlign: "right",
                          color:
                            s.diff > 0
                              ? "#166534"
                              : s.diff < 0
                                ? "#991b1b"
                                : "#666",
                        }}
                      >
                        {s.diff > 0 ? `+${s.diff}` : s.diff}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Playoff
// ─────────────────────────────────────────────────────────────────────

function PlayoffSection({
  event,
  standings,
  teamByAnyRegId,
  teamByCaptainId,
  playoffMatches,
  rrComplete,
  onChange,
}: {
  event: Event;
  standings: Standing[];
  teamByAnyRegId: Map<string, Team>;
  teamByCaptainId: Map<string, Team>;
  playoffMatches: Match[];
  rrComplete: boolean;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const N = event.teams_advancing_to_playoff;
  const R = event.playoff_rounds;

  const onGenerate = async () => {
    setError(null);
    if (N === 0) {
      setError(
        "Top-N teams advancing is set to 0 — edit the event to enable a playoff.",
      );
      return;
    }
    const top = standings.slice(0, N).map((s) => s.team);
    if (top.length < N) {
      setError(`Need at least ${N} teams in the standings.`);
      return;
    }
    if (R === 1 && N % 2 !== 0) {
      setError("Single-round playoffs need an even Top-N.");
      return;
    }
    if (R === 2 && N !== 4) {
      setError("2-round playoffs (semis + final + bronze) support Top-4 only.");
      return;
    }

    setBusy(true);
    const rows: Database["public"]["Tables"]["matches"]["Insert"][] = [];

    if (R === 1) {
      // Pairwise medal matches: (seed1 v seed2), (seed3 v seed4), …
      // Each pair plays directly for that medal slot — no feed-forward.
      for (let i = 0; i < N; i += 2) {
        rows.push({
          event_id: event.id,
          stage: "playoff",
          round: 1,
          position: i / 2,
          team_a_reg_id: top[i].captainRegId,
          team_b_reg_id: top[i + 1].captainRegId,
          status: "pending",
        });
      }
    } else {
      // R=2, N=4: two semis (1v4, 2v3) → gold final + bronze game.
      rows.push({
        event_id: event.id,
        stage: "playoff",
        round: 1,
        position: 0,
        team_a_reg_id: top[0].captainRegId,
        team_b_reg_id: top[3].captainRegId,
        status: "pending",
      });
      rows.push({
        event_id: event.id,
        stage: "playoff",
        round: 1,
        position: 1,
        team_a_reg_id: top[1].captainRegId,
        team_b_reg_id: top[2].captainRegId,
        status: "pending",
      });
      // Round 2 gold + bronze placeholders. team slots are populated
      // via feedForwardPlayoffWinners as the semis complete.
      rows.push({
        event_id: event.id,
        stage: "playoff",
        round: 2,
        position: 0,
        team_a_reg_id: null,
        team_b_reg_id: null,
        status: "pending",
      });
      rows.push({
        event_id: event.id,
        stage: "playoff",
        round: 2,
        position: 1,
        team_a_reg_id: null,
        team_b_reg_id: null,
        status: "pending",
      });
    }

    const { error: insErr } = await supabase.from("matches").insert(rows);
    if (insErr) {
      setBusy(false);
      setError(insErr.message);
      return;
    }
    await autoTransitionEventStatus(event.id);
    setBusy(false);
    await onChange();
  };

  const onReset = async () => {
    setError(null);
    setBusy(true);
    const { error: delErr } = await supabase
      .from("matches")
      .delete()
      .eq("event_id", event.id)
      .eq("stage", "playoff");
    setBusy(false);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await onChange();
  };

  // Group playoff matches by round for display.
  const byRound = useMemo(() => {
    const m = new Map<number, Match[]>();
    for (const x of playoffMatches) {
      const arr = m.get(x.round) ?? [];
      arr.push(x);
      m.set(x.round, arr);
    }
    for (const [, arr] of m) arr.sort((a, b) => a.position - b.position);
    return m;
  }, [playoffMatches]);

  // Champion = winner of the gold-final match. That's round 1 position 0
  // for pairwise (R=1) brackets, or round 2 position 0 for 2-round
  // brackets with bronze. Either way it's at round=event.playoff_rounds,
  // position=0.
  const championRegId = useMemo(() => {
    const goldFinal = playoffMatches.find(
      (m) => m.round === R && m.position === 0,
    );
    return goldFinal?.status === "completed"
      ? (goldFinal.winner_reg_id ?? null)
      : null;
  }, [playoffMatches, R]);

  const champion = championRegId ? teamByCaptainId.get(championRegId) : null;

  return (
    <section>
      <SectionHeader
        title="Playoff"
        right={
          playoffMatches.length > 0 ? (
            <button onClick={onReset} disabled={busy} style={tinyDangerBtn}>
              Reset playoff
            </button>
          ) : null
        }
      />

      {error && <ErrorBox message={error} />}

      {playoffMatches.length === 0 ? (
        !rrComplete ? (
          <Empty>
            Finish all round-robin matches first, then come back to set up the
            playoff bracket.
          </Empty>
        ) : N === 0 ? (
          <Empty>
            This event has no playoff configured. Edit the event format if you
            want to add one.
          </Empty>
        ) : (
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              padding: 12,
              background: "#fafafa",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              flexWrap: "wrap",
            }}
          >
            <div style={{ fontSize: 13, color: "#444" }}>
              Top {N},{" "}
              {R === 1
                ? "1 round (pairwise medal matches)"
                : "2 rounds (semis + final + bronze)"}
            </div>
            <button onClick={onGenerate} disabled={busy} style={primaryBtn(busy)}>
              {busy ? "Generating…" : "Generate playoff bracket"}
            </button>
          </div>
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {Array.from(byRound.entries())
            .sort(([a], [b]) => a - b)
            .map(([round, ms]) => (
              <div key={round}>
                <h3
                  style={{
                    fontSize: 13,
                    color: "#888",
                    margin: "0 0 8px",
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  {playoffRoundLabel(round, R, ms.length)}
                </h3>
                <table style={tableStyle}>
                  <thead>
                    <tr style={tableHeadRow}>
                      <th style={{ ...thStyle, width: 40 }}>#</th>
                      <th style={thStyle}>Team A</th>
                      <th
                        style={{
                          ...thStyle,
                          width: 80,
                          textAlign: "center",
                        }}
                      >
                        Score
                      </th>
                      <th style={thStyle}>Team B</th>
                      <th style={{ ...thStyle, width: 100 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ms.map((m, i) => (
                      <MatchRow
                        key={m.id}
                        match={m}
                        index={i + 1}
                        teamByAnyRegId={teamByAnyRegId}
                        onSaved={onChange}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          {champion && (
            <div
              style={{
                padding: 16,
                background: "#fef3c7",
                border: "1px solid #fcd34d",
                borderRadius: 6,
                color: "#7a5d00",
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              🏆 Champion: {champion.label}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function playoffRoundLabel(
  round: number,
  totalRounds: number,
  matchesInRound: number,
): string {
  // Pairwise medal round (R=1): single round of 1v2 / 3v4 / etc.
  if (totalRounds === 1) return "Medal matches";
  // 2-round bracket (R=2, N=4): semis, then final + bronze.
  if (totalRounds === 2) {
    if (round === 1) return "Semifinals";
    if (round === 2) return "Final + bronze";
  }
  // Generic fallback.
  if (matchesInRound === 1) return "Final";
  if (matchesInRound === 2) return "Semifinals";
  if (matchesInRound === 4) return "Quarterfinals";
  return `Round ${round}`;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function buildTeams(regs: EventRegistration[], players: Player[]): Team[] {
  const playerById = new Map(players.map((p) => [p.id, p]));
  const regById = new Map(regs.map((r) => [r.id, r]));

  const teams: Team[] = [];
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
        // Pick the lower-id reg as the captain so the choice is stable.
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
    const partner = partnerReg
      ? (playerById.get(partnerReg.player_id) ?? null)
      : null;

    teams.push({
      captainRegId: captainReg.id,
      partnerRegId: partnerReg?.id ?? null,
      captain,
      partner,
      registeredAt: captainReg.registered_at,
      // Captain's pool wins ties — the partner-link insert sequence
      // copies it onto the partner row anyway.
      poolIndex: captainReg.pool_index ?? partnerReg?.pool_index ?? null,
      seed: captainReg.seed ?? partnerReg?.seed ?? null,
      label: partner
        ? `${captain.first_name} ${captain.last_name} / ${partner.first_name} ${partner.last_name}`
        : `${captain.first_name} ${captain.last_name}`,
    });
  }

  // Sort by seed (ascending, unseeded last), then registration order so
  // the rank column reads top-to-bottom.
  teams.sort((a, b) => {
    const sa = a.seed ?? Number.POSITIVE_INFINITY;
    const sb = b.seed ?? Number.POSITIVE_INFINITY;
    if (sa !== sb) return sa - sb;
    return a.registeredAt.localeCompare(b.registeredAt);
  });
  return teams;
}

function computeStandings(teams: Team[], rrMatches: Match[]): Standing[] {
  const byCap = new Map<string, Standing>();
  for (const t of teams) {
    byCap.set(t.captainRegId, {
      team: t,
      wins: 0,
      losses: 0,
      pf: 0,
      pa: 0,
      diff: 0,
    });
  }

  for (const m of rrMatches) {
    if (m.status !== "completed") continue;
    if (
      m.team_a_reg_id === null ||
      m.team_b_reg_id === null ||
      m.team_a_score === null ||
      m.team_b_score === null
    ) {
      continue;
    }
    const a = byCap.get(m.team_a_reg_id);
    const b = byCap.get(m.team_b_reg_id);
    if (!a || !b) continue;
    a.pf += m.team_a_score;
    a.pa += m.team_b_score;
    b.pf += m.team_b_score;
    b.pa += m.team_a_score;
    if (m.winner_reg_id === m.team_a_reg_id) {
      a.wins++;
      b.losses++;
    } else if (m.winner_reg_id === m.team_b_reg_id) {
      b.wins++;
      a.losses++;
    }
  }

  const standings = Array.from(byCap.values());
  for (const s of standings) s.diff = s.pf - s.pa;
  standings.sort(
    (x, y) => y.wins - x.wins || y.diff - x.diff || y.pf - x.pf,
  );
  return standings;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─────────────────────────────────────────────────────────────────────
// Tiny shared UI bits
// ─────────────────────────────────────────────────────────────────────

function SectionHeader({
  title,
  right,
}: {
  title: string;
  right?: ReactNode;
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
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
      {right}
    </div>
  );
}

function Mini({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12,
        color: "#666",
      }}
    >
      {label}
      {children}
    </label>
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
        marginBottom: 12,
      }}
    >
      {message}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 14,
};

const tableHeadRow: CSSProperties = {
  background: "#fafafa",
  borderBottom: "1px solid #e5e7eb",
};

const tableRow: CSSProperties = {
  borderBottom: "1px solid #f3f4f6",
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
  padding: "10px 12px",
};

const miniInput: CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 13,
  fontFamily: "inherit",
};

const scoreInputStyle: CSSProperties = {
  width: 50,
  padding: "4px 6px",
  border: "1px solid #e2e2e2",
  borderRadius: 4,
  fontSize: 13,
  fontFamily: "inherit",
  textAlign: "center",
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

const tinyPrimaryBtn: CSSProperties = {
  padding: "4px 10px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};

const tinyDangerBtn: CSSProperties = {
  padding: "4px 10px",
  background: "#fff",
  color: "#991b1b",
  border: "1px solid #fecaca",
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};
