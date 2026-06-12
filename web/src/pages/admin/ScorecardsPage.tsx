import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { matchLabel, playoffStageLabel } from "../../lib/matchLabel";
import type { Database } from "../../types/supabase";
import {
  inkSoft,
  inkMuted,
  bg,
  rule,
  ruleSoft,
  courtBlue,
  courtRed,
  dangerBg,
  dangerFg,
  bodyFontStack,
} from "../../lib/publicTheme";

type Event = Database["public"]["Tables"]["events"]["Row"];
type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];
type EventRegistration =
  Database["public"]["Tables"]["event_registrations"]["Row"];
type Match = Database["public"]["Tables"]["matches"]["Row"];

type Team = {
  captainRegId: string;
  partnerRegId: string | null;
  player1: string;
  player2: string | null;
};

// Printable scorecards: one card per match, three cards per US-Letter
// page. Layout matches the standard pickleball scorecard (1 game to 11
// win by 2, top half = team 1, bottom half = team 2, score box +
// initials box on each team's row, time-out boxes alongside).
//
// The page renders identically on screen and on paper — clicking the
// Print button just opens the OS dialog. Sidebar + back-link are hidden
// at print time via the global `.no-print` rule in index.css and the
// `.admin-sidebar` rule already in place there.
export default function ScorecardsPage() {
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
  const [stageFilter, setStageFilter] = useState<"all" | "round_robin" | "playoff">(
    "all",
  );
  const [statusFilter, setStatusFilter] = useState<"all" | "unfinished">(
    "unfinished",
  );

  const reload = useCallback(async () => {
    if (!org || !tournamentSlug || !eventId) return;
    // Don't flip loading=true on subsequent reloads — that flashes the
    // skeleton over the scorecards every time you save a score. Initial
    // useState(true) covers the first paint.
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

  const teamByAnyRegId = useMemo(
    () => buildTeamLookup(regs, players),
    [regs, players],
  );

  const visibleMatches = useMemo(() => {
    return matches
      .filter((m) => stageFilter === "all" || m.stage === stageFilter)
      .filter((m) =>
        statusFilter === "all" ? true : m.status !== "completed",
      );
  }, [matches, stageFilter, statusFilter]);

  if (!org) return null;
  if (loading)
    return (
      <div style={{ color: inkMuted, fontSize: 14, fontFamily: bodyFontStack }}>
        Loading…
      </div>
    );
  if (error) {
    return (
      <div
        style={{
          padding: 12,
          background: dangerBg,
          border: `1px solid ${courtRed}`,
          borderRadius: 6,
          color: dangerFg,
          fontSize: 13,
          fontFamily: bodyFontStack,
        }}
      >
        {error}
      </div>
    );
  }
  if (!event || !tournament) return null;

  return (
    <div className="scorecards-page">
      <style>{printCss}</style>

      <div className="no-print" style={toolbarStyle}>
        <Link
          to={`/admin/${org.slug}/tournaments/${tournament.slug}/events/${event.id}`}
          style={{ color: courtBlue, textDecoration: "none", fontSize: 13 }}
        >
          ← {event.name}
        </Link>
        <div style={{ flex: 1 }} />
        <label style={filterLabel}>
          Stage:
          <select
            value={stageFilter}
            onChange={(e) =>
              setStageFilter(e.target.value as typeof stageFilter)
            }
            style={selectStyle}
          >
            <option value="all">All</option>
            <option value="round_robin">Round-robin</option>
            <option value="playoff">Playoff</option>
          </select>
        </label>
        <label style={filterLabel}>
          Status:
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as typeof statusFilter)
            }
            style={selectStyle}
          >
            <option value="unfinished">Pending + in progress</option>
            <option value="all">All</option>
          </select>
        </label>
        <button onClick={() => window.print()} style={printBtn}>
          Print {visibleMatches.length}{" "}
          {visibleMatches.length === 1 ? "scorecard" : "scorecards"}
        </button>
      </div>

      <div className="scorecard-sheet">
        {visibleMatches.length === 0 ? (
          <div
            className="no-print"
            style={{
              padding: 32,
              textAlign: "center",
              background: bg,
              border: `1px dashed ${rule}`,
              borderRadius: 6,
              color: inkMuted,
              fontSize: 13,
            }}
          >
            No matches match the current filters.
          </div>
        ) : (
          visibleMatches.map((m) => (
            <Scorecard
              key={m.id}
              match={m}
              // Prefer the verbose playoff label ("Gold Medal Match",
              // "Bronze Medal Game") which knows about the event's
              // playoff_rounds + teams_advancing_to_playoff config.
              // Falls back to the compact label for round-robin
              // matches and any playoff config the verbose helper
              // doesn't have a name for.
              matchLabel={
                playoffStageLabel(m, matches, event) ??
                matchLabel(m, matches)
              }
              teamA={
                m.team_a_reg_id ? teamByAnyRegId.get(m.team_a_reg_id) : null
              }
              teamB={
                m.team_b_reg_id ? teamByAnyRegId.get(m.team_b_reg_id) : null
              }
              // Per-match config wins when set (playoff matches get
              // their format/points/win-by copied from event.medal_*
              // at generation time, then can be edited per-match in
              // the playoff section). Event-level values are used as
              // the fallback for round-robin matches and for any
              // playoff match that hasn't been customised.
              pointsToWin={m.match_points_to_win ?? event.points_to_win}
              winBy={m.match_win_by ?? event.win_by}
              format={m.match_format ?? "single_game"}
              timeoutsPerGame={event.timeouts_per_game}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Single scorecard
// ─────────────────────────────────────────────────────────────────────

function Scorecard({
  matchLabel,
  teamA,
  teamB,
  pointsToWin,
  winBy,
  format,
  timeoutsPerGame,
}: {
  match: Match;
  matchLabel: string;
  teamA: Team | null | undefined;
  teamB: Team | null | undefined;
  pointsToWin: number;
  winBy: number;
  // "single_game" prints one score column; "best_of_3" prints the
  // rule line as "Best of 3 …" but the score grid is still a single
  // column. Multi-column game-by-game capture is a follow-up;
  // organizers running best-of-3 today can scribble G2 / G3 scores
  // alongside G1 in the same box.
  format: "single_game" | "best_of_3";
  timeoutsPerGame: number;
}) {
  return (
    <div className="scorecard">
      <div className="scorecard-cut" aria-hidden="true" />

      <div className="scorecard-meta">
        <div>
          <strong>Match:</strong> {matchLabel}
        </div>
        <div>
          <strong>Court:</strong>
          <span className="scorecard-blank" />
        </div>
      </div>

      <div className="scorecard-rule-label">
        <strong>
          {format === "best_of_3" ? "Best of 3" : "1 game"} to{" "}
          {pointsToWin} win by {winBy}
        </strong>
        <div className="scorecard-rule-headers">
          {/* "G:1" column header removed — the bold rule above
              already says one game. "Initials" stays so the
              referee column reads correctly. */}
          <span className="scorecard-col-label" aria-hidden="true" />
          <span className="scorecard-col-label">Initials</span>
        </div>
      </div>

      <TeamRow team={teamA} />
      <TimeoutRow timeouts={timeoutsPerGame} />

      <div className="scorecard-team-divider" aria-hidden="true" />

      <TeamRow team={teamB} />
      <TimeoutRow timeouts={timeoutsPerGame} />
    </div>
  );
}

function TeamRow({ team }: { team: Team | null | undefined }) {
  return (
    <div className="scorecard-team-row">
      <div className="scorecard-team-name">
        {team ? (
          team.player2 ? (
            <>
              <span>{team.player1}</span>
              <span className="scorecard-slash"> / </span>
              <span>{team.player2}</span>
            </>
          ) : (
            <span>{team.player1}</span>
          )
        ) : (
          <span className="scorecard-blank-line">—</span>
        )}
      </div>
      <div className="scorecard-box scorecard-score-box" />
      <div className="scorecard-box scorecard-initials-box" />
    </div>
  );
}

function TimeoutRow({ timeouts }: { timeouts: number }) {
  if (timeouts === 0) {
    return (
      <div className="scorecard-timeout-row">
        <span style={{ color: inkMuted, fontStyle: "italic" }}>No time-outs</span>
      </div>
    );
  }
  return (
    <div className="scorecard-timeout-row">
      <span>1 minute per time-out</span>
      {Array.from({ length: timeouts }, (_, i) => (
        <span key={i} className="scorecard-timeout-box">
          {i + 1}
        </span>
      ))}
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
    const team: Team = {
      captainRegId: captainReg.id,
      partnerRegId: partnerReg?.id ?? null,
      player1: `${captain.first_name} ${captain.last_name}`,
      player2: partner ? `${partner.first_name} ${partner.last_name}` : null,
    };
    lookup.set(captainReg.id, team);
    if (partnerReg) lookup.set(partnerReg.id, team);
  }
  return lookup;
}

// ─────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────

const toolbarStyle = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginBottom: 24,
  flexWrap: "wrap" as const,
};

const filterLabel = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
  color: inkSoft,
  fontFamily: bodyFontStack,
};

const selectStyle = {
  padding: "6px 10px",
  border: `1px solid ${rule}`,
  borderRadius: 6,
  fontSize: 13,
  fontFamily: bodyFontStack,
  background: "#fff",
};

const printBtn = {
  padding: "8px 16px",
  background: courtBlue,
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: bodyFontStack,
};

// All scorecard styling lives in this one CSS string so the print rules
// can use page-break / @page selectors. Inline styles can't carry @page.
const printCss = `
  @page {
    size: letter;
    margin: 0.5in;
  }

  .scorecard-sheet {
    max-width: 7.5in;
    margin: 0 auto;
    background: #fff;
  }

  .scorecard {
    position: relative;
    padding: 0.25in 0.25in 0.5in;
    box-sizing: border-box;
    page-break-inside: avoid;
    /* No bottom border by default — the next card's .scorecard-cut
       (2px dashed top) is the cut line between adjacent cards. Used
       to also draw a 2px solid bottom here, which stacked next to
       the dashed top of the following card and produced a fat
       double line in print. Only the last card on the page closes
       with a solid bottom (rule below). */
    height: 3.25in;
    display: flex;
    flex-direction: column;
    color: #000;
    font-family: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  }

  .scorecard:last-child {
    border-bottom: 2px solid #000;
  }

  /* Cut line at the top of each card. */
  .scorecard-cut {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    border-top: 2px dashed #000;
  }

  .scorecard-meta {
    display: flex;
    gap: 1.5in;
    font-size: 14px;
    margin-bottom: 0.18in;
  }
  .scorecard-meta strong {
    font-weight: 700;
  }
  .scorecard-blank {
    display: inline-block;
    border-bottom: 1px solid #000;
    min-width: 1.5in;
    margin-left: 8px;
    height: 1em;
  }

  .scorecard-rule-label {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    font-size: 14px;
    margin-bottom: 4px;
  }
  .scorecard-rule-headers {
    display: flex;
    gap: 0.6in;
    align-items: flex-end;
  }
  .scorecard-col-label {
    font-size: 13px;
    width: 0.7in;
    text-align: center;
  }

  .scorecard-team-row {
    display: flex;
    align-items: center;
    gap: 0.3in;
    flex: 1;
  }
  .scorecard-team-name {
    flex: 1;
    font-size: 14px;
    border-bottom: 1px solid #000;
    padding-bottom: 4px;
    text-align: center;
  }
  .scorecard-slash {
    margin: 0 12px;
    color: #000;
  }
  .scorecard-blank-line {
    color: #999;
  }

  .scorecard-box {
    border: 1px solid #000;
    box-sizing: border-box;
  }
  .scorecard-score-box {
    width: 0.7in;
    height: 0.5in;
  }
  .scorecard-initials-box {
    width: 0.7in;
    height: 0.5in;
  }

  .scorecard-timeout-row {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #000;
    padding: 4px 0;
  }
  .scorecard-timeout-box {
    border: 1px solid #000;
    padding: 2px 6px;
    font-size: 12px;
    line-height: 1;
  }

  .scorecard-team-divider {
    border-top: 1px dashed #999;
    margin: 4px 0;
  }

  /* Three cards per page when printing. The inline screen view also
     stacks them vertically — the height + page-break-inside handles
     pagination. */
  @media print {
    .scorecards-page {
      background: #fff;
    }
    /* :last-child rule above already provides the closing solid
       bottom; no need to redraw it here (was the source of the
       double-line stacking with .scorecard-cut). */
  }

  /* Lighten the visual weight on screen so the page doesn't look like
     a wall of black ink. Print keeps it crisp. */
  @media screen {
    .scorecard {
      margin: 16px auto;
      max-width: 7.5in;
      border: 1px solid ${rule};
      background: #fff;
    }
    .scorecard:last-child {
      border-bottom: 2px solid #000;
    }
    .scorecard-cut {
      border-top-color: ${inkMuted};
    }
    .scorecard-team-divider {
      border-top-color: ${ruleSoft};
    }
  }
`;
