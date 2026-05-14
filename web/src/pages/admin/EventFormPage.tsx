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

type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
type Event = Database["public"]["Tables"]["events"]["Row"];
type EventFormat = Database["public"]["Enums"]["event_format"];
type EventGender = Database["public"]["Enums"]["event_gender"];
type RatingSource = Database["public"]["Enums"]["rating_source"];

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
  // Eligibility (all optional; blank = no bound)
  const [minRating, setMinRating] = useState("");
  const [maxRating, setMaxRating] = useState("");
  const [ratingSource, setRatingSource] = useState<RatingSource | "">("");
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
        setTeamsAdvancing(String(ev.teams_advancing_to_playoff));
        setPlayoffRounds(String(ev.playoff_rounds));
        setMedalMatchFormat(ev.medal_match_format);
        setMedalPointsToWin(String(ev.medal_points_to_win));
        setMedalWinBy(String(ev.medal_win_by));
        setMedalMinutesPerGame(String(ev.medal_minutes_per_game));
        setMinRating(ev.min_rating != null ? String(ev.min_rating) : "");
        setMaxRating(ev.max_rating != null ? String(ev.max_rating) : "");
        setRatingSource(ev.rating_source ?? "");
        setMinAge(ev.min_age != null ? String(ev.min_age) : "");
        setMaxAge(ev.max_age != null ? String(ev.max_age) : "");

        // Pull match counts so we know whether to warn on save.
        const { data: ms } = await supabase
          .from("matches")
          .select("status")
          .eq("event_id", ev.id);
        if (cancelled) return;
        const list = ms ?? [];
        setMatchStats({
          total: list.length,
          inProgress: list.filter((m) => m.status === "in_progress").length,
          completed: list.filter((m) => m.status === "completed").length,
        });
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
      teams_advancing_to_playoff: clampInt(teamsAdvancing, 0, 0, 64),
      playoff_rounds: clampInt(playoffRounds, 1, 1, 4),
      medal_match_format: medalMatchFormat,
      medal_points_to_win: clampInt(medalPointsToWin, 15, 1, 99),
      medal_win_by: clampInt(medalWinBy, 2, 1, 9),
      medal_minutes_per_game: clampInt(medalMinutesPerGame, 20, 1, 120),
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
    return <div style={{ color: "#666", fontSize: 14 }}>Loading…</div>;
  if (!tournament) {
    return <div style={{ color: "#666", fontSize: 14 }}>Loading…</div>;
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
    <div style={{ maxWidth: 720 }}>
      <Link
        to={`/admin/${org.slug}/tournaments/${tournamentSlug}${mode === "edit" && event ? `/events/${event.id}` : ""}`}
        style={{ color: "#2563eb", textDecoration: "none", fontSize: 13 }}
      >
        ← {mode === "edit" && event ? event.name : tournament.name}
      </Link>
      <header style={{ margin: "12px 0 24px" }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>
          {mode === "create" ? "New event" : "Edit event"}
        </h1>
        <p style={{ color: "#666", margin: "4px 0 0", fontSize: 14 }}>
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
                background: "#fff",
                border: "1px solid #e5e7eb",
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
                    background: "#fffbeb",
                    border: "1px solid #fde68a",
                    borderRadius: 6,
                    color: "#92400e",
                    fontSize: 12,
                  }}
                >
                  {playoffWarning}
                </div>
              )}

              {/* Medal match format — separated from pool scoring
                  because medal games often play longer (15 win-by-2,
                  best-of-3) than pool games. */}
              <div
                style={{
                  marginTop: 4,
                  paddingTop: 12,
                  borderTop: "1px dashed #e5e7eb",
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#444",
                    marginBottom: 8,
                  }}
                >
                  Medal match format
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
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 6,
            color: "#991b1b",
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
        color: "#444",
      }}
    >
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        style={{ marginTop: 3 }}
      />
      <span>
        <span style={{ fontWeight: 500 }}>{label}</span>
        {hint && (
          <span
            style={{
              display: "block",
              fontSize: 12,
              color: "#888",
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
        background: "#fafafa",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h2>
        {subtitle && (
          <p style={{ margin: "4px 0 0", color: "#666", fontSize: 12 }}>
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
        color: "#555",
      }}
    >
      <span>
        {label}
        {required && <span style={{ color: "#ef4444", marginLeft: 4 }}>*</span>}
      </span>
      {children}
      {hint && (
        <span style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
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

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 13,
  fontFamily: "inherit",
  width: "100%",
  background: "#fff",
};

function primaryBtn(busy: boolean): CSSProperties {
  return {
    padding: "10px 20px",
    background: busy ? "#9ca3af" : "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 500,
    cursor: busy ? "not-allowed" : "pointer",
    fontFamily: "inherit",
  };
}

const secondaryBtn: CSSProperties = {
  padding: "10px 20px",
  background: "#fff",
  color: "#555",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  cursor: "pointer",
  fontFamily: "inherit",
};
