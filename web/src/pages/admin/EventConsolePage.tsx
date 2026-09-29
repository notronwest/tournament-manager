import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { SPOT_HOLDING_STATUSES } from "../../lib/registrationStatus";
import {
  buildTeams,
  computeMedals,
  computeStandings,
  type Medal,
  type Team,
  type Standing,
} from "../../lib/bracketTeams";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { ConfirmModal } from "../../components/ConfirmModal";
import {
  planPoolDistribution,
  poolControlsLocked,
  POOL_LOCK_MESSAGE,
  type PoolPattern,
} from "./poolDistribution";
import {
  PlayerPicker,
  emptySelection,
  persistPlayerSelection,
  type PlayerSelection,
} from "../../components/PlayerPicker";
import { eligibilityChips } from "../../lib/eligibility";
import { estimateCompletion, fmtCompactDuration } from "../../lib/estimator";
import { autoTransitionEventStatus } from "../../lib/eventStatus";
import { resolvePartnerBAction } from "../../lib/teamEdit";
import {
  eventCheckInGate,
  type CheckInReg,
  type CheckInPlayerLite,
} from "../../lib/checkin";
import { feedForwardPlayoffWinners } from "../../lib/playoffFeedForward";
import {
  replaceRoundRobinMatches,
  replacePlayoffMatches,
  buildPlayoffRows,
  clearEventMatches,
  type MatchesWriteClient,
} from "../../lib/matchGeneration";
import { buildDoubleElim, describeSource, type Slot } from "../../lib/doubleElim";
import { resolveScoreRules, validateScore } from "../../lib/scoreValidation";
import { pairRegistrations } from "../../lib/registrations";
import {
  seedTeams,
  divisionFromEvent,
  type SeedableTeam,
  type PlayerRatings,
} from "../../lib/seedTeams";
import { BracketView } from "../../components/BracketView";
import type { SupabaseClient } from "@supabase/supabase-js";
// Double-elimination columns (migration 20260914210000) — generated types lag.
const untyped = supabase as unknown as SupabaseClient;
type DEEvent = { bracket_type?: string | null; double_elim_final?: "crossover" | "bronze_only" | null };
const isDoubleElim = (e: { bracket_type?: string | null } | null | undefined) => e?.bracket_type === "double_elim";
import {
  buildSingleElimBracket,
  bracketRoundsForN,
  playoffRoundName,
} from "../../lib/playoffBracket";
import { downloadCsv } from "../../lib/rosterExport";
import {
  BracketSetupWizard,
  WizardReviewRow,
  type BracketWizardStepView,
} from "./BracketSetupWizard";
import {
  bracketWizardStepGate,
  type BracketWizardContext,
} from "../../lib/bracketWizard";
import {
  standingsToRows,
  resultsToCsv,
  resultsFilename,
} from "../../lib/resultsExport";
import type { Database } from "../../types/supabase";
import { selectPlayoffSeeds, pairPlayoffSeeds } from "../../lib/playoffSeeding";
import {
  ink,
  inkSoft,
  inkMuted,
  bg,
  cream,
  creamDeep,
  rule,
  ruleSoft,
  courtBlue,
  courtRed,
  courtYellow,
  courtGreen,
  successBg,
  successFg,
  dangerBg,
  dangerFg,
  warnBg,
  warnFg,
  bodyFontStack,
  headingFontStack,
} from "../../lib/publicTheme";

type Event = Database["public"]["Tables"]["events"]["Row"];

type TabKey = "settings" | "teams" | "games" | "standings";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Player = Database["public"]["Tables"]["players"]["Row"];
type EventRegistration =
  Database["public"]["Tables"]["event_registrations"]["Row"];
type Match = Database["public"]["Tables"]["matches"]["Row"];

// ── DUPR seeding (#970 / D-0045) ──────────────────────────────────────────
// Console Team rows carry the full player rows on `captain` / `partner`, which
// hold the DUPR + self-rating columns. Adapt them into the shape seedTeams
// wants. The DUPR columns lag the generated Player type (migration
// 20260928120000), so they're read structurally via a cast.
function toSeedableTeams(teams: Team[]): SeedableTeam[] {
  return teams.map((t) => ({
    captainRegId: t.captainRegId,
    partnerRegId: t.partnerRegId,
    captain: t.captain as unknown as PlayerRatings,
    partner: t.partner ? (t.partner as unknown as PlayerRatings) : null,
  }));
}

// Compute DUPR seeds for a division's teams and persist them onto
// event_registrations.seed — both halves of a confirmed doubles pair get the
// pair's single seed. Deterministic + idempotent (re-running on the same data
// yields the same seeds). Returns the seed keyed by captainRegId so a caller
// can order the draw immediately, without waiting for a reload.
async function persistDuprSeeds(
  event: Event,
  teams: Team[],
): Promise<{ seedByCaptain: Map<string, number>; error: string | null }> {
  const division = divisionFromEvent({
    format: event.format,
    gender: event.gender,
    min_rating: event.min_rating,
    // source_division_label rides the PB.com import migration; types lag it.
    source_division_label:
      (event as { source_division_label?: string | null }).source_division_label ?? null,
  });
  const seeded = seedTeams(toSeedableTeams(teams), division);
  const writes = seeded.map((s) => {
    const ids = [s.captainRegId];
    if (s.partnerRegId) ids.push(s.partnerRegId);
    return supabase.from("event_registrations").update({ seed: s.seed }).in("id", ids);
  });
  const results = await Promise.all(writes);
  const firstErr = results.find((r) => r.error)?.error;
  const seedByCaptain = new Map(seeded.map((s) => [s.captainRegId, s.seed]));
  return { seedByCaptain, error: firstErr?.message ?? null };
}

// Sort a copy of `teams` by a freshly-computed seed map (unseeded last). Used
// to order the draw within the same call that persists the seeds, before the
// parent reload re-derives the order from event_registrations.seed.
function orderBySeed(teams: Team[], seedByCaptain: Map<string, number>): Team[] {
  return teams
    .slice()
    .sort(
      (a, b) =>
        (seedByCaptain.get(a.captainRegId) ?? Number.POSITIVE_INFINITY) -
        (seedByCaptain.get(b.captainRegId) ?? Number.POSITIVE_INFINITY),
    );
}

