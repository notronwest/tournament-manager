import {
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../supabase";
import { useCurrentOrg } from "../../hooks/useCurrentOrg";
import { ConfirmModal } from "../../components/ConfirmModal";
import type { Database } from "../../types/supabase";
import {
  ink,
  inkSoft,
  inkMuted,
  bg,
  cream,
  creamDeep,
  rule,
  courtBlue,
  courtRed,
  dangerBg,
  dangerFg,
  warnBg,
  warnFg,
  bodyFontStack,
  headingFontStack,
  displayFontStack,
} from "../../lib/publicTheme";

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];
type Match = Database["public"]["Tables"]["matches"]["Row"];
type EventFormat = Database["public"]["Enums"]["event_format"];
type EventGender = Database["public"]["Enums"]["event_gender"];
type RatingSource = Database["public"]["Enums"]["rating_source"];
type MedalMatchFormat = Database["public"]["Enums"]["medal_match_format"];

// Single form used to both create and edit an event. Mode is passed
// in from the route. The format fields drive RR + playoff generation
// downstream — bracket structure and the printed scorecard layout
// reference these directly.
export default function EventFormPage({ mode }: { mode: "create" | "edit" }) {
  const { org } = useCurrentOrg();
  const { tournamentSlug, eventId } = useParams<{
    tournamentSlug: string;
    eventId: string;
  }>();
  const navigate = useNavigate();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [event, setEvent] = useState<Event | null>(null);
  const [name, setName] = useState("");
  const [format, setFormat] = useState<EventFormat>("doubles");
  const [gender, setGender] = useState<EventGender>("mixed");
  const [maxTeams, setMaxTeams] = useState("10");
  // Format config
  const [poolCount, setPoolCount] = useState("1");
  const [playEachTeamTimes, setPlayEachTeamTimes] = useState("1");
  const [pointsToWin, setPointsToWin] = useState("11");
  const [winBy, setWinBy] = useState("2");
  const [timeoutsPerGame, setTimeoutsPerGame] = useState("1");
  const [poolMinutesPerGame, setPoolMinutesPerGame] = useState("15");
  const [teamsAdvancing, setTeamsAdvancing] = useState("4");
  const [playoffRounds, setPlayoffRounds] = useState("1");
  // Medal-round overrides (separate from pool play because medal
  // matches often play longer — to 15 win-by-2, best of 3, etc.)
  const [medalMatchFormat, setMedalMatchFormat] = useState<
    "single_game" | "best_of_3"
  >("single_game");
  const [medalPointsToWin, setMedalPointsToWin] = useState("15");
  const [medalWinBy, setMedalWinBy] = useState("2");
  const [medalMinutesPerGame, setMedalMinutesPerGame] = useState("20");
  // Semifinal format — only meaningful when playoff_rounds = 2.
  // For R=1 (pairwise medals) the semifinal fields are saved but
  // ignored at generation time. Defaults intentionally match pool
  // play (11 win-by-2, single game, 15 min) so the common pattern
  // "semis play pool rules, final + bronze play longer medal rules"
  // works without the organizer touching this section.
  const [semifinalMatchFormat, setSemifinalMatchFormat] = useState<
    "single_game" | "best_of_3"
  >("single_game");
  const [semifinalPointsToWin, setSemifinalPointsToWin] = useState("11");
  const [semifinalWinBy, setSemifinalWinBy] = useState("2");
  const [semifinalMinutesPerGame, setSemifinalMinutesPerGame] = useState("15");
  // Eligibility (all optional; blank = no bound)
  const [minRating, setMinRating] = useState("");
  const [maxRating, setMaxRating] = useState("");
  // Default rating source = self-rating (matches the new column
  // default in migration 20260530170000). Edit mode loads the saved
  // value below and overrides this default.
  const [ratingSource, setRatingSource] = useState<RatingSource | "">("self");
  const [minAge, setMinAge] = useState("");
  const [maxAge, setMaxAge] = useState("");

  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Match-state snapshot at edit time, drives the "are you sure?"
  // warning before saving. We only block the save in edit mode and
  // only when at least one match exists.
  const [matchStats, setMatchStats] = useState<{
    total: number;
    inProgress: number;
    completed: number;
  } | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  // Playoff matches in edit mode — surface per-match format
  // overrides at the bottom of the Playoff group so organizers
  // can configure "semis 11/win-by-2 single-game, final 15/win-by-2
  // best-of-3" without leaving this page.
  const [playoffMatches, setPlayoffMatches] = useState<Match[]>([]);

  useEffect(() => {
    if (!org || !tournamentSlug) return;
    let cancelled = false;
    (async () => {
      setLoading(true);

      const { data: tData, error: tErr } = await supabase
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
      if (!tData) {
        setError("Tournament not found.");
        setLoading(false);
        return;
      }
      setTournament(tData);

      if (mode === "edit" && eventId) {
        const { data: ev, error: evErr } = await supabase
          .from("events")
          .select("*")
          .eq("id", eventId)
          .eq("tournament_id", tData.id)
          .is("deleted_at", null)
          .maybeSingle();
        if (cancelled) return;
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
        setEvent(ev);
        setName(ev.name);
        setFormat(ev.format);
        setGender(ev.gender);
        setMaxTeams(String(ev.max_teams ?? 10));
        setPoolCount(String(ev.pool_count));
        setPlayEachTeamTimes(String(ev.play_each_team_times));
        setPointsToWin(String(ev.points_to_win));
        setWinBy(String(ev.win_by));
        setTimeoutsPerGame(String(ev.timeouts_per_game));
        setPoolMinutesPerGame(String(ev.pool_minutes_per_game));
        setTeamsAdvancing(String(ev.teams_advancing_to_playoff));
        setPlayoffRounds(String(ev.playoff_rounds));
        setMedalMatchFormat(ev.medal_match_format);
        setMedalPointsToWin(String(ev.medal_points_to_win));
        setMedalWinBy(String(ev.medal_win_by));
        setMedalMinutesPerGame(String(ev.medal_minutes_per_game));
        setSemifinalMatchFormat(ev.semifinal_match_format);
        setSemifinalPointsToWin(String(ev.semifinal_points_to_win));
        setSemifinalWinBy(String(ev.semifinal_win_by));
        setSemifinalMinutesPerGame(String(ev.semifinal_minutes_per_game));
        setMinRating(ev.min_rating != null ? String(ev.min_rating) : "");
        setMaxRating(ev.max_rating != null ? String(ev.max_rating) : "");
        setRatingSource(ev.rating_source ?? "");
        setMinAge(ev.min_age != null ? String(ev.min_age) : "");
        setMaxAge(ev.max_age != null ? String(ev.max_age) : "");

        // Pull match counts so we know whether to warn on save.
        // Also pull every playoff match — we surface per-match
        // format overrides further down so the organizer can edit
        // semis-vs-finals (etc.) independently of the event-level
        // medal defaults.
        const [statusRes, playoffRes] = await Promise.all([
          supabase.from("matches").select("status").eq("event_id", ev.id),
          supabase
            .from("matches")
            .select("*")
            .eq("event_id", ev.id)
            .eq("stage", "playoff")
            .order("round", { ascending: true })
            .order("position", { ascending: true }),
        ]);
        if (cancelled) return;
        const list = statusRes.data ?? [];
        setMatchStats({
          total: list.length,
          inProgress: list.filter((m) => m.status === "in_progress").length,
          completed: list.filter((m) => m.status === "completed").length,
        });
        setPlayoffMatches(playoffRes.data ?? []);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [org, tournamentSlug, eventId, mode]);

  const buildPayload = () => {
    if (!tournament) return null;
    const max = parseInt(maxTeams || "0", 10);
    if (Number.isNaN(max) || max < 2) {
      setError("Max teams must be at least 2.");
      return null;
    }
    const minRatingNum = optionalFloat(minRating);
    const maxRatingNum = optionalFloat(maxRating);
    const minAgeNum = optionalInt(minAge);
    const maxAgeNum = optionalInt(maxAge);

    if (
      minRatingNum != null &&
      maxRatingNum != null &&
      minRatingNum > maxRatingNum
    ) {
      setError("Rating min can't be greater than rating max.");
      return null;
    }
    if (minAgeNum != null && maxAgeNum != null && minAgeNum > maxAgeNum) {
      setError("Age min can't be greater than age max.");
      return null;
    }
    if ((minRatingNum != null || maxRatingNum != null) && !ratingSource) {
      setError("Pick a rating source when setting rating bounds.");
      return null;
    }

    return {
      tournament_id: tournament.id,
      name: name.trim(),
      format,
      gender,
      max_teams: max,
      bracket_type: "round_robin" as const,
      event_fee_cents: 0,
      pool_count: clampInt(poolCount, 1, 1, 16),
      play_each_team_times: clampInt(playEachTeamTimes, 1, 1, 5),
      points_to_win: clampInt(pointsToWin, 11, 1, 99),
      win_by: clampInt(winBy, 2, 1, 9),
      timeouts_per_game: clampInt(timeoutsPerGame, 1, 0, 5),
      pool_minutes_per_game: clampInt(poolMinutesPerGame, 15, 1, 120),
      teams_advancing_to_playoff: clampInt(teamsAdvancing, 0, 0, 64),
      playoff_rounds: clampInt(playoffRounds, 1, 1, 4),
      medal_match_format: medalMatchFormat,
      medal_points_to_win: clampInt(medalPointsToWin, 15, 1, 99),
      medal_win_by: clampInt(medalWinBy, 2, 1, 9),
      medal_minutes_per_game: clampInt(medalMinutesPerGame, 20, 1, 120),
      semifinal_match_format: semifinalMatchFormat,
      semifinal_points_to_win: clampInt(semifinalPointsToWin, 11, 1, 99),
      semifinal_win_by: clampInt(semifinalWinBy, 2, 1, 9),
      semifinal_minutes_per_game: clampInt(semifinalMinutesPerGame, 15, 1, 120),
      min_rating: minRatingNum,
      max_rating: maxRatingNum,
      rating_source: ratingSource || null,
      min_age: minAgeNum,
      max_age: maxAgeNum,
    };
  };

  const doSave = async () => {
    setError(null);
    const payload = buildPayload();
    if (!payload) return;

    setBusy(true);
    if (mode === "create") {
      const { data, error: insErr } = await supabase
        .from("events")
        .insert(payload)
        .select()
        .single();
      setBusy(false);
      if (insErr) {
        setError(insErr.message);
        return;
      }
      if (data && org) {
        navigate(
          `/admin/${org.slug}/tournaments/${tournamentSlug}/events/${data.id}`,
        );
      }
    } else {
      if (!event || !org) return;
      const { error: updErr } = await supabase
        .from("events")
        .update(payload)
        .eq("id", event.id);
      setBusy(false);
      if (updErr) {
        setError(updErr.message);
        return;
      }
      navigate(
        `/admin/${org.slug}/tournaments/${tournamentSlug}/events/${event.id}`,
      );
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    // Editing an event with existing matches is high-blast-radius —
    // gate behind a confirmation. Create mode and edit-with-no-matches
    // skip the prompt.
    if (
      mode === "edit" &&
      matchStats &&
      matchStats.total > 0
    ) {
      setShowConfirm(true);
      return;
    }
    void doSave();
  };

  // Hooks must run unconditionally — keep these above the early returns.
  const advancingNum = parseInt(teamsAdvancing || "0", 10);
  const roundsNum = parseInt(playoffRounds || "1", 10);
  const maxTeamsNum = parseInt(maxTeams || "0", 10) || 0;
  // Smallest pool must hold at least 4 teams. Multi-pool only makes
  // sense from 8 teams up (2 pools × 4 = 8).
  const maxPoolsAllowed =
    maxTeamsNum >= 8 ? Math.max(1, Math.floor(maxTeamsNum / 4)) : 1;
  const poolOptions = Array.from(
    { length: maxPoolsAllowed },
    (_, i) => i + 1,
  );
  // Snap pool count back to 1 if the user lowers max_teams below the
  // threshold for the currently selected pool count.
  useEffect(() => {
    const current = parseInt(poolCount || "1", 10);
    if (Number.isFinite(current) && current > maxPoolsAllowed) {
      setPoolCount(String(maxPoolsAllowed));
    }
  }, [maxPoolsAllowed, poolCount]);

  if (!org) return null;
  if (loading)
    return <div style={{ color: inkSoft, fontSize: 14, fontFamily: bodyFontStack }}>Loading…</div>;
  if (!tournament) {
    return <div style={{ color: inkSoft, fontSize: 14, fontFamily: bodyFontStack }}>Loading…</div>;
  }

  // Surface the most common misconfiguration: top-N must be even when
  // running a single-round (pairwise) playoff, and 2-round structures
  // are only supported for top-4 in this build.
  const playoffWarning = (() => {
    if (advancingNum === 0) return null;
    if (roundsNum === 1 && advancingNum % 2 !== 0)
      return "Single-round playoffs need an even Top-N (pairs play for each medal slot).";
    if (roundsNum === 2 && advancingNum !== 4)
      return "2-round playoffs (semis + final + bronze) currently support Top-4 only.";
    return null;
  })();

  return (
    <div style={{ maxWidth: 720, fontFamily: bodyFontStack }}>
      <Link
        to={`/admin/${org.slug}/tournaments/${tournamentSlug}${mode === "edit" && event ? `/events/${event.id}` : ""}`}
        style={{ color: courtBlue, textDecoration: "none", fontSize: 13 }}
      >
        ← {mode === "edit" && event ? event.name : tournament.name}
      </Link>
      <header style={{ margin: "12px 0 24px" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontFamily: displayFontStack, color: ink }}>
          {mode === "create" ? "New event" : "Edit event"}
        </h1>
        <p style={{ color: inkSoft, margin: "4px 0 0", fontSize: 14 }}>
          {mode === "create"
            ? "A bracket within the tournament. Configure pool play, scoring, and the playoff structure here."
            : "Updating format affects how new RR and playoff matches generate. Existing matches keep their original pairings — reset and regenerate to apply changes."}
        </p>
      </header>

      <form
        onSubmit={onSubmit}
        style={{ display: "flex", flexDirection: "column", gap: 28 }}
      >
        {/* Basics */}
        <FieldGroup title="Basics">
          <Field label="Name" required>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <FieldRow>
            <Field label="Format" required>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as EventFormat)}
                style={inputStyle}
              >
                <option value="doubles">Doubles</option>
                <option value="singles">Singles</option>
              </select>
            </Field>
            <Field label="Gender" required>
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value as EventGender)}
                style={inputStyle}
              >
                <option value="mixed">Mixed</option>
                <option value="men">Men</option>
                <option value="women">Women</option>
              </select>
            </Field>
            <Field label="Max teams" required>
              <input
                type="number"
                min="2"
                max="64"
                required
                value={maxTeams}
                onChange={(e) => setMaxTeams(e.target.value)}
                style={inputStyle}
              />
            </Field>
          </FieldRow>
        </FieldGroup>

        {/* Eligibility */}
        <FieldGroup
          title="Eligibility (optional)"
          subtitle="Leave any field blank for no bound. Examples: rating 3.0–3.49 / age 50+ / age 18–39."
        >
          <FieldRow>
            <Field label="Rating min" hint="Inclusive (e.g. 3.0).">
              <input
                type="number"
                step="0.01"
                min="0"
                max="9.99"
                value={minRating}
                onChange={(e) => setMinRating(e.target.value)}
                placeholder="—"
                style={inputStyle}
              />
            </Field>
            <Field label="Rating max" hint="Inclusive (e.g. 3.49).">
              <input
                type="number"
                step="0.01"
                min="0"
                max="9.99"
                value={maxRating}
                onChange={(e) => setMaxRating(e.target.value)}
                placeholder="—"
                style={inputStyle}
              />
            </Field>
            <Field
              label="Rating source"
              hint="Required when any rating bound is set."
            >
              <select
                value={ratingSource}
                onChange={(e) =>
                  setRatingSource(e.target.value as RatingSource | "")
                }
                style={inputStyle}
              >
                <option value="">—</option>
                <option value="dupr">DUPR</option>
                <option value="pbvision">PB Vision</option>
                <option value="wmpc_rating_hub">WMPC Rating Hub</option>
                <option value="self">Self-rating</option>
              </select>
            </Field>
          </FieldRow>
          <FieldRow>
            <Field label="Age min" hint="Inclusive (e.g. 50).">
              <input
                type="number"
                min="0"
                max="120"
                value={minAge}
                onChange={(e) => setMinAge(e.target.value)}
                placeholder="—"
                style={inputStyle}
              />
            </Field>
            <Field label="Age max" hint="Inclusive (e.g. 39).">
              <input
                type="number"
                min="0"
                max="120"
                value={maxAge}
                onChange={(e) => setMaxAge(e.target.value)}
                placeholder="—"
                style={inputStyle}
              />
            </Field>
          </FieldRow>
        </FieldGroup>

        {/* Pool play */}
        <FieldGroup
          title="Round-robin pool play"
          subtitle={
            poolCount === "1"
              ? "Single pool: every team plays every other team."
              : `Multi-pool: each team plays only within its assigned pool. Assign teams to pools on the event console once the event is created.`
          }
        >
          <FieldRow>
            <Field
              label="Number of pools"
              hint={
                maxTeamsNum < 8
                  ? "Multiple pools require at least 8 teams (smallest pool holds 4)."
                  : `Up to ${maxPoolsAllowed} pool${maxPoolsAllowed === 1 ? "" : "s"} for ${maxTeamsNum} teams (smallest pool ≥ 4).`
              }
            >
              <select
                value={poolCount}
                onChange={(e) => setPoolCount(e.target.value)}
                disabled={maxPoolsAllowed === 1}
                style={inputStyle}
              >
                {poolOptions.map((n) => (
                  <option key={n} value={n}>
                    {n} {n === 1 ? "pool" : "pools"}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Play each opponent"
              hint="How many times each pair plays within their pool."
            >
              <select
                value={playEachTeamTimes}
                onChange={(e) => setPlayEachTeamTimes(e.target.value)}
                style={inputStyle}
              >
                <option value="1">1 time</option>
                <option value="2">2 times</option>
                <option value="3">3 times</option>
              </select>
            </Field>
          </FieldRow>
        </FieldGroup>

        {/* Scoring */}
        <FieldGroup title="Scoring (printed on scorecards)">
          <FieldRow>
            <Field label="Points to win" required>
              <input
                type="number"
                min="1"
                max="99"
                required
                value={pointsToWin}
                onChange={(e) => setPointsToWin(e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="Win by" required>
              <input
                type="number"
                min="1"
                max="9"
                required
                value={winBy}
                onChange={(e) => setWinBy(e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="Timeouts per team / game" required>
              <input
                type="number"
                min="0"
                max="5"
                required
                value={timeoutsPerGame}
                onChange={(e) => setTimeoutsPerGame(e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field
              label="Pool minutes per game"
              hint="Used by the schedule estimator. Include changeover, not just gameplay."
            >
              <input
                type="number"
                min="1"
                max="120"
                value={poolMinutesPerGame}
                onChange={(e) => setPoolMinutesPerGame(e.target.value)}
                style={inputStyle}
              />
            </Field>
          </FieldRow>
        </FieldGroup>

        {/* Playoff */}
        <FieldGroup title="Playoff">
          <fieldset
            style={{
              border: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <RadioOption
              checked={advancingNum === 0}
              onChange={() => {
                setTeamsAdvancing("0");
              }}
              label="No playoff"
              hint="Final standings come straight from pool play (record + point differential)."
            />
            <RadioOption
              checked={advancingNum > 0}
              onChange={() => {
                if (advancingNum === 0) setTeamsAdvancing("4");
              }}
              label="Playoff"
              hint="Top-N teams from pool play advance to a bracket."
            />
          </fieldset>

          {advancingNum > 0 && (
            <div
              style={{
                marginTop: 4,
                padding: 12,
                background: "#ffffff",
                border: `1px solid ${rule}`,
                borderRadius: 6,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <FieldRow>
                <Field label="Teams advancing">
                  <input
                    type="number"
                    min="2"
                    max="64"
                    value={teamsAdvancing}
                    onChange={(e) => setTeamsAdvancing(e.target.value)}
                    style={inputStyle}
                  />
                </Field>
                <Field
                  label="Number of rounds"
                  hint="1 round = pairs play directly for each medal slot (e.g. top 4: 1v2 gold, 3v4 bronze). 2 rounds = traditional bracket with a bronze game (top 4 only)."
                >
                  <select
                    value={playoffRounds}
                    onChange={(e) => setPlayoffRounds(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="1">1 round (pairwise medal matches)</option>
                    <option value="2">2 rounds (semis + final + bronze)</option>
                  </select>
                </Field>
              </FieldRow>
              {playoffWarning && (
                <div
                  style={{
                    padding: 10,
                    background: warnBg,
                    border: `1px solid ${creamDeep}`,
                    borderRadius: 6,
                    color: warnFg,
                    fontSize: 12,
                  }}
                >
                  {playoffWarning}
                </div>
              )}

              {/* For R=2 brackets, surface the semifinal format
                  block above the medal-match block. Semis often
                  play to pool-play rules while the medal matches
                  themselves run longer — splitting them lets the
                  organizer configure both before generation rather
                  than after via per-match overrides. The semifinal
                  fields are still saved on R=1 events (so toggling
                  rounds back and forth doesn't lose data) but
                  ignored at generation time. */}
              {roundsNum === 2 && (
                <div
                  style={{
                    marginTop: 4,
                    paddingTop: 12,
                    borderTop: `1px dashed ${rule}`,
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: inkSoft,
                      marginBottom: 8,
                      fontFamily: headingFontStack,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    Semifinal format
                  </div>
                  <FieldRow>
                    <Field label="Match format">
                      <select
                        value={semifinalMatchFormat}
                        onChange={(e) =>
                          setSemifinalMatchFormat(
                            e.target.value as "single_game" | "best_of_3",
                          )
                        }
                        style={inputStyle}
                      >
                        <option value="single_game">1 game</option>
                        <option value="best_of_3">Best of 3</option>
                      </select>
                    </Field>
                    <Field label="Points to win">
                      <input
                        type="number"
                        min="1"
                        max="99"
                        value={semifinalPointsToWin}
                        onChange={(e) => setSemifinalPointsToWin(e.target.value)}
                        style={inputStyle}
                      />
                    </Field>
                    <Field label="Win by">
                      <input
                        type="number"
                        min="1"
                        max="9"
                        value={semifinalWinBy}
                        onChange={(e) => setSemifinalWinBy(e.target.value)}
                        style={inputStyle}
                      />
                    </Field>
                    <Field label="Minutes per game">
                      <input
                        type="number"
                        min="1"
                        max="120"
                        value={semifinalMinutesPerGame}
                        onChange={(e) =>
                          setSemifinalMinutesPerGame(e.target.value)
                        }
                        style={inputStyle}
                      />
                    </Field>
                  </FieldRow>
                </div>
              )}

              {/* Medal match format — separated from pool scoring
                  because medal games often play longer (15 win-by-2,
                  best-of-3) than pool games. Label depends on
                  whether this is "the medal matches" (R=1 pairwise)
                  or "the final + bronze game" (R=2 bracket). */}
              <div
                style={{
                  marginTop: 4,
                  paddingTop: 12,
                  borderTop: `1px dashed ${rule}`,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: inkSoft,
                    marginBottom: 8,
                    fontFamily: headingFontStack,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  {roundsNum === 2
                    ? "Final + bronze format"
                    : "Medal match format"}
                </div>
                <FieldRow>
                  <Field
                    label="Match format"
                    hint="Best-of-3 means a match is decided over up to three games (first to win 2)."
                  >
                    <select
                      value={medalMatchFormat}
                      onChange={(e) =>
                        setMedalMatchFormat(
                          e.target.value as "single_game" | "best_of_3",
                        )
                      }
                      style={inputStyle}
                    >
                      <option value="single_game">1 game</option>
                      <option value="best_of_3">Best of 3</option>
                    </select>
                  </Field>
                  <Field
                    label="Points to win"
                    hint="Per game (printed on the medal-round scorecard)."
                  >
                    <input
                      type="number"
                      min="1"
                      max="99"
                      value={medalPointsToWin}
                      onChange={(e) => setMedalPointsToWin(e.target.value)}
                      style={inputStyle}
                    />
                  </Field>
                  <Field label="Win by">
                    <input
                      type="number"
                      min="1"
                      max="9"
                      value={medalWinBy}
                      onChange={(e) => setMedalWinBy(e.target.value)}
                      style={inputStyle}
                    />
                  </Field>
                  <Field
                    label="Minutes per game"
                    hint="Used by the time estimator. Medal games usually run longer than pool games."
                  >
                    <input
                      type="number"
                      min="1"
                      max="120"
                      value={medalMinutesPerGame}
                      onChange={(e) => setMedalMinutesPerGame(e.target.value)}
                      style={inputStyle}
                    />
                  </Field>
                </FieldRow>
              </div>

              {/* Per-match overrides. Only meaningful in edit mode
                  after the bracket has been generated — each match
                  carries its own copy of the medal format so the
                  semis can play single-game-to-11 while the gold
                  final plays best-of-3-to-15 (or any other split).
                  Saves write match-level columns; the event-level
                  defaults above stay as fallbacks for matches that
                  haven't been touched. */}
              {mode === "edit" && playoffMatches.length > 0 && (
                <PerMatchFormatList
                  matches={playoffMatches}
                  onMatchSaved={(updated) =>
                    setPlayoffMatches((prev) =>
                      prev.map((m) => (m.id === updated.id ? updated : m)),
                    )
                  }
                />
              )}
            </div>
          )}
        </FieldGroup>

        {error && <ErrorBox message={error} />}

        <div style={{ display: "flex", gap: 12 }}>
          <button type="submit" disabled={busy} style={primaryBtn(busy)}>
            {busy
              ? "Saving…"
              : mode === "create"
                ? "Create event"
                : "Save changes"}
          </button>
          <button
            type="button"
            onClick={() =>
              navigate(
                `/admin/${org.slug}/tournaments/${tournamentSlug}${mode === "edit" && event ? `/events/${event.id}` : ""}`,
              )
            }
            style={secondaryBtn}
          >
            Cancel
          </button>
        </div>
      </form>

      {showConfirm && matchStats && (
        <ConfirmModal
          title="Edit format on a live event?"
          confirmLabel="Save changes anyway"
          destructive
          onCancel={() => setShowConfirm(false)}
          onConfirm={async () => {
            await doSave();
            setShowConfirm(false);
          }}
          body={<EditWarningBody stats={matchStats} />}
        />
      )}
    </div>
  );
}

function EditWarningBody({
  stats,
}: {
  stats: { total: number; inProgress: number; completed: number };
}) {
  const playedAlready = stats.inProgress + stats.completed;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, fontFamily: bodyFontStack }}>
      <p style={{ margin: 0 }}>
        This event already has <strong>{stats.total}</strong>{" "}
        match{stats.total === 1 ? "" : "es"} generated
        {playedAlready > 0
          ? `, including ${stats.completed} completed and ${stats.inProgress} in progress`
          : " (all still pending)"}
        .
      </p>
      <p style={{ margin: 0 }}>
        Changing pool count, "play each opponent", or "teams advancing /
        rounds" affects how matches generate. The existing matches
        won't move on their own — you'll need to{" "}
        <strong>reset and regenerate</strong> from the event console
        for the new format to take effect.
      </p>
      {playedAlready > 0 && (
        <p
          style={{
            margin: 0,
            padding: 10,
            background: dangerBg,
            border: `1px solid ${courtRed}`,
            borderRadius: 6,
            color: dangerFg,
          }}
        >
          Resetting matches will <strong>discard scores already entered</strong>.
          Points-to-win, win-by, and timeouts only affect the printed
          scorecard — those are safe to change without resetting.
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Form helpers
// ─────────────────────────────────────────────────────────────────────

function clampInt(s: string, fallback: number, min: number, max: number) {
  const n = parseInt(s || "", 10);
  if (Number.isNaN(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function optionalInt(s: string): number | null {
  if (!s.trim()) return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

function optionalFloat(s: string): number | null {
  if (!s.trim()) return null;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

function RadioOption({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        cursor: "pointer",
        fontSize: 13,
        color: inkSoft,
        fontFamily: bodyFontStack,
      }}
    >
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        style={{ marginTop: 3 }}
      />
      <span>
        <span style={{ fontWeight: 500, color: ink }}>{label}</span>
        {hint && (
          <span
            style={{
              display: "block",
              fontSize: 12,
              color: inkMuted,
              marginTop: 2,
            }}
          >
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}

function FieldGroup({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        padding: 16,
        background: cream,
        border: `1px solid ${rule}`,
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div>
        <h2 style={{
          margin: 0,
          fontSize: 13,
          fontWeight: 600,
          fontFamily: headingFontStack,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: ink,
        }}>{title}</h2>
        {subtitle && (
          <p style={{ margin: "4px 0 0", color: inkSoft, fontSize: 12 }}>
            {subtitle}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12,
        color: inkSoft,
        fontFamily: bodyFontStack,
      }}
    >
      <span>
        {label}
        {required && <span style={{ color: courtRed, marginLeft: 4 }}>*</span>}
      </span>
      {children}
      {hint && (
        <span style={{ fontSize: 11, color: inkMuted, marginTop: 2 }}>
          {hint}
        </span>
      )}
    </label>
  );
}

function FieldRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}

// Per-match override list shown at the bottom of the Playoff
// FieldGroup. One row per playoff match, each with its own Save
// button — saves are inline (not bundled with the parent form's
// "Save changes" submit) so changing the gold-final format doesn't
// require the user to also resubmit every event-level field.
//
// The row label uses round + position to disambiguate (Round 1
// Match 1, etc.) — we don't know whether a 2-match round is semis
// or pairwise medal matches from this context alone, so we keep
// the labels generic. The PlayoffSection in the event console
// already shows the friendly names ("Semifinals", "Gold Medal
// Final", etc.) for in-flight bracket viewing.
function PerMatchFormatList({
  matches,
  onMatchSaved,
}: {
  matches: Match[];
  onMatchSaved: (updated: Match) => void;
}) {
  return (
    <div
      style={{
        marginTop: 12,
        paddingTop: 12,
        borderTop: `1px dashed ${rule}`,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: inkSoft,
          marginBottom: 8,
          fontFamily: headingFontStack,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        Per-match overrides
      </div>
      <p
        style={{
          fontSize: 12,
          color: inkMuted,
          margin: "0 0 12px",
        }}
      >
        Each medal match was copied from the event defaults above when
        the bracket was generated. Override here to give individual
        matches a different game-rule set — e.g. semis single-game,
        final best-of-3.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {matches.map((m) => (
          <MatchFormatRow
            key={m.id}
            match={m}
            onSaved={onMatchSaved}
          />
        ))}
      </div>
    </div>
  );
}

function MatchFormatRow({
  match,
  onSaved,
}: {
  match: Match;
  onSaved: (updated: Match) => void;
}) {
  const [format, setFormat] = useState<MedalMatchFormat>(
    match.match_format ?? "single_game",
  );
  const [pts, setPts] = useState(
    match.match_points_to_win != null ? String(match.match_points_to_win) : "15",
  );
  const [winBy, setWinBy] = useState(
    match.match_win_by != null ? String(match.match_win_by) : "2",
  );
  const [mins, setMins] = useState(
    match.match_minutes_per_game != null
      ? String(match.match_minutes_per_game)
      : "20",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const dirty =
    format !== (match.match_format ?? "single_game") ||
    pts !== String(match.match_points_to_win ?? 15) ||
    winBy !== String(match.match_win_by ?? 2) ||
    mins !== String(match.match_minutes_per_game ?? 20);

  const save = async () => {
    setBusy(true);
    setErr(null);
    const ptsN = parseInt(pts, 10);
    const winByN = parseInt(winBy, 10);
    const minsN = parseInt(mins, 10);
    if (Number.isNaN(ptsN) || ptsN < 1 || ptsN > 99) {
      setErr("Points to win must be between 1 and 99.");
      setBusy(false);
      return;
    }
    if (Number.isNaN(winByN) || winByN < 1 || winByN > 9) {
      setErr("Win-by must be between 1 and 9.");
      setBusy(false);
      return;
    }
    if (Number.isNaN(minsN) || minsN < 1 || minsN > 120) {
      setErr("Minutes-per-game must be between 1 and 120.");
      setBusy(false);
      return;
    }
    const { data, error: updErr } = await supabase
      .from("matches")
      .update({
        match_format: format,
        match_points_to_win: ptsN,
        match_win_by: winByN,
        match_minutes_per_game: minsN,
      })
      .eq("id", match.id)
      .select("*")
      .single();
    setBusy(false);
    if (updErr) {
      setErr(updErr.message);
      return;
    }
    if (data) onSaved(data as Match);
    setSavedAt(Date.now());
  };

  // Two-match rounds in either pairwise or semis form: we don't
  // know from raw match data which is which, so label generically
  // by round + position. The Games-tab PlayoffSection still
  // shows the friendly names while playing.
  const label = `Round ${match.round} · Match ${match.position + 1}`;

  return (
    <div
      style={{
        padding: 10,
        background: "#ffffff",
        border: `1px solid ${rule}`,
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: inkSoft, fontFamily: headingFontStack, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "flex-end",
        }}
      >
        <label style={smallField}>
          <span style={smallLabel}>Format</span>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as MedalMatchFormat)}
            style={smallInput}
          >
            <option value="single_game">1 game</option>
            <option value="best_of_3">Best of 3</option>
          </select>
        </label>
        <label style={smallField}>
          <span style={smallLabel}>Points to win</span>
          <input
            type="number"
            min="1"
            max="99"
            value={pts}
            onChange={(e) => setPts(e.target.value)}
            style={smallInput}
          />
        </label>
        <label style={smallField}>
          <span style={smallLabel}>Win by</span>
          <input
            type="number"
            min="1"
            max="9"
            value={winBy}
            onChange={(e) => setWinBy(e.target.value)}
            style={smallInput}
          />
        </label>
        <label style={smallField}>
          <span style={smallLabel}>Minutes / game</span>
          <input
            type="number"
            min="1"
            max="120"
            value={mins}
            onChange={(e) => setMins(e.target.value)}
            style={smallInput}
          />
        </label>
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          style={tinyPrimaryBtn(busy || !dirty)}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {savedAt && !dirty && (
          <span style={{ fontSize: 12, color: inkSoft }}>Saved</span>
        )}
      </div>
      {err && (
        <div style={{ color: dangerFg, fontSize: 12 }}>{err}</div>
      )}
    </div>
  );
}

const smallField: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: inkSoft,
  fontFamily: bodyFontStack,
};
const smallLabel: CSSProperties = {
  fontSize: 11,
  color: inkMuted,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontFamily: headingFontStack,
};
const smallInput: CSSProperties = {
  padding: "6px 10px",
  border: `1px solid ${rule}`,
  borderRadius: 4,
  fontSize: 13,
  fontFamily: bodyFontStack,
  color: ink,
  background: "#ffffff",
  width: 120,
};
function tinyPrimaryBtn(disabled: boolean): CSSProperties {
  return {
    padding: "6px 14px",
    background: disabled ? inkMuted : ink,
    color: bg,
    border: "none",
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: headingFontStack,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    cursor: disabled ? "not-allowed" : "pointer",
  };
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
      }}
    >
      {message}
    </div>
  );
}

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  border: `1px solid ${rule}`,
  borderRadius: 6,
  fontSize: 13,
  fontFamily: bodyFontStack,
  color: ink,
  width: "100%",
  background: "#ffffff",
};

function primaryBtn(busy: boolean): CSSProperties {
  return {
    padding: "10px 20px",
    background: busy ? inkMuted : ink,
    color: bg,
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

const secondaryBtn: CSSProperties = {
  padding: "10px 20px",
  background: "transparent",
  color: ink,
  boxShadow: `inset 0 0 0 2px ${ink}`,
  border: "none",
  borderRadius: 6,
  fontSize: 13,
  fontFamily: headingFontStack,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  cursor: "pointer",
};