// Team / Standing / Medal and their builders live in lib/bracketTeams so the
// tournament summary report computes results exactly as this console does.
// Re-exported here because resultsExport (and its test) import the types
// from this page.
export type { Medal, Team, Standing } from "../../lib/bracketTeams";

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
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Active tab — driven by ?tab=... so refresh + browser-back keeps
  // the user where they were. "teams" is the default landing tab
  // because that's where most pre-event work happens.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = ((): TabKey => {
    const t = searchParams.get("tab");
    if (t === "settings" || t === "teams" || t === "games" || t === "standings") {
      return t;
    }
    return "teams";
  })();
  const setActiveTab = (t: TabKey) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", t);
    setSearchParams(next, { replace: true });
  };

  const reload = useCallback(async () => {
    if (!org || !tournamentSlug || !eventId) return;
    // Don't flip loading=true on subsequent reloads — that flashes the
    // skeleton over the team list / bracket every time you reorder
    // seeds, distribute pools, or update a score. Initial useState(true)
    // covers the first paint.
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
      // Only spot-holding regs become bracket teams. Without the status
      // filter withdrawn / cancelled / refunded / free-waitlisted rows were
      // all counted ("Teams (15 / 12)" on a 12-team event).
      supabase
        .from("event_registrations")
        .select("*")
        .eq("event_id", eventId)
        .in("status", SPOT_HOLDING_STATUSES)
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

  // Medal podium for the standings tab. Computed from the playoff
  // matches at round=playoff_rounds:
  //   * position 0 = the gold-medal match  → winner=gold, loser=silver
  //   * position 1 = the bronze-medal game → winner=bronze
  // Works for every playoff style — pairwise (R=1), single-elim brackets
  // (Top-4 → R=2, Top-6/8 → R=3), and double-elim — since all of them store
  // the medal matches at the final round. Returns an empty array until the
  // gold match is completed; bronze is added later when its match finishes.
  const medals = useMemo<Medal[]>(
    () => (event ? computeMedals(event as typeof event & DEEvent, playoffMatches, teamByAnyRegId) : []),
    [event, playoffMatches, teamByAnyRegId],
  );

  // Reset all match scores in this event back to 'pending' — clear
  // scores, winner, and court, but keep the schedule intact (don't
  // delete matches the way "Reset all matches" / "Reset playoff" do).
  // For playoff matches in round > 1 we also null the team slots,
  // because those teams were populated by feedForwardPlayoffWinners
  // from upstream winners — replaying earlier rounds will refeed.
  // Exception: bye seeds (e.g. Top-6 seeds 1-2 pre-placed into the
  // semifinals) were seeded at generation, not fed forward, so they
  // must be restored after the blanket null — otherwise replaying the
  // bracket would lose them (see onResetAllScores bye handling below).
  // If the event was complete/verified we also bump it back to
  // active so it re-enters the court manager.
  const onResetAllScores = async () => {
    if (!event) return;
    setResetting(true);
    setError(null);

    // supabase-js returns a thenable PostgrestFilterBuilder, not a
    // strict Promise — Promise.all accepts it but type inference on
    // the array is cleaner than explicitly typing.
    const results = await Promise.all([
      // Score-clearing pass — every match in the event.
      supabase
        .from("matches")
        .update({
          status: "pending",
          team_a_score: null,
          team_b_score: null,
          winner_reg_id: null,
          court: null,
        })
        .eq("event_id", event.id),
      // Team-slot clearing for playoff round > 1 (feed-forward output).
      supabase
        .from("matches")
        .update({ team_a_reg_id: null, team_b_reg_id: null })
        .eq("event_id", event.id)
        .eq("stage", "playoff")
        .gt("round", 1),
    ]);
    const firstErr = results.find((r) => r.error)?.error;
    if (firstErr) {
      setError(firstErr.message);
      setResetting(false);
      return;
    }

    // Restore bye pre-placements the blanket null just wiped. A bye seed sits
    // in a round >= 2 slot from generation (not feed-forward), so the bracket
    // shape tells us exactly which (round, position, slot) to refill, and with
    // whom (the team currently occupying that slot, captured pre-reset).
    const R = event.playoff_rounds;
    if (R >= 2 && bracketRoundsForN(event.teams_advancing_to_playoff) === R) {
      // supabase-js returns thenable PostgrestFilterBuilders, not strict
      // Promises — PromiseLike is what Promise.all actually needs.
      const restores: PromiseLike<unknown>[] = [];
      for (const b of buildSingleElimBracket(event.teams_advancing_to_playoff)) {
        if (b.round < 2) continue;
        const live = playoffMatches.find(
          (m) => m.round === b.round && m.position === b.position,
        );
        if (!live) continue;
        if (b.seedA != null && live.team_a_reg_id) {
          restores.push(
            supabase
              .from("matches")
              .update({ team_a_reg_id: live.team_a_reg_id })
              .eq("id", live.id),
          );
        }
        if (b.seedB != null && live.team_b_reg_id) {
          restores.push(
            supabase
              .from("matches")
              .update({ team_b_reg_id: live.team_b_reg_id })
              .eq("id", live.id),
          );
        }
      }
      const restoreResults = await Promise.all(restores);
      const restoreErr = restoreResults.find(
        (r) => (r as { error?: { message: string } }).error,
      ) as { error?: { message: string } } | undefined;
      if (restoreErr?.error) {
        setError(restoreErr.error.message);
        setResetting(false);
        return;
      }
    }

    // Bump status back if the event had drifted into a finished state.
    if (event.status === "complete" || event.status === "verified") {
      const { error: statusErr } = await supabase
        .from("events")
        .update({ status: "active" })
        .eq("id", event.id);
      if (statusErr) {
        setError(statusErr.message);
        setResetting(false);
        return;
      }
    }

    setResetting(false);
    setResetConfirmOpen(false);
    await reload();
  };

  // ── Bracket Setup wizard (#943) ─────────────────────────────────────
  // A standalone, guided path over the five actions that today live in
  // five different places to start an event's bracket: mark ready →
  // confirm teams → confirm settings → build → start. Every step reuses
  // this page's existing sections / handlers — the wizard consolidates
  // the flow, it doesn't reimplement generation or the start transition.
  const [wizardOpen, setWizardOpen] = useState(false);
  const [markingReady, setMarkingReady] = useState(false);
  const [starting, setStarting] = useState(false);
  // Check-in confirm for the terminal Start step — same gate the Generate
  // handlers use, surfaced when the director starts with players still out.
  const [startGateMissing, setStartGateMissing] = useState<
    { playerId: string; name: string }[] | null
  >(null);

  // Same check-in computation the RoundRobin generate uses — reused here
  // so "Start event" from the wizard honors the identical gate.
  const startCheckInGate = useMemo(() => {
    const playerById = new Map<string, CheckInPlayerLite>(
      players.map((p) => [p.id, p]),
    );
    return eventCheckInGate(regs as unknown as CheckInReg[], playerById);
  }, [regs, players]);

  // Step 1 handler — draft → ready (mirrors the TournamentDetailPage
  // "Mark ready" control; a plain status write, no generation).
  const markReady = async () => {
    if (!event) return;
    setMarkingReady(true);
    setError(null);
    const { error: updErr } = await supabase
      .from("events")
      .update({ status: "ready" })
      .eq("id", event.id);
    setMarkingReady(false);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    await reload();
  };

  // Terminal action — draft/ready → active. Gates the genuine start on
  // check-in (resume/reopen aren't starts), matching setEventStatus on
  // TournamentDetailPage. Games appear in the Court Manager once active.
  const doStart = async () => {
    if (!event) return;
    setStarting(true);
    setError(null);
    const { error: updErr } = await supabase
      .from("events")
      .update({ status: "active" })
      .eq("id", event.id);
    setStarting(false);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    setStartGateMissing(null);
    setWizardOpen(false);
    await reload();
  };

  const startEvent = () => {
    if (
      event &&
      (event.status === "draft" || event.status === "ready") &&
      !startCheckInGate.allCheckedIn
    ) {
      setStartGateMissing(startCheckInGate.missing);
      return;
    }
    void doStart();
  };

  if (!org) return null;
  if (loading) return <div style={{ color: inkMuted, fontSize: 14 }}>Loading…</div>;
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
        }}
      >
        {error}
      </div>
    );
  }
  if (!event || !tournament) return null;

  // ── Wizard wiring (built here so `event`/`teams`/`matches` are live) ──
  const isDoubles = event.format === "doubles";
  const isDE = isDoubleElim(event);
  const unpairedCount = isDoubles
    ? teams.filter((t) => t.partnerRegId === null).length
    : 0;
  const unassignedPoolCount =
    event.pool_count > 1
      ? teams.filter((t) => t.poolIndex === null).length
      : 0;
  const editUrl = `/admin/${org.slug}/tournaments/${tournament.slug}/events/${event.id}/edit`;

  const wizardCtx: BracketWizardContext = {
    status: event.status,
    teamCount: teams.length,
    isDoubles,
    unpairedCount,
    poolCount: event.pool_count,
    unassignedPoolCount,
    matchCount: matches.length,
  };

  const playoffSummary =
    event.teams_advancing_to_playoff > 0
      ? `Top ${event.teams_advancing_to_playoff} · ${event.playoff_rounds} round${event.playoff_rounds === 1 ? "" : "s"}`
      : "No playoff";
  const statusReady =
    event.status !== "draft" ? "Ready to play" : "Draft (not ready yet)";

  const wizardSteps: BracketWizardStepView[] = [
    {
      id: "ready",
      gate: bracketWizardStepGate("ready", wizardCtx),
      content: (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13.5, color: inkSoft, lineHeight: 1.55 }}>
            Marking the event ready locks it as configured and waiting to
            start. It doesn’t generate any games yet.
          </p>
          <div style={{ fontSize: 13, color: inkMuted }}>
            Status: <strong style={{ color: ink }}>{statusReady}</strong>
          </div>
          {event.status === "draft" ? (
            <button
              onClick={() => void markReady()}
              disabled={markingReady || teams.length < 2}
              title={teams.length < 2 ? "Add at least 2 teams first." : undefined}
              style={primaryBtn(markingReady || teams.length < 2)}
            >
              {markingReady ? "Marking…" : "Mark ready"}
            </button>
          ) : (
            <div
              style={{
                padding: "8px 12px",
                background: successBg,
                border: `1px solid ${successFg}`,
                borderRadius: 6,
                color: successFg,
                fontSize: 13,
                alignSelf: "flex-start",
              }}
            >
              ✓ Event is marked ready
            </div>
          )}
        </div>
      ),
    },
    {
      id: "teams",
      gate: bracketWizardStepGate("teams", wizardCtx),
      content: (
        <TeamsSection
          event={event}
          teams={teams}
          hasMatches={matches.length > 0}
          onChange={reload}
        />
      ),
    },
    {
      id: "settings",
      gate: bracketWizardStepGate("settings", wizardCtx),
      content: <SettingsTab event={event} editUrl={editUrl} />,
    },
    {
      id: "build",
      gate: bracketWizardStepGate("build", wizardCtx),
      content: isDE ? (
        <DoubleElimSection
          event={event as typeof event & DEEvent}
          teams={teams}
          teamByAnyRegId={teamByAnyRegId}
          matches={playoffMatches}
          onChange={reload}
        />
      ) : (
        <RoundRobinSection
          event={event}
          teams={teams}
          matches={rrMatches}
          teamByAnyRegId={teamByAnyRegId}
          regs={regs}
          players={players}
          onChange={reload}
        />
      ),
    },
    {
      id: "start",
      gate: bracketWizardStepGate("start", wizardCtx),
      content: (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <p style={{ margin: "0 0 8px", fontSize: 13.5, color: inkSoft, lineHeight: 1.55 }}>
            Review the setup, then start the event. Its games move into the
            Court Manager the moment it goes active.
          </p>
          <WizardReviewRow label="Format" value={`${capitalize(event.format)} · ${event.bracket_type.replace(/_/g, " ")}`} />
          <WizardReviewRow label="Teams" value={String(teams.length)} />
          {event.pool_count > 1 && (
            <WizardReviewRow label="Pools" value={String(event.pool_count)} />
          )}
          <WizardReviewRow label="Playoff" value={playoffSummary} />
          <WizardReviewRow label="Games built" value={String(matches.length)} warn={matches.length === 0} />
          <WizardReviewRow
            label="Checked in"
            value={`${startCheckInGate.checkedIn} / ${startCheckInGate.total}`}
            warn={!startCheckInGate.allCheckedIn && startCheckInGate.total > 0}
          />
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <div>
        <Link
          to={`/admin/${org.slug}/tournaments/${tournament.slug}`}
          className="no-print"
          style={{ color: courtBlue, textDecoration: "none", fontSize: 13 }}
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
            <h1 style={{ margin: "0 0 4px", fontSize: 22, color: ink }}>{event.name}</h1>
            <p style={{ color: inkMuted, margin: 0, fontSize: 13 }}>
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
            {event.scheduled_start_at && (
              <p
                style={{
                  color: inkSoft,
                  fontSize: 13,
                  margin: "4px 0 0",
                  fontWeight: 500,
                }}
              >
                Scheduled: {fmtScheduledRange(event)}
              </p>
            )}
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
                      background: cream,
                      color: inkSoft,
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
            {/* Live completion estimate — shows once games are created
                (READY TO PLAY). Derived from match state: matches still
                to play run up to `court_count` in parallel, each taking
                pool_minutes_per_game. Shrinks as matches finish; no
                polling. Pure math lives in lib/estimator. */}
            {matches.length > 0 &&
              (() => {
                const matchesRemaining = matches.filter(
                  (m) => m.status !== "completed",
                ).length;
                const courts = tournament.court_count;
                const perMatchMinutes = event.pool_minutes_per_game;
                const est = estimateCompletion({
                  matchesRemaining,
                  courts,
                  perMatchMinutes,
                });
                let text: string;
                if (est === null) {
                  text = "Set match length & courts to estimate completion.";
                } else if (matchesRemaining === 0) {
                  text = "All matches complete.";
                } else {
                  text = `Est. ~${fmtCompactDuration(est.minutes)} to complete · ${matchesRemaining} ${matchesRemaining === 1 ? "match" : "matches"} left · ${courts} ${courts === 1 ? "court" : "courts"} · ${perMatchMinutes} min/match`;
                }
                return (
                  <p
                    style={{
                      color: inkSoft,
                      fontSize: 13,
                      margin: "6px 0 0",
                      fontWeight: 500,
                    }}
                  >
                    {text}
                  </p>
                );
              })()}
          </div>
          {/* Edit format moved into the Settings tab below — header
              keeps cross-cutting actions only (Print, Reset). */}
          <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(event.status === "draft" || event.status === "ready") && (
              <button
                onClick={() => setWizardOpen(true)}
                title="Guided setup: mark ready, confirm teams & settings, build the bracket, and start the event."
                style={{
                  padding: "8px 16px",
                  background: ink,
                  color: cream,
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 700,
                  border: "none",
                  cursor: "pointer",
                  fontFamily: headingFontStack,
                  letterSpacing: "0.03em",
                  textTransform: "uppercase",
                  whiteSpace: "nowrap",
                }}
              >
                Set up &amp; start
              </button>
            )}
            {event.is_paired_roles && (
              <Link
                to={`/admin/${org.slug}/tournaments/${tournament.slug}/events/${event.id}/pair-teams`}
                style={{
                  padding: "8px 16px",
                  background: "#ffffff",
                  color: courtBlue,
                  textDecoration: "none",
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  border: `1px solid ${courtBlue}`,
                  whiteSpace: "nowrap",
                }}
              >
                Pair teams
              </Link>
            )}
            {teams.length > 0 && (
              <Link
                to={`/admin/${org.slug}/tournaments/${tournament.slug}/events/${event.id}/pool-sheets`}
                style={{
                  padding: "8px 16px",
                  background: "#ffffff",
                  color: courtBlue,
                  textDecoration: "none",
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  border: `1px solid ${courtBlue}`,
                  whiteSpace: "nowrap",
                }}
              >
                Print pool sheets
              </Link>
            )}
            {matches.length > 0 && (
              <Link
                to={`/admin/${org.slug}/tournaments/${tournament.slug}/events/${event.id}/scorecards`}
                style={{
                  padding: "8px 16px",
                  background: "#ffffff",
                  color: courtBlue,
                  textDecoration: "none",
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  border: `1px solid ${courtBlue}`,
                  whiteSpace: "nowrap",
                }}
              >
                Print scorecards
              </Link>
            )}
            {matches.some((m) => m.status !== "pending") && (
              <button
                onClick={() => setResetConfirmOpen(true)}
                disabled={resetting}
                title="Clear all scores and put every match back to pending. Keeps the schedule intact — won't delete or regenerate the bracket."
                style={{
                  padding: "8px 16px",
                  background: "#ffffff",
                  color: dangerFg,
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  border: `1px solid ${courtRed}`,
                  cursor: resetting ? "not-allowed" : "pointer",
                  fontFamily: bodyFontStack,
                  whiteSpace: "nowrap",
                }}
              >
                {resetting ? "Resetting…" : "Reset all scores"}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="no-print">
        <TabStrip active={activeTab} onChange={setActiveTab} />
      </div>

      {activeTab === "settings" && (
        <SettingsTab
          event={event}
          editUrl={`/admin/${org.slug}/tournaments/${tournament.slug}/events/${event.id}/edit`}
        />
      )}

      {activeTab === "teams" && (
        <TeamsSection
          event={event}
          teams={teams}
          hasMatches={matches.length > 0}
          onChange={reload}
        />
      )}

      {activeTab === "games" && isDoubleElim(event) && (
        <DoubleElimSection
          event={event as typeof event & DEEvent}
          teams={teams}
          teamByAnyRegId={teamByAnyRegId}
          matches={playoffMatches}
          onChange={reload}
        />
      )}
      {activeTab === "games" && !isDoubleElim(event) && (
        <>
          <RoundRobinSection
            event={event}
            teams={teams}
            matches={rrMatches}
            teamByAnyRegId={teamByAnyRegId}
            regs={regs}
            players={players}
            onChange={reload}
          />
          <PlayoffSection
            event={event}
            standings={standings}
            teamByAnyRegId={teamByAnyRegId}
            teamByCaptainId={teamByCaptainId}
            playoffMatches={playoffMatches}
            rrComplete={rrComplete}
            onChange={reload}
          />
        </>
      )}

      {activeTab === "standings" && (
        <StandingsSection
          event={event}
          tournamentName={tournament?.name ?? ""}
          standings={standings}
          medals={medals}
        />
      )}

      {wizardOpen && (
        <BracketSetupWizard
          eventName={event.name}
          steps={wizardSteps}
          onClose={() => setWizardOpen(false)}
          onStart={startEvent}
          starting={starting}
          startDisabledReason={
            matches.length === 0 ? "Build the bracket first." : null
          }
        />
      )}
      {startGateMissing && (
        <ConfirmModal
          title="Not everyone is checked in"
          body={
            <div>
              <p style={{ marginTop: 0 }}>
                {startGateMissing.length}{" "}
                {startGateMissing.length === 1 ? "player" : "players"} in this
                event {startGateMissing.length === 1 ? "hasn't" : "haven't"}{" "}
                checked in yet:
              </p>
              <ul
                style={{
                  margin: "0 0 12px",
                  paddingLeft: 20,
                  maxHeight: 200,
                  overflowY: "auto",
                }}
              >
                {startGateMissing.map((m) => (
                  <li key={m.playerId} style={{ fontSize: 13 }}>
                    {m.name}
                  </li>
                ))}
              </ul>
              <p style={{ margin: 0 }}>
                Check them in first, or start anyway if they’ve withdrawn or
                you’re handling it another way.
              </p>
            </div>
          }
          confirmLabel={starting ? "Starting…" : "Start anyway"}
          onCancel={() => setStartGateMissing(null)}
          onConfirm={async () => {
            setStartGateMissing(null);
            await doStart();
          }}
        />
      )}
      {resetConfirmOpen && (
        <ConfirmModal
          title="Reset all scores?"
          body={
            <div>
              Every match in this event will go back to <strong>pending</strong>{" "}
              — scores cleared, courts freed, winners reset. The schedule
              and bracket stay intact; you can replay every match. If the
              event was marked complete, it will return to <strong>active</strong>.
            </div>
          }
          confirmLabel={resetting ? "Resetting…" : "Reset all scores"}
          onCancel={() => setResetConfirmOpen(false)}
          onConfirm={onResetAllScores}
        />
      )}
      {/* Print CSS shared by the Games tab (bracket) and Standings tab
          (results) print buttons — whichever tab is active on screen
          is what prints, chrome (nav/tabs/edit controls) stripped via
          .no-print. Round-robin is excluded from "print bracket" (see
          RoundRobinSection) since its score inputs aren't a clean
          printable bracket. */}
      <style>{`
        .print-score { display: none; }
        @media print {
          .print-score { display: inline; }
          .print-round-block, .print-standings-table { break-inside: avoid; page-break-inside: avoid; }
          .print-round-head { break-after: avoid; page-break-after: avoid; }
          @page { size: letter; margin: 0.5in; }
        }
      `}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Teams
// ─────────────────────────────────────────────────────────────────────

function TeamsSection({
  event,
  teams: serverTeams,
  hasMatches,
  onChange,
}: {
  event: Event;
  teams: Team[];
  hasMatches: boolean;
  onChange: () => Promise<void>;
}) {
  const isDoubles = event.format === "doubles";
  const [selectionA, setSelectionA] = useState<PlayerSelection>(emptySelection);
  const [selectionB, setSelectionB] = useState<PlayerSelection>(emptySelection);
  const [busy, setBusy] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit-team state. Identified by captainRegId since that's stable
  // and unique. Selections are pre-populated with the team's current
  // players in startEdit; alwaysShowContactFields lets organizers
  // correct stored contact info too.
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [editSelA, setEditSelA] = useState<PlayerSelection>(emptySelection);
  const [editSelB, setEditSelB] = useState<PlayerSelection>(emptySelection);

  // Local mirror of the parent's `teams` so a drag-and-drop can update
  // the displayed order *immediately* (optimistic) instead of snapping
  // back while the seed UPDATEs round-trip and the parent reload runs.
  // Synced from the prop whenever the parent refetches — by the time a
  // legitimate refetch lands the optimistic order will already match.
  const [teams, setTeams] = useState<Team[]>(serverTeams);
  useEffect(() => {
    setTeams(serverTeams);
  }, [serverTeams]);

  // Don't allow the same existing player on both sides of a doubles team.
  const excludeForA =
    selectionB.mode === "existing" ? [selectionB.player.id] : [];
  const excludeForB =
    selectionA.mode === "existing" ? [selectionA.player.id] : [];
  const editExcludeForA =
    editSelB.mode === "existing" ? [editSelB.player.id] : [];
  const editExcludeForB =
    editSelA.mode === "existing" ? [editSelA.player.id] : [];

  const onAdd = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (selectionA.mode === "empty") {
      setError("Pick or enter Player A.");
      return;
    }
    if (isDoubles && selectionB.mode === "empty") {
      setError("Pick or enter Player B.");
      return;
    }
    setBusy(true);

    const aRes = await persistPlayerSelection(selectionA);
    if (!aRes.player) {
      setError(aRes.error ?? "Failed to save Player A.");
      setBusy(false);
      return;
    }
    const playerA = aRes.player;

    let playerB: Player | null = null;
    if (isDoubles) {
      const bRes = await persistPlayerSelection(selectionB);
      if (!bRes.player) {
        setError(bRes.error ?? "Failed to save Player B.");
        setBusy(false);
        return;
      }
      playerB = bRes.player;
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

    setSelectionA(emptySelection);
    setSelectionB(emptySelection);
    setBusy(false);
    await onChange();
  };

  // Two-step delete: clicking Remove opens a confirm modal, the
  // modal's onConfirm runs the actual writes. Always available now —
  // mid-event removal (no-shows, dropouts) is a real organizer
  // workflow. The trade-off: deleting a team mid-event means
  // matches that involved them are deleted too. The confirm copy
  // calls that out so it's an informed click.
  const [pendingDelete, setPendingDelete] = useState<Team | null>(null);
  const [deleting, setDeleting] = useState(false);

  const onDelete = (team: Team) => {
    setPendingDelete(team);
  };

  const onConfirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setError(null);
    const ids = [pendingDelete.captainRegId];
    if (pendingDelete.partnerRegId) ids.push(pendingDelete.partnerRegId);

    // Step 1: clear the self-FK on partner_registration_id so the
    // delete doesn't trip on the constraint when both rows of a
    // doubles team go in the same batch.
    await supabase
      .from("event_registrations")
      .update({ partner_registration_id: null })
      .in("id", ids);

    // Step 2: delete every match this team was part of. Without this,
    // the matches FK (`on delete set null`) would leave rows with null
    // team slots — unplayable orphans that pollute standings and the
    // court manager queue. The user explicitly opted in via the
    // confirm modal, so a hard delete of those matches is correct.
    if (hasMatches) {
      const matchDeletes = await Promise.all([
        supabase.from("matches").delete().in("team_a_reg_id", ids),
        supabase.from("matches").delete().in("team_b_reg_id", ids),
      ]);
      const matchErr = matchDeletes.find((r) => r.error)?.error;
      if (matchErr) {
        setError(matchErr.message);
        setDeleting(false);
        return;
      }
    }

    // Step 3: delete the registration rows. We chain `.select("id")`
    // so we can compare the returned rowset to what we expected to
    // delete — without it, RLS-filtered deletes return
    // {error: null, data: []} and look like success. (Bit us once
    // already with a missing DELETE policy; this is the seatbelt.)
    const { data: deleted, error: delErr } = await supabase
      .from("event_registrations")
      .delete()
      .in("id", ids)
      .select("id");

    setDeleting(false);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    if (!deleted || deleted.length < ids.length) {
      setError(
        `Removed ${deleted?.length ?? 0} of ${ids.length} rows. The rest were blocked — usually a row-level-security policy or a foreign-key constraint. Pull the latest migrations and try again.`,
      );
      return;
    }
    setPendingDelete(null);
    await onChange();
  };

  const startEdit = (team: Team) => {
    setError(null);
    setEditingTeamId(team.captainRegId);
    setEditSelA({
      mode: "existing",
      player: team.captain,
      emailDraft: team.captain.email ?? "",
      phoneDraft: team.captain.phone ?? "",
    });
    if (team.partner) {
      setEditSelB({
        mode: "existing",
        player: team.partner,
        emailDraft: team.partner.email ?? "",
        phoneDraft: team.partner.phone ?? "",
      });
    } else {
      setEditSelB(emptySelection);
    }
  };

  const cancelEdit = () => {
    setEditingTeamId(null);
    setEditSelA(emptySelection);
    setEditSelB(emptySelection);
    setError(null);
  };

  // Saves the edit form: persists each player (insert if new / update
  // if drafts differ from stored values) then re-points the team's
  // event_registration rows at whatever player ids resulted. The
  // captain reg keeps its id; only its player_id can change.
  const saveEdit = async () => {
    setError(null);
    const team = teams.find((t) => t.captainRegId === editingTeamId);
    if (!team) return;
    if (editSelA.mode === "empty") {
      setError("Player A is required.");
      return;
    }
    if (isDoubles && editSelB.mode === "empty") {
      setError("Player B is required.");
      return;
    }
    setBusy(true);

    const aRes = await persistPlayerSelection(editSelA);
    if (!aRes.player) {
      setError(aRes.error ?? "Failed to save Player A.");
      setBusy(false);
      return;
    }
    if (aRes.player.id !== team.captain.id) {
      const { error: regErr } = await supabase
        .from("event_registrations")
        .update({ player_id: aRes.player.id })
        .eq("id", team.captainRegId);
      if (regErr) {
        setError(regErr.message);
        setBusy(false);
        return;
      }
    }

    if (isDoubles) {
      const bRes = await persistPlayerSelection(editSelB);
      if (!bRes.player) {
        setError(bRes.error ?? "Failed to save Player B.");
        setBusy(false);
        return;
      }
      const action = resolvePartnerBAction({
        isDoubles,
        partnerRegId: team.partnerRegId,
        currentPartnerPlayerId: team.partner?.id ?? null,
        selectedPlayerBId: bRes.player.id,
      });

      if (action.kind === "update-player") {
        // Existing partner registration -> update player_id (it changed).
        const { error: regErr } = await supabase
          .from("event_registrations")
          .update({ player_id: bRes.player.id })
          .eq("id", action.partnerRegId);
        if (regErr) {
          setError(regErr.message);
          setBusy(false);
          return;
        }
      } else if (action.kind === "create-partner") {
        // No partner yet (solo / partner-seeker) -> create the partner
        // registration and link both directions, mirroring Add Team.
        // Without this branch, adding a Player B to a partnerless team
        // silently no-ops (no write, no error).
        const { data: regB, error: rBErr } = await supabase
          .from("event_registrations")
          .insert({
            event_id: event.id,
            player_id: bRes.player.id,
            event_fee_cents: 0,
            status: "paid",
            partner_status: "confirmed",
            partner_registration_id: team.captainRegId,
          })
          .select()
          .single();
        if (rBErr || !regB) {
          setError(rBErr?.message ?? "Failed to register Player B.");
          setBusy(false);
          return;
        }
        const { error: updErr } = await supabase
          .from("event_registrations")
          .update({
            partner_registration_id: regB.id,
            partner_status: "confirmed",
          })
          .eq("id", team.captainRegId);
        if (updErr) {
          setError(updErr.message);
          setBusy(false);
          return;
        }
      }
    }

    setEditingTeamId(null);
    setEditSelA(emptySelection);
    setEditSelB(emptySelection);
    setBusy(false);
    await onChange();
  };

  const onSetPool = async (team: Team, poolIndex: number | null) => {
    setError(null);
    // Same corruption vector as distributePools: matches reference each team's
    // pool assignment, so moving a team between pools after games exist strands
    // its generated matches. Reset all matches first.
    if (hasMatches) {
      setError(
        "Games are already created — reset all matches before changing a team's pool.",
      );
      return;
    }
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
    setSavingOrder(true);
    setError(null);

    // Parallel UPDATEs — N round-trips become one wall-clock unit, and
    // the optimistic UI doesn't have to wait on a sequential chain
    // before the parent reload settles. Partial-failure semantics are
    // the same as the previous sequential loop (some seeds may persist
    // while others don't); a single transactional RPC would fix that
    // and is worth doing later if reorder errors become a real
    // problem.
    const writes = ordered.map((t, i) => {
      const ids = [t.captainRegId];
      if (t.partnerRegId) ids.push(t.partnerRegId);
      return supabase
        .from("event_registrations")
        .update({ seed: i + 1 })
        .in("id", ids);
    });
    const results = await Promise.all(writes);
    const firstErr = results.find((r) => r.error)?.error;
    if (firstErr) {
      setError(firstErr.message);
      // Revert to server truth so the user sees what actually got
      // saved, not the unsaved optimistic order.
      setTeams(serverTeams);
      setSavingOrder(false);
      return;
    }

    await onChange();
    setSavingOrder(false);
  };

  const onDrop = async (toIdx: number) => {
    const fromIdx = dragIdx;
    setDragIdx(null);
    setOverIdx(null);
    if (fromIdx === null || fromIdx === toIdx) return;
    const reordered = teams.slice();
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    // Optimistic: paint the new order *now*. The persist runs in the
    // background and the parent reload will sync us back to server
    // truth (which should match) when it lands.
    setTeams(reordered);
    await persistOrder(reordered);
  };

  // Pool assignment by seeded order. Two patterns supported; per-row
  // manual overrides are always available via the Pool dropdown.
  //
  //   "alternate" — straight round-robin: 1,2,1,2,1,2 (or 1,2,3,1,2,3
  //                 for 3 pools). Easiest to explain to organizers,
  //                 matches the "first team → pool 1" mental model.
  //
  //   "snake"     — competitive-balance draft: 1,2,2,1,1,2,2,1. Keeps
  //                 the average seed equal across pools, which matters
  //                 when seeds are reliable and you want pool-play
  //                 results that translate fairly to bracket seeding.
  //
  // Unseeded teams sort last (1e9 sentinel) and continue whichever
  // pattern was chosen.
  const distributePools = async (pattern: PoolPattern) => {
    setError(null);
    if (event.pool_count < 2) return;
    // Pools can't be redistributed once games exist — the matches reference
    // these teams and their pool assignment, so re-pooling would corrupt the
    // bracket. Clear matches first (Reset all matches).
    if (hasMatches) {
      setError(
        "Games are already created — reset all matches before redistributing pools.",
      );
      return;
    }
    setBusy(true);
    // planPoolDistribution owns the seeded ordering AND the once-games-exist
    // lock, so it returns an empty plan (no writes) if hasMatches is ever true.
    const plan = planPoolDistribution({
      teams,
      poolCount: event.pool_count,
      pattern,
      hasMatches,
    });

    // Parallel UPDATEs — same pattern as persistOrder. Partial-failure
    // semantics still TODO via a transactional RPC.
    const writes = plan.map(({ ids, poolIndex }) =>
      supabase
        .from("event_registrations")
        .update({ pool_index: poolIndex })
        .in("id", ids),
    );
    const results = await Promise.all(writes);
    const firstErr = results.find((r) => r.error)?.error;
    if (firstErr) {
      setError(firstErr.message);
      setBusy(false);
      return;
    }

    setBusy(false);
    await onChange();
  };

  const showPoolColumn = event.pool_count > 1;
  const isDE = isDoubleElim(event);
  const showSeedColumn = event.pool_count > 1 || isDE;
  // Once games exist, pool assignment (and the seed order it derives from) is
  // frozen — re-pooling would corrupt the generated bracket. This one flag
  // drives every locked pool control plus the inline explanation below.
  const poolsLocked = poolControlsLocked(hasMatches);

  // Double elimination: seeds drive the bracket, so let organizers shuffle
  // them, and pair everyone still solo/seeking at random (hand-built teams
  // are never touched — random fills only the loose players).
  const randomizeSeeds = async () => {
    if (hasMatches || teams.length < 2) return;
    const shuffled = teams.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    setTeams(shuffled);
    await persistOrder(shuffled);
  };

  // Seed the field by combined DUPR (seed 1 = strongest). Persists
  // event_registrations.seed for every team and reorders the list. The
  // round-robin and double-elim generators consume this order directly, so a
  // generated draw is ranked by strength. Organizers can still drag rows to
  // fine-tune afterward (or before generating).
  const [seeding, setSeeding] = useState(false);
  const seedByDupr = async () => {
    if (hasMatches || teams.length < 2) return;
    setError(null);
    setSeeding(true);
    const { seedByCaptain, error: seedErr } = await persistDuprSeeds(event, teams);
    if (seedErr) {
      setError(seedErr);
      setSeeding(false);
      return;
    }
    setTeams(orderBySeed(teams, seedByCaptain)); // optimistic; reload confirms
    await onChange();
    setSeeding(false);
  };
  const [randomizing, setRandomizing] = useState(false);
  const loose = teams.filter((t) => t.partnerRegId === null);
  const randomizeRemaining = async () => {
    if (!isDoubles || hasMatches) return;
    setError(null);
    const pool = loose.slice();
    if (pool.length < 2) { setError("Fewer than two unpaired players — nothing to pair."); return; }
    if (pool.length % 2 === 1) { setError(`${pool.length} unpaired players — add or remove one so everyone gets a partner.`); return; }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    setRandomizing(true);
    try {
      for (let i = 0; i < pool.length; i += 2) {
        await pairRegistrations(pool[i].captainRegId, pool[i + 1].captainRegId);
      }
      await onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRandomizing(false);
    }
  };

  return (
    <section>
      <SectionHeader
        title={`Teams (${teams.length}${event.max_teams ? ` / ${event.max_teams}` : ""})`}
        right={
          <div
            style={{ display: "flex", alignItems: "center", gap: 12 }}
          >
            {savingOrder && (
              <span
                style={{
                  fontSize: 12,
                  color: warnFg,
                  background: warnBg,
                  border: `1px solid ${creamDeep}`,
                  borderRadius: 4,
                  padding: "2px 8px",
                  fontWeight: 500,
                }}
                aria-live="polite"
              >
                Saving order…
              </span>
            )}
            {!hasMatches && teams.length >= 2 && (
              <button
                onClick={() => void seedByDupr()}
                disabled={busy || savingOrder || seeding}
                style={tinySecondaryBtn}
                title="Order every team by combined DUPR (seed 1 = strongest). Falls back to singles DUPR, then self-rating, then the division floor. Drag rows to fine-tune afterward."
              >
                {seeding ? "Seeding…" : "Seed by DUPR"}
              </button>
            )}
            {isDE && (
              <>
                <button
                  onClick={() => void randomizeSeeds()}
                  disabled={busy || savingOrder || hasMatches || teams.length < 2}
                  style={tinySecondaryBtn}
                  title={hasMatches ? "Locked — bracket already generated. Reset it first." : "Shuffle the seed order. Drag rows to fine-tune."}
                >
                  Randomize seeds
                </button>
                {isDoubles && (
                  <button
                    onClick={() => void randomizeRemaining()}
                    disabled={busy || randomizing || hasMatches || loose.length < 2}
                    style={tinyPrimaryBtn}
                    title={loose.length < 2 ? "Everyone already has a partner." : `Pair the ${loose.length} unpaired players at random. Hand-built teams are not touched.`}
                  >
                    {randomizing ? "Pairing…" : `Randomize remaining (${loose.length})`}
                  </button>
                )}
              </>
            )}
            {showPoolColumn && (
              <>
                <button
                  onClick={() => distributePools("alternate")}
                  disabled={
                    busy || savingOrder || teams.length === 0 || poolsLocked
                  }
                  style={tinyPrimaryBtn}
                  title={
                    poolsLocked
                      ? "Locked — games already created. Reset all matches first to redistribute pools."
                      : "Alternate teams across pools by seeded order: seed 1 → pool 1, seed 2 → pool 2, seed 3 → pool 1, etc."
                  }
                >
                  Distribute: alternate
                </button>
                <button
                  onClick={() => distributePools("snake")}
                  disabled={
                    busy || savingOrder || teams.length === 0 || poolsLocked
                  }
                  style={tinySecondaryBtn}
                  title={
                    poolsLocked
                      ? "Locked — games already created. Reset all matches first to redistribute pools."
                      : "Snake-draft teams for competitive balance: 1,2,2,1,1,2,2,1. Keeps the average seed equal across pools."
                  }
                >
                  Snake draft
                </button>
              </>
            )}
          </div>
        }
      />

      <form
        onSubmit={onAdd}
        style={{
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
          marginBottom: 16,
          padding: 12,
          background: bg,
          border: `1px solid ${rule}`,
          borderRadius: 6,
        }}
      >
        <PlayerPicker
          label="Player A"
          selection={selectionA}
          onChange={setSelectionA}
          excludePlayerIds={excludeForA}
        />
        {isDoubles && (
          <PlayerPicker
            label="Player B"
            selection={selectionB}
            onChange={setSelectionB}
            excludePlayerIds={excludeForB}
          />
        )}
        <div style={{ paddingTop: 18 }}>
          <button type="submit" disabled={busy} style={primaryBtn(busy)}>
            {busy ? "Adding…" : "Add team"}
          </button>
        </div>
      </form>

      {error && <ErrorBox message={error} />}

      {poolsLocked && showPoolColumn && (
        <div
          role="note"
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            padding: 12,
            marginBottom: 16,
            background: warnBg,
            border: `1px solid ${courtYellow}`,
            borderRadius: 6,
            color: warnFg,
            fontSize: 13,
            fontWeight: 500,
            lineHeight: 1.4,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 15, lineHeight: 1.3 }}>
            🔒
          </span>
          <span>{POOL_LOCK_MESSAGE}</span>
        </div>
      )}

      {teams.length === 0 ? (
        <Empty>No teams yet — add one above.</Empty>
      ) : (
        <>
          {showSeedColumn && (
            <p
              style={{
                margin: "0 0 8px",
                fontSize: 12,
                color: inkMuted,
              }}
            >
              Drag rows to rank teams. Seeds are saved automatically and
              power "Distribute to pools".
            </p>
          )}
          {(() => {
            const colSpan =
              1 /* # */ +
              1 /* Team */ +
              (showSeedColumn ? 1 : 0) +
              (showPoolColumn ? 1 : 0) +
              1; /* Actions */
            return (
              <table style={tableStyle}>
                <thead>
                  <tr style={tableHeadRow}>
                    {showSeedColumn && (
                      <th
                        style={{ ...thStyle, width: 36 }}
                        aria-label="Drag"
                      />
                    )}
                    <th style={{ ...thStyle, width: 40 }}>#</th>
                    <th style={thStyle}>Team</th>
                    {showPoolColumn && (
                      <th style={{ ...thStyle, width: 110 }}>Pool</th>
                    )}
                    <th style={{ ...thStyle, width: 140 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {teams.map((team, i) => {
                    if (editingTeamId === team.captainRegId) {
                      return (
                        <tr
                          key={team.captainRegId}
                          style={{ ...tableRow, background: bg }}
                        >
                          <td colSpan={colSpan} style={{ padding: 12 }}>
                            <div
                              style={{
                                display: "flex",
                                gap: 12,
                                alignItems: "flex-start",
                                flexWrap: "wrap",
                              }}
                            >
                              <PlayerPicker
                                label="Player A"
                                selection={editSelA}
                                onChange={setEditSelA}
                                excludePlayerIds={editExcludeForA}
                                alwaysShowContactFields
                              />
                              {isDoubles && (
                                <PlayerPicker
                                  label="Player B"
                                  selection={editSelB}
                                  onChange={setEditSelB}
                                  excludePlayerIds={editExcludeForB}
                                  alwaysShowContactFields
                                />
                              )}
                              <div
                                style={{
                                  paddingTop: 18,
                                  display: "flex",
                                  gap: 8,
                                }}
                              >
                                <button
                                  onClick={() => void saveEdit()}
                                  disabled={busy}
                                  style={tinyPrimaryBtn}
                                >
                                  {busy ? "Saving…" : "Save"}
                                </button>
                                <button
                                  onClick={cancelEdit}
                                  disabled={busy}
                                  style={tinySecondaryBtn}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    }

                    const isDragged = dragIdx === i;
                    const isOver =
                      overIdx === i && dragIdx !== null && dragIdx !== i;
                    const dropAbove = isOver && (dragIdx ?? -1) > i;
                    const dropBelow = isOver && (dragIdx ?? -1) < i;
                    return (
                      <tr
                        key={team.captainRegId}
                        draggable={
                          showSeedColumn && editingTeamId === null && !poolsLocked
                        }
                        onDragStart={(e) => {
                          if (
                            !showSeedColumn ||
                            editingTeamId !== null ||
                            poolsLocked
                          )
                            return;
                          setDragIdx(i);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(e) => {
                          if (!showSeedColumn || dragIdx === null || poolsLocked)
                            return;
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
                            ? `2px solid ${courtBlue}`
                            : tableRow.borderTop,
                          borderBottom: dropBelow
                            ? `2px solid ${courtBlue}`
                            : tableRow.borderBottom,
                          cursor:
                            showSeedColumn &&
                            editingTeamId === null &&
                            !poolsLocked
                              ? "grab"
                              : undefined,
                        }}
                      >
                        {showSeedColumn && (
                          <td
                            style={{
                              ...tdStyle,
                              color: inkMuted,
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
                        <td style={{ ...tdStyle, color: inkMuted }}>{i + 1}</td>
                        <td style={{ ...tdStyle, fontWeight: 500 }}>
                          {team.label}
                        </td>
                        {showPoolColumn && (
                          <td style={tdStyle}>
                            <select
                              value={team.poolIndex ?? ""}
                              disabled={poolsLocked}
                              title={
                                poolsLocked
                                  ? "Locked — games already created. Reset all matches first to change pools."
                                  : undefined
                              }
                              onChange={(e) =>
                                onSetPool(
                                  team,
                                  e.target.value === ""
                                    ? null
                                    : parseInt(e.target.value, 10),
                                )
                              }
                              onMouseDown={(e) => e.stopPropagation()}
                              style={{
                                padding: "4px 6px",
                                border: `1px solid ${rule}`,
                                borderRadius: 4,
                                fontSize: 12,
                                fontFamily: bodyFontStack,
                                background: "#ffffff",
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
                        <td style={tdStyle}>
                          <div
                            style={{
                              display: "flex",
                              gap: 6,
                              justifyContent: "flex-end",
                            }}
                          >
                            <button
                              onClick={() => startEdit(team)}
                              onMouseDown={(e) => e.stopPropagation()}
                              disabled={editingTeamId !== null}
                              style={tinySecondaryBtn}
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => onDelete(team)}
                              onMouseDown={(e) => e.stopPropagation()}
                              disabled={editingTeamId !== null}
                              style={tinyDangerBtn}
                            >
                              Remove
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );
          })()}
        </>
      )}

      {pendingDelete && (
        <ConfirmModal
          title={`Remove ${pendingDelete.label}?`}
          body={
            hasMatches ? (
              <div>
                This team has matches in the schedule. Removing them will
                also <strong>delete every match they're part of</strong> —
                pending and completed. Standings and the playoff bracket
                may need to be regenerated. The player records themselves
                stay; only this event's registration is removed.
              </div>
            ) : (
              <div>
                Removes this team's registration from the event. Player
                records stay — they can be re-added later.
              </div>
            )
          }
          confirmLabel={deleting ? "Removing…" : "Remove team"}
          onCancel={() => setPendingDelete(null)}
          onConfirm={onConfirmDelete}
        />
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
  regs,
  players,
  onChange,
}: {
  event: Event;
  teams: Team[];
  matches: Match[];
  teamByAnyRegId: Map<string, Team>;
  regs: EventRegistration[];
  players: Player[];
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronous re-entrancy guard for generate. `busy` disables the button,
  // but its React state update isn't visible until the next render — a
  // double-click (or any second invoke in the same tick) can slip through
  // before that. This ref flips synchronously, so the second call returns
  // immediately. Belt to the delete-then-insert idempotency's suspenders.
  const generatingRef = useRef(false);
  // Check-in gate. Set when Generate is blocked because not every registered
  // player is checked in — holds the missing list for the override confirm.
  const [gateBlocked, setGateBlocked] = useState<{
    missing: { playerId: string; name: string }[];
  } | null>(null);

  const checkInGate = useMemo(() => {
    const playerById = new Map<string, CheckInPlayerLite>(
      players.map((p) => [p.id, p]),
    );
    return eventCheckInGate(regs as unknown as CheckInReg[], playerById);
  }, [regs, players]);

  // The actual generation, once validated and past (or overriding) the gate.
  //
  // Idempotent (bug #993): replaceRoundRobinMatches DELETEs the event's
  // existing round-robin matches — and dependent playoff matches, since a
  // regenerated round robin invalidates the standings the playoff seeded
  // from — before inserting the fresh set. A second generate therefore
  // REPLACES rather than APPENDs. generatingRef makes a concurrent invoke a
  // no-op (busy's state update lags a render); the DB unique index (migration
  // 20260929120000) is the final backstop.
  const doGenerate = async () => {
    if (generatingRef.current) return;
    generatingRef.current = true;
    setBusy(true);
    try {
      // DUPR-seed the field first if it has never been seeded, so the generated
      // draw (schedule order, and — for a single pool — pairing order) reflects
      // team strength. Respect any existing seeds (manual drag / Seed by DUPR /
      // pool distribution / a prior run): only auto-seed when a team is still
      // unseeded. Multi-pool membership is set on the Teams tab before this
      // runs, so this just backfills the seed values there.
      let orderedTeams = teams;
      if (teams.some((t) => t.seed == null)) {
        const { seedByCaptain, error: seedErr } = await persistDuprSeeds(event, teams);
        if (seedErr) {
          setError(seedErr);
          return;
        }
        orderedTeams = orderBySeed(teams, seedByCaptain);
      }
      const { error: insErr } = await replaceRoundRobinMatches(
        supabase as unknown as MatchesWriteClient,
        event,
        orderedTeams,
      );
      if (insErr) {
        setError(insErr.message);
        return;
      }
      await autoTransitionEventStatus(event.id);
      await onChange();
    } finally {
      setBusy(false);
      generatingRef.current = false;
    }
  };

  // Validate, then gate on check-in. Generating matches starts play, so we
  // hard-block it until every registered player in the event is checked in —
  // with an explicit organizer override (e.g. a no-show being withdrawn
  // first) surfaced through the confirm modal.
  const onGenerate = async () => {
    setError(null);
    setGateBlocked(null);
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
    if (!checkInGate.allCheckedIn) {
      setGateBlocked({ missing: checkInGate.missing });
      return;
    }
    await doGenerate();
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
    // Excluded from print — its live score-entry inputs aren't a
    // clean printout, and "print bracket" (PlayoffSection, below)
    // covers what a director needs to hand out or post.
    <section className="no-print">
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
        <div style={matchGridStyle}>
          {matches.map((m, i) => (
            <MatchCard
              key={m.id}
              match={m}
              index={i + 1}
              teamByAnyRegId={teamByAnyRegId}
              event={event}
              onSaved={onChange}
            />
          ))}
        </div>
      )}

      {/* Check-in status hint before matches exist — tells the organizer why
          Generate will prompt, and lets them jump to the desk. */}
      {matches.length === 0 && teams.length >= 2 && !checkInGate.allCheckedIn && (
        <p style={{ fontSize: 12.5, color: warnFg, marginTop: 8 }}>
          {checkInGate.total - checkInGate.checkedIn} of {checkInGate.total}{" "}
          players not checked in yet — generating matches will ask you to
          confirm.
        </p>
      )}

      {gateBlocked && (
        <ConfirmModal
          title="Not everyone is checked in"
          body={
            <div>
              <p style={{ marginTop: 0 }}>
                {gateBlocked.missing.length}{" "}
                {gateBlocked.missing.length === 1 ? "player" : "players"} in this
                event {gateBlocked.missing.length === 1 ? "hasn't" : "haven't"}{" "}
                checked in yet:
              </p>
              <ul style={{ margin: "0 0 12px", paddingLeft: 20, maxHeight: 200, overflowY: "auto" }}>
                {gateBlocked.missing.map((m) => (
                  <li key={m.playerId} style={{ fontSize: 13 }}>{m.name}</li>
                ))}
              </ul>
              <p style={{ margin: 0 }}>
                Check them in from the Check-in screen first, or start anyway if
                they've withdrawn or you're handling it another way.
              </p>
            </div>
          }
          confirmLabel={busy ? "Generating…" : "Start anyway"}
          onCancel={() => setGateBlocked(null)}
          onConfirm={async () => {
            setGateBlocked(null);
            await doGenerate();
          }}
        />
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Match card (used by the RR, playoff, and double-elim sections)
//
// Layout only: a self-contained card that reads well at phone width
// (issue #500 — mobile-first). Teams stack vertically with their score
// input aligned to the right edge (tabular), a status accent runs down
// the left border, and Save sits in its own action row. The score-save
// logic (onSave / validateScore / feed-forward) is unchanged from the
// prior table-row rendering.
// ─────────────────────────────────────────────────────────────────────

function MatchCard({
  match,
  index,
  teamByAnyRegId,
  event,
  onSaved,
}: {
  match: Match;
  index: number;
  teamByAnyRegId: Map<string, Team>;
  event: Event;
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
    if (a === null || b === null) {
      setErr("Both scores required.");
      return;
    }
    // Same rule check as the court cards (reach the target, win by the
    // margin) — round-robin resolves the target from the event, playoff
    // matches from their own row config. No modal here: this is a dense
    // admin grid that also edits/clears finished scores inline.
    const result = validateScore(a, b, resolveScoreRules(match, event));
    if (!result.ok) {
      setErr(result.error);
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

  // Status accent runs down the card's left border so a director can
  // scan pending / live / final at a glance mid-tournament.
  const statusAccent =
    match.status === "completed"
      ? courtGreen
      : match.status === "in_progress"
        ? courtYellow
        : rule;
  const winnerA = match.winner_reg_id === match.team_a_reg_id;
  const winnerB = match.winner_reg_id === match.team_b_reg_id;

  return (
    <div style={{ ...matchCardStyle, borderLeftColor: statusAccent }}>
      <div style={matchCardHeader}>
        <span style={matchNumStyle}>Match {index}</span>
        <MatchStatusBadge status={match.status} />
      </div>

      <div style={matchTeamsBlock}>
        <div style={matchTeamRow}>
          <span
            style={{
              ...matchTeamName,
              fontWeight: winnerA ? 700 : 500,
              color: teamA ? ink : inkMuted,
            }}
          >
            {teamA?.label ?? "TBD"}
          </span>
          <input
            className="no-print"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={scoreA}
            onChange={(e) => setScoreA(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && onSave()}
            disabled={!canPlay || busy}
            style={scoreInputStyle}
            aria-label={`${teamA?.label ?? "Team A"} score`}
          />
          {/* Plain text so a printed bracket shows the finished score
              instead of an empty-looking form control. */}
          <span className="print-score" style={matchPrintScore}>
            {match.team_a_score ?? "–"}
          </span>
        </div>

        <span style={matchVsStyle}>vs</span>

        <div style={matchTeamRow}>
          <span
            style={{
              ...matchTeamName,
              fontWeight: winnerB ? 700 : 500,
              color: teamB ? ink : inkMuted,
            }}
          >
            {teamB?.label ?? "TBD"}
          </span>
          <input
            className="no-print"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={scoreB}
            onChange={(e) => setScoreB(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && onSave()}
            disabled={!canPlay || busy}
            style={scoreInputStyle}
            aria-label={`${teamB?.label ?? "Team B"} score`}
          />
          <span className="print-score" style={matchPrintScore}>
            {match.team_b_score ?? "–"}
          </span>
        </div>
      </div>

      <div className="no-print" style={matchCardActions}>
        {err && <span style={{ color: dangerFg, fontSize: 12 }}>{err}</span>}
        <button
          onClick={onSave}
          disabled={!canPlay || busy}
          style={matchSaveBtn(!canPlay || busy)}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function MatchStatusBadge({
  status,
}: {
  status: Database["public"]["Enums"]["match_status"];
}) {
  const c =
    status === "completed"
      ? { bg: successBg, fg: successFg, label: "Completed" }
      : status === "in_progress"
        ? { bg: warnBg, fg: warnFg, label: "In progress" }
        : { bg: ruleSoft, fg: inkMuted, label: "Pending" };
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
  tournamentName,
  standings,
  medals,
}: {
  event: Event;
  tournamentName: string;
  standings: Standing[];
  medals: Medal[];
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
      <SectionHeader
        title="Standings"
        right={
          standings.length > 0 ? (
            <div className="no-print" style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                style={tinySecondaryBtn}
                onClick={() => {
                  const rows = standingsToRows(standings, medals);
                  downloadCsv(
                    resultsFilename(tournamentName, event.name, new Date()),
                    resultsToCsv(rows),
                  );
                }}
              >
                Export results (CSV)
              </button>
              <button
                type="button"
                onClick={() => window.print()}
                style={tinyPrimaryBtn}
              >
                Print results
              </button>
            </div>
          ) : undefined
        }
      />

      {medals.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
            marginBottom: 24,
          }}
        >
          {medals.map(({ team, place }) => {
            const p = medalPalette(place);
            return (
              <div
                key={place}
                style={{
                  padding: "16px 20px",
                  background: p.bg,
                  border: `1px solid ${p.border}`,
                  borderRadius: 8,
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: p.color,
                    textTransform: "uppercase",
                    letterSpacing: 1.2,
                    fontWeight: 700,
                    marginBottom: 6,
                  }}
                >
                  {p.label}
                </div>
                <div
                  style={{ fontSize: 16, fontWeight: 600, color: ink }}
                >
                  {team.label}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {standings.length === 0 ? (
        <Empty>Standings will appear once matches are scored.</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {grouped.map((g, gi) => (
            <div key={g.pool ?? `unassigned-${gi}`} className="print-standings-table">
              {multiPool && (
                <h3
                  style={{
                    fontSize: 12,
                    color: inkMuted,
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
                      <td style={{ ...tdStyle, color: inkMuted }}>{i + 1}</td>
                      <td style={{ ...tdStyle, fontWeight: 500 }}>
                        {s.team.label}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>{s.wins}</td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        {s.losses}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right", color: inkMuted }}>
                        {s.pf}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right", color: inkMuted }}>
                        {s.pa}
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          textAlign: "right",
                          color:
                            s.diff > 0
                              ? successFg
                              : s.diff < 0
                                ? dangerFg
                                : inkMuted,
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

  // Re-entrancy guard — same rationale as RoundRobinSection.doGenerate:
  // `busy` disables the button but its state update lags a render, so a
  // double-click could double-generate. This ref blocks the second call
  // synchronously.
  const generatingRef = useRef(false);

  const N = event.teams_advancing_to_playoff;
  const R = event.playoff_rounds;
  // playoff_seeding (migration 20260911190000) — generated types lag it.
  const seeding =
    (event as unknown as { playoff_seeding?: "overall" | "cross_pool" }).playoff_seeding ?? "overall";
  const crossPool = seeding === "cross_pool" && event.pool_count === 2 && N === 4 && R === 1;

  const [showPreview, setShowPreview] = useState(false);

  // Preview = exactly what onGenerate will build. Both read the same
  // helpers, so what the organizer confirms is what gets created.
  const previewSeeds = selectPlayoffSeeds(standings, N, crossPool);
  const previewPairs = pairPlayoffSeeds(previewSeeds, R);

  const ordinal = (n: number) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
  };

  // Why this team qualifies: pool finish (cross-pool) or overall rank, + record.
  const seedReason = (s: Standing, seedIdx: number) => {
    const rec = `${s.wins}-${s.losses}, ${s.diff >= 0 ? "+" : ""}${s.diff} pts`;
    if (crossPool) {
      // Seeds arrive [PoolA#1, PoolB#1, PoolA#2, PoolB#2] — 0,1 are pool
      // winners, 2,3 the runners-up. Pool letter comes from the team's
      // 1-indexed pool (1 → A, 2 → B).
      const letter = poolLetter(s.team.poolIndex ?? 0);
      return `${seedIdx < 2 ? "Won" : "Runner-up in"} Pool ${letter} · ${rec}`;
    }
    return `${ordinal(seedIdx + 1)} overall · ${rec}`;
  };

  const pairLabel = (i: number) =>
    R === 1
      ? i === 0
        ? "Gold / Silver match"
        : i === 1
          ? "Bronze / 4th match"
          : `Medal match ${i + 1}`
      : `Semifinal ${i + 1}`;

  const ppLbl: CSSProperties = {
    fontWeight: 700,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: inkMuted,
    margin: "13px 0 5px",
  };
  const ppTh: CSSProperties = {
    padding: "3px 6px",
    fontSize: 10,
    textTransform: "uppercase",
    color: inkMuted,
    borderBottom: `1px solid ${rule}`,
    textAlign: "center",
  };
  const ppTd: CSSProperties = {
    padding: "3px 6px",
    borderBottom: `1px solid ${ruleSoft}`,
    textAlign: "center",
  };

  const onGenerate = async () => {
    if (generatingRef.current) return;
    setError(null);
    if (N === 0) {
      setError(
        "Top-N teams advancing is set to 0 — edit the event to enable a playoff.",
      );
      return;
    }
    if (R === 1 && N % 2 !== 0) {
      setError("Single-round playoffs need an even Top-N.");
      return;
    }
    if (R >= 2 && bracketRoundsForN(N) !== R) {
      const supported = bracketRoundsForN(N);
      setError(
        supported == null
          ? `A single-elimination bracket isn't supported for Top-${N}. Use 1 round (pairwise medal matches), or set Top-4/6/8.`
          : `Top-${N} is a ${supported}-round bracket — set playoff rounds to ${supported} (or 1 for pairwise), not ${R}.`,
      );
      return;
    }
    // Cross-pool seeding reads each pool's placement order, so every team
    // must be assigned to a pool first.
    if (crossPool) {
      const unassigned = standings.filter((s) => s.team.poolIndex == null).length;
      if (unassigned > 0) {
        setError(`${unassigned} team${unassigned === 1 ? " is" : "s are"} not assigned to a pool — assign pools on the Teams tab first.`);
        return;
      }
    }
    // Who advances, in seed order. Shared with the confirm preview
    // (playoffSeeding.selectPlayoffSeeds) so the two can't diverge:
    // overall = top-N of the standings; cross-pool (2 pools, top 4) =
    // [Pool A #1, Pool B #1, Pool A #2, Pool B #2].
    const seeds = selectPlayoffSeeds(standings, N, crossPool);
    if (seeds.length < N) {
      setError(
        crossPool
          ? "Cross-pool seeding needs at least 2 teams in each pool."
          : `Need at least ${N} teams in the standings.`,
      );
      return;
    }
    const top = seeds.map((s) => s.team);

    generatingRef.current = true;
    setBusy(true);
    try {
      // Idempotent (bug #993): replacePlayoffMatches DELETEs the event's
      // existing playoff matches (mirrors "Reset playoff") before inserting
      // the fresh bracket, so a second generate REPLACES rather than APPENDs.
      // Round-robin matches are untouched. buildPlayoffRows owns every
      // playoff shape and copies the event's medal/semifinal config onto each
      // row: R=1 pairwise medal matches, and the single-elimination brackets
      // (Top-4 → 2 rounds, Top-6/8 → 3) whose byes/seeding/bronze routing come
      // from playoffBracket.ts (empty slots filled by feedForwardPlayoffWinners
      // as upstream matches complete). The seeds fed in come from
      // selectPlayoffSeeds — the same helper the confirm preview uses — so what
      // an organizer confirms in the preview is what gets created.
      const rows = buildPlayoffRows(event, top);
      const { error: insErr } = await replacePlayoffMatches(
        supabase as unknown as MatchesWriteClient,
        event.id,
        rows,
      );
      if (insErr) {
        setError(insErr.message);
        return;
      }
      await autoTransitionEventStatus(event.id);
      await onChange();
    } finally {
      setBusy(false);
      generatingRef.current = false;
    }
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
            <div className="no-print" style={{ display: "flex", gap: 8 }}>
              <button onClick={() => window.print()} style={tinyPrimaryBtn}>
                Print bracket
              </button>
              <button onClick={onReset} disabled={busy} style={tinyDangerBtn}>
                Reset playoff
              </button>
            </div>
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
              background: bg,
              border: `1px solid ${rule}`,
              borderRadius: 6,
              flexWrap: "wrap",
            }}
          >
            <div style={{ fontSize: 13, color: inkSoft }}>
              Top {N},{" "}
              {R === 1
                ? crossPool
                  ? "1 round — cross-pool: pool winners for gold, runners-up for bronze"
                  : "1 round (pairwise medal matches)"
                : R === 2
                  ? "2 rounds (semis → final + bronze)"
                  : `${R} rounds (${N === 6 ? "play-in" : "quarterfinals"} → semis → final + bronze)`}
            </div>
            <button
              onClick={() => setShowPreview(true)}
              disabled={busy}
              style={primaryBtn(busy)}
            >
              {busy ? "Generating…" : "Generate playoff bracket"}
            </button>
            {showPreview && (
              <ConfirmModal
                title="Generate playoff bracket?"
                confirmLabel="Generate bracket"
                cancelLabel="Go back"
                destructive={false}
                onCancel={() => setShowPreview(false)}
                onConfirm={async () => {
                  setShowPreview(false);
                  await onGenerate();
                }}
                body={
                  <div
                    style={{
                      fontFamily: bodyFontStack,
                      fontSize: 13,
                      maxWidth: 560,
                    }}
                  >
                    <div style={ppLbl}>Final standings</div>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <th style={ppTh}>#</th>
                          <th style={{ ...ppTh, textAlign: "left" }}>Team</th>
                          <th style={ppTh}>W-L</th>
                          <th style={ppTh}>Diff</th>
                        </tr>
                      </thead>
                      <tbody>
                        {standings.map((s, i) => {
                          const advancing = previewSeeds.includes(s);
                          return (
                            <tr
                              key={s.team.captainRegId}
                              style={
                                advancing ? { background: successBg } : undefined
                              }
                            >
                              <td style={ppTd}>{i + 1}</td>
                              <td
                                style={{
                                  ...ppTd,
                                  textAlign: "left",
                                  fontWeight: advancing ? 700 : 400,
                                }}
                              >
                                {s.team.label}
                                {advancing ? " ✓" : ""}
                              </td>
                              <td style={ppTd}>
                                {s.wins}-{s.losses}
                              </td>
                              <td style={ppTd}>
                                {s.diff >= 0 ? "+" : ""}
                                {s.diff}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>

                    <div style={ppLbl}>
                      Advancing to the playoff ({previewSeeds.length})
                    </div>
                    {previewSeeds.length === 0 ? (
                      <div style={{ color: dangerFg }}>
                        {crossPool
                          ? "Each pool needs at least 2 teams to seed a cross-pool bracket."
                          : "Not enough teams in the standings to seed a bracket."}
                      </div>
                    ) : (
                      <ol style={{ margin: 0, paddingLeft: 20 }}>
                        {previewSeeds.map((s, i) => (
                          <li
                            key={s.team.captainRegId}
                            style={{ marginBottom: 3 }}
                          >
                            <b>{s.team.label}</b> — {seedReason(s, i)}
                          </li>
                        ))}
                      </ol>
                    )}

                    {previewPairs.length > 0 && (
                      <>
                        <div style={ppLbl}>Proposed matchups</div>
                        <ul style={{ margin: 0, paddingLeft: 20 }}>
                          {previewPairs.map(([a, b], i) => (
                            <li key={i} style={{ marginBottom: 3 }}>
                              <span style={{ color: inkMuted }}>
                                {pairLabel(i)}:
                              </span>{" "}
                              <b>
                                #{previewSeeds.indexOf(a) + 1} {a.team.label}
                              </b>{" "}
                              vs{" "}
                              <b>
                                #{previewSeeds.indexOf(b) + 1} {b.team.label}
                              </b>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                }
              />
            )}
          </div>
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {Array.from(byRound.entries())
            .sort(([a], [b]) => a - b)
            .map(([round, ms]) => (
              <div key={round} className="print-round-block">
                <h3
                  className="print-round-head"
                  style={{
                    fontSize: 13,
                    color: inkMuted,
                    margin: "0 0 8px",
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  {playoffRoundLabel(round, R, ms.length)}
                </h3>
                <div style={matchGridStyle}>
                  {ms.map((m, i) => (
                    <MatchCard
                      key={m.id}
                      match={m}
                      index={i + 1}
                      teamByAnyRegId={teamByAnyRegId}
                      event={event}
                      onSaved={onChange}
                    />
                  ))}
                </div>
              </div>
            ))}
          {champion && (
            <div
              style={{
                padding: 16,
                background: warnBg,
                border: `1px solid ${courtYellow}`,
                borderRadius: 6,
                color: warnFg,
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

// ─────────────────────────────────────────────────────────────────────
// Double elimination
// ─────────────────────────────────────────────────────────────────────

type DEMatchRow = Match & {
  bracket?: "winners" | "consolation" | "final" | null;
  slot_key?: string | null;
  label?: string | null;
  if_necessary?: boolean | null;
};

// Seeded winners + consolation brackets generated from lib/doubleElim. Every
// match row stores its bracket, slot key, label and where its winner/loser
// go, so scoring anywhere (console, court managers) feeds forward via
// feedForwardPlayoffWinners' data-driven branch.
function DoubleElimSection({
  event,
  teams,
  teamByAnyRegId,
  matches,
  onChange,
}: {
  event: Event & DEEvent;
  teams: Team[];
  teamByAnyRegId: Map<string, Team>;
  matches: Match[];
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-entrancy guard — see RoundRobinSection.doGenerate. Blocks a
  // double-click before `busy` re-renders the disabled button.
  const generatingRef = useRef(false);
  const format = event.double_elim_final ?? "crossover";
  const isDoubles = event.format === "doubles";
  const rows = matches as DEMatchRow[];

  const seeded = useMemo(() => teams.slice().sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9)), [teams]);
  const unseeded = seeded.filter((t) => t.seed == null).length;
  const unpaired = isDoubles ? teams.filter((t) => t.partnerRegId === null).length : 0;
  const preview = useMemo(() => (teams.length >= 3 ? buildDoubleElim(teams.length, format) : null), [teams.length, format]);

  const onGenerate = async () => {
    if (generatingRef.current) return;
    setError(null);
    if (teams.length < 3) { setError("Double elimination needs at least 3 teams."); return; }
    if (unpaired > 0) { setError(`${unpaired} player${unpaired === 1 ? " is" : "s are"} unpaired — pair them (or Randomize remaining) first.`); return; }
    generatingRef.current = true;
    setBusy(true);
    try {
      // Seeds drive elimination placement (seedOrder puts byes on the top
      // seeds). DUPR-seed the field when it isn't fully seeded yet; respect
      // existing seeds (manual drag / Randomize / Seed by DUPR) otherwise.
      let orderedSeeded = seeded;
      if (unseeded > 0) {
        const { seedByCaptain, error: seedErr } = await persistDuprSeeds(event, teams);
        if (seedErr) throw new Error(seedErr);
        orderedSeeded = orderBySeed(teams, seedByCaptain);
      }
      const de = buildDoubleElim(teams.length, format);
      const regOfSeed = (seed: number) => orderedSeeded[seed - 1]?.captainRegId ?? null;
      const poolConfig = {
        match_format: "single_game" as const,
        match_points_to_win: event.points_to_win,
        match_win_by: event.win_by,
        match_minutes_per_game: event.pool_minutes_per_game,
      };
      const medalConfig = {
        match_format: event.medal_match_format,
        match_points_to_win: event.medal_points_to_win,
        match_win_by: event.medal_win_by,
        match_minutes_per_game: event.medal_minutes_per_game,
      };
      const lastL = Math.max(...de.slots.filter((x) => x.bracket === "consolation").map((x) => x.round));
      const isMedal = (x: Slot) => x.bracket === "final" || (x.bracket === "consolation" && x.round === lastL);
      const inserts = de.slots.map((x) => ({
        event_id: event.id,
        stage: "playoff",
        round: x.round,
        position: x.position,
        bracket: x.bracket,
        slot_key: x.key,
        label: x.label,
        if_necessary: x.ifNecessary,
        team_a_reg_id: x.a.kind === "seed" ? regOfSeed(x.a.seed) : null,
        team_b_reg_id: x.b.kind === "seed" ? regOfSeed(x.b.seed) : null,
        status: "pending",
        ...(isMedal(x) ? medalConfig : poolConfig),
      }));
      // Idempotent (bug #993): a DE event is entirely a playoff bracket, so —
      // mirroring "Reset bracket" (onReset) — clear every existing match in
      // the event before re-inserting. A second generate REPLACES rather than
      // APPENDs. Done after seeding/row-build so a failure there leaves the
      // existing bracket intact.
      const { error: clearErr } = await clearEventMatches(
        untyped as unknown as MatchesWriteClient,
        event.id,
      );
      if (clearErr) throw new Error(clearErr.message);
      const { data: created, error: insErr } = await untyped.from("matches").insert(inserts).select("id, slot_key");
      if (insErr) throw new Error(insErr.message);
      const idBySlot = new Map<string, string>((created as { id: string; slot_key: string }[]).map((r) => [r.slot_key, r.id]));
      // Second pass: wire feeds now that every row has an id.
      const wiring = de.slots
        .filter((x) => x.feedsWinnerTo || x.feedsLoserTo)
        .map((x) =>
          untyped
            .from("matches")
            .update({
              feeds_winner_to: x.feedsWinnerTo ? idBySlot.get(x.feedsWinnerTo.key) ?? null : null,
              feeds_winner_side: x.feedsWinnerTo?.side ?? null,
              feeds_loser_to: x.feedsLoserTo ? idBySlot.get(x.feedsLoserTo.key) ?? null : null,
              feeds_loser_side: x.feedsLoserTo?.side ?? null,
            })
            .eq("id", idBySlot.get(x.key)!),
        );
      const results = await Promise.all(wiring);
      const wErr = results.find((r) => r.error)?.error;
      if (wErr) throw new Error(wErr.message);
      await autoTransitionEventStatus(event.id);
      await onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      generatingRef.current = false;
    }
  };

  const onReset = async () => {
    setError(null);
    setBusy(true);
    const { error: delErr } = await supabase.from("matches").delete().eq("event_id", event.id);
    setBusy(false);
    if (delErr) { setError(delErr.message); return; }
    await onChange();
  };

  // Group by bracket, then round.
  const groups = useMemo(() => {
    const order: Record<string, number> = { winners: 0, consolation: 1, final: 2 };
    const m = new Map<string, { bracket: string; round: number; rows: DEMatchRow[] }>();
    for (const r of rows) {
      const key = `${r.bracket ?? "winners"}:${r.round}`;
      const g = m.get(key) ?? { bracket: r.bracket ?? "winners", round: r.round, rows: [] };
      g.rows.push(r);
      m.set(key, g);
    }
    return Array.from(m.values())
      .map((g) => ({ ...g, rows: g.rows.sort((a, b) => a.position - b.position) }))
      .sort((a, b) => (order[a.bracket] ?? 9) - (order[b.bracket] ?? 9) || a.round - b.round);
  }, [rows]);

  const medals = useMemo(() => computeMedals(event, matches, teamByAnyRegId), [event, matches, teamByAnyRegId]);
  const slotsByKey = useMemo(() => new Map(preview?.slots.map((x) => [x.key, x]) ?? []), [preview]);
  // Bracket picture by default; the table is the score-entry fallback. Clicking
  // a card in the picture opens that one match's row for scoring below it.
  const [view, setView] = useState<"bracket" | "table">("bracket");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const teamLabel = (regId: string) => teamByAnyRegId.get(regId)?.label ?? "TBD";

  return (
    <section>
      <SectionHeader
        title="Double elimination"
        right={
          rows.length > 0 ? (
            <div className="no-print" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ display: "inline-flex", border: `1px solid ${rule}`, borderRadius: 6, overflow: "hidden" }}>
                <button onClick={() => setView("bracket")} style={{ ...tinySecondaryBtn, border: "none", borderRadius: 0, background: view === "bracket" ? courtBlue : "#fff", color: view === "bracket" ? "#fff" : inkSoft }}>Bracket</button>
                <button onClick={() => setView("table")} style={{ ...tinySecondaryBtn, border: "none", borderRadius: 0, borderLeft: `1px solid ${rule}`, background: view === "table" ? courtBlue : "#fff", color: view === "table" ? "#fff" : inkSoft }}>Table</button>
              </div>
              <button onClick={() => window.print()} style={tinyPrimaryBtn}>Print bracket</button>
              <button onClick={onReset} disabled={busy} style={tinyDangerBtn}>Reset bracket</button>
            </div>
          ) : null
        }
      />
      {error && <ErrorBox message={error} />}
      {rows.length === 0 ? (
        <div style={{ display: "flex", gap: 12, alignItems: "center", padding: 12, background: bg, border: `1px solid ${rule}`, borderRadius: 6, flexWrap: "wrap" }}>
          <div style={{ fontSize: 13, color: inkSoft, flex: "1 1 260px" }}>
            {teams.length} seeded teams ·{" "}
            {format === "crossover" ? "crossover final (true double elimination)" : "bronze only (no crossover)"}
            {preview ? ` · ${preview.slots.filter((x) => !x.ifNecessary).length} matches${format === "crossover" ? " + 1 if necessary" : ""}` : ""}
            {unseeded > 0 ? ` · ${unseeded} unseeded (will be DUPR-seeded on generate)` : ""}
            {unpaired > 0 ? ` · ${unpaired} unpaired` : ""}
          </div>
          <button onClick={onGenerate} disabled={busy || teams.length < 3} style={primaryBtn(busy || teams.length < 3)}>
            {busy ? "Generating…" : "Generate bracket"}
          </button>
        </div>
      ) : view === "bracket" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <BracketView matches={rows} labelFor={teamLabel} onSelect={(m) => setSelectedId(m.id)} selectedId={selectedId} />
          {selected && (
            <div style={{ border: `1px solid ${courtBlue}`, borderRadius: 6, padding: 10, background: "#fff" }}>
              <div style={{ fontSize: 12, color: inkMuted, marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
                <span>{selected.label ?? selected.slot_key} — enter the score</span>
                <button onClick={() => setSelectedId(null)} style={tinySecondaryBtn}>Close</button>
              </div>
              <MatchCard key={selected.id} match={selected} index={1} teamByAnyRegId={teamByAnyRegId} event={event} onSaved={onChange} />
            </div>
          )}
          {medals.length > 0 && (
            <div style={{ padding: 16, background: warnBg, border: `1px solid ${courtYellow}`, borderRadius: 6, color: warnFg, fontSize: 14, fontWeight: 500 }}>
              {medals.map((m) => `${m.place === "gold" ? "🥇" : m.place === "silver" ? "🥈" : "🥉"} ${m.team.label}`).join("   ")}
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {groups.map((g) => (
            <div key={`${g.bracket}-${g.round}`} className="print-round-block">
              <h3 className="print-round-head" style={{ fontSize: 13, color: inkMuted, margin: "0 0 8px", textTransform: "uppercase", letterSpacing: 0.5 }}>
                {g.rows[0]?.label && g.rows.length === 1 ? g.rows[0].label : `${g.bracket === "final" ? "Final" : g.bracket === "winners" ? "Winners bracket" : "Consolation bracket"} · round ${g.round}`}
              </h3>
              <div style={matchGridStyle}>
                {g.rows.map((r, i) => (
                  <MatchCard key={r.id} match={r} index={i + 1} teamByAnyRegId={teamByAnyRegId} event={event} onSaved={onChange} />
                ))}
              </div>
              {g.rows.some((r) => !r.team_a_reg_id || !r.team_b_reg_id) && slotsByKey.size > 0 && (
                <div style={{ fontSize: 11, color: inkMuted, marginTop: 4 }}>
                  {g.rows
                    .filter((r) => (!r.team_a_reg_id || !r.team_b_reg_id) && r.slot_key && slotsByKey.get(r.slot_key))
                    .map((r) => {
                      const x = slotsByKey.get(r.slot_key!)!;
                      return `${r.slot_key}: ${describeSource(x.a, slotsByKey)} v ${describeSource(x.b, slotsByKey)}`;
                    })
                    .join(" · ")}
                </div>
              )}
            </div>
          ))}
          {medals.length > 0 && (
            <div style={{ padding: 16, background: warnBg, border: `1px solid ${courtYellow}`, borderRadius: 6, color: warnFg, fontSize: 14, fontWeight: 500 }}>
              {medals.map((m) => `${m.place === "gold" ? "🥇" : m.place === "silver" ? "🥈" : "🥉"} ${m.team.label}`).join("   ")}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// Round heading for the playoff table. Delegates to the shared bracket
// vocabulary so Medal / Play-in / Quarterfinals / Semifinals / Final + bronze
// read the same here, in the scheduler, and on the court manager.
function playoffRoundLabel(
  round: number,
  totalRounds: number,
  matchesInRound: number,
): string {
  return playoffRoundName(round, totalRounds, matchesInRound);
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Render the scheduled window for the event-console header. Uses
// only event-level fields so it works without loading the full
// schedule context (registrations + court allocations).
//
// Caveat: this falls back to "start time only" when the event hasn't
// run pool play yet (we don't know team count yet from this scope).
// The fuller "start–end" version on the homepage event card uses the
// estimator with real team + court counts. Keeping this lighter view
// here so the header doesn't need to re-fetch everything.
function fmtScheduledRange(event: Event): string {
  if (!event.scheduled_start_at) return "";
  const start = new Date(event.scheduled_start_at);
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  return start.toLocaleString(undefined, opts);
}

// Color palette for the medal podium panels at the top of the
// Standings tab. Gold reuses the amber family from design-prefs
// (note-to-self / system-emphasis); silver uses slate; bronze uses
// copper. Same pairings used by playoffStageStyle for the in-card
// stage badges so the visual language is consistent across views.
function medalPalette(place: "gold" | "silver" | "bronze"): {
  bg: string;
  color: string;
  border: string;
  label: string;
} {
  switch (place) {
    case "gold":
      return { bg: warnBg, color: warnFg, border: creamDeep, label: "Gold" };
    case "silver":
      return { bg: bg, color: inkSoft, border: rule, label: "Silver" };
    case "bronze":
      return { bg: dangerBg, color: dangerFg, border: courtRed, label: "Bronze" };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Tiny shared UI bits
// ─────────────────────────────────────────────────────────────────────

// Tab strip rendered between the page header and the per-tab
// content. Active tab keyed by the `tab` URL param so refresh +
// browser back work. Visual: text buttons with a 2px bottom-border
// underline for the active tab — minimal chrome, fits the inline-
// styles aesthetic of the rest of the app.
function TabStrip({
  active,
  onChange,
}: {
  active: TabKey;
  onChange: (t: TabKey) => void;
}) {
  const tabs: { key: TabKey; label: string }[] = [
    { key: "standings", label: "Standings" },
    { key: "teams", label: "Teams" },
    { key: "games", label: "Games" },
    { key: "settings", label: "Settings" },
  ];
  return (
    <div
      style={{
        borderBottom: `1px solid ${rule}`,
        display: "flex",
        gap: 4,
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          style={{
            padding: "8px 16px",
            background: "transparent",
            color: active === t.key ? courtBlue : inkMuted,
            border: "none",
            borderBottom:
              active === t.key
                ? `2px solid ${courtBlue}`
                : "2px solid transparent",
            // Pull the bottom border down to overlap the strip's own
            // border, otherwise the active underline sits above it
            // and looks doubled.
            marginBottom: -1,
            fontSize: 14,
            fontWeight: active === t.key ? 600 : 500,
            cursor: "pointer",
            fontFamily: bodyFontStack,
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// Settings tab — read-only view of every event-config column with an
// "Edit settings" link to the existing form page. We don't inline-
// edit yet because that'd require lifting EventFormPage's form into
// a shared component; deferred until there's a clear need.
function SettingsTab({
  event,
  editUrl,
}: {
  event: Event;
  editUrl: string;
}) {
  const playoffSummary =
    event.teams_advancing_to_playoff > 0
      ? `${event.teams_advancing_to_playoff} (${event.playoff_rounds} round${event.playoff_rounds === 1 ? "" : "s"})`
      : "None";
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: ink }}>
          Event settings
        </h2>
        <Link
          to={editUrl}
          style={{
            padding: "8px 16px",
            background: ink,
            color: cream,
            textDecoration: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            fontFamily: headingFontStack,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
        >
          Edit settings →
        </Link>
      </div>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          rowGap: 8,
          columnGap: 24,
          fontSize: 13,
          margin: 0,
          maxWidth: 700,
        }}
      >
        <DtDd label="Name" value={event.name} />
        <DtDd label="Format" value={capitalize(event.format)} />
        <DtDd label="Gender" value={capitalize(event.gender)} />
        <DtDd
          label="Bracket type"
          value={event.bracket_type.replace(/_/g, " ")}
        />
        <DtDd label="Pools" value={String(event.pool_count)} />
        <DtDd
          label="Play each team"
          value={`${event.play_each_team_times}×`}
        />
        <DtDd
          label="Game"
          value={`${event.points_to_win} win by ${event.win_by}`}
        />
        <DtDd
          label="Timeouts per game"
          value={String(event.timeouts_per_game)}
        />
        <DtDd label="Playoff" value={playoffSummary} />
        <DtDd
          label="Min age"
          value={event.min_age != null ? String(event.min_age) : "—"}
        />
        <DtDd
          label="Max age"
          value={event.max_age != null ? String(event.max_age) : "—"}
        />
        <DtDd
          label="Min rating"
          value={event.min_rating != null ? String(event.min_rating) : "—"}
        />
        <DtDd
          label="Max rating"
          value={event.max_rating != null ? String(event.max_rating) : "—"}
        />
        <DtDd label="Rating source" value={event.rating_source ?? "—"} />
        <DtDd
          label="Event fee"
          value={`$${(event.event_fee_cents / 100).toFixed(2)}`}
        />
        <DtDd
          label="Max teams"
          value={event.max_teams != null ? String(event.max_teams) : "Unlimited"}
        />
      </dl>
    </section>
  );
}

function DtDd({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={{ color: inkMuted }}>{label}</dt>
      <dd style={{ margin: 0, color: ink }}>{value}</dd>
    </>
  );
}

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
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: ink }}>{title}</h2>
      {right}
    </div>
  );
}


function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: 24,
        textAlign: "center",
        background: bg,
        border: `1px dashed ${rule}`,
        borderRadius: 6,
        color: inkMuted,
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
        background: dangerBg,
        border: `1px solid ${courtRed}`,
        borderRadius: 6,
        color: dangerFg,
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
  background: bg,
  borderBottom: `1px solid ${rule}`,
};

const tableRow: CSSProperties = {
  borderBottom: `1px solid ${ruleSoft}`,
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontSize: 11,
  color: inkMuted,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontWeight: 500,
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
};

const scoreInputStyle: CSSProperties = {
  width: 60,
  flexShrink: 0,
  padding: "8px 6px",
  border: `1px solid ${rule}`,
  borderRadius: 6,
  // 16px keeps iOS from zooming the viewport when the field is focused.
  fontSize: 16,
  fontFamily: bodyFontStack,
  fontVariantNumeric: "tabular-nums",
  textAlign: "center",
};

// ── Match card (Games tab) ───────────────────────────────────────────
// The list container: a responsive grid that is a single column at phone
// width (issue #500) and flows into multiple columns as space allows.
const matchGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
  gap: 10,
  alignItems: "start",
};

const matchCardStyle: CSSProperties = {
  border: `1px solid ${rule}`,
  borderLeft: `4px solid ${rule}`, // color overridden per status
  borderRadius: 8,
  background: "#fff",
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  breakInside: "avoid",
};

const matchCardHeader: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
};

const matchNumStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: inkMuted,
};

const matchTeamsBlock: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const matchTeamRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
};

const matchTeamName: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  fontSize: 15,
  lineHeight: 1.3,
  overflowWrap: "anywhere",
};

const matchVsStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: inkMuted,
  textAlign: "center",
  padding: "2px 0",
};

const matchPrintScore: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
};

const matchCardActions: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 10,
  flexWrap: "wrap",
};

function matchSaveBtn(disabled: boolean): CSSProperties {
  return {
    padding: "8px 20px",
    minHeight: 40, // ≥44px tap target with the border box
    background: disabled ? inkMuted : ink,
    color: cream,
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: headingFontStack,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function primaryBtn(busy: boolean): CSSProperties {
  return {
    padding: "8px 16px",
    background: busy ? inkMuted : ink,
    color: cream,
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: headingFontStack,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    cursor: busy ? "not-allowed" : "pointer",
  };
}

const tinyPrimaryBtn: CSSProperties = {
  padding: "4px 10px",
  background: ink,
  color: cream,
  border: "none",
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 600,
  fontFamily: headingFontStack,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  cursor: "pointer",
};

const tinySecondaryBtn: CSSProperties = {
  padding: "4px 10px",
  background: "#ffffff",
  color: inkSoft,
  border: `1px solid ${rule}`,
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: bodyFontStack,
};

const tinyDangerBtn: CSSProperties = {
  padding: "4px 10px",
  background: "#ffffff",
  color: dangerFg,
  border: `1px solid ${courtRed}`,
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: bodyFontStack,
};
