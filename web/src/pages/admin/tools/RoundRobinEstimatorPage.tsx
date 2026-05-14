import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  estimateMedalRound,
  estimatePoolPlay,
  fmtDuration,
} from "../../../lib/estimator";

// Round-robin time estimator. Stand-alone planning tool for tournament
// directors — no schema involvement, no persisted state, just live
// math on the inputs. Useful for fitting an event into a venue's
// rental window before any matches are generated.
//
// Math notes:
//
//   Per pool with N teams playing each other R times:
//     matches_per_pool = (N choose 2) * R = N*(N-1)/2 * R
//
//   Total matches across P pools (equal-sized):
//     total = P * N*(N-1)/2 * R
//
//   Two binding constraints on duration:
//
//     1. Court-bound — only `courts` games can run in parallel.
//          ceil(total / courts) * minutes
//
//     2. Team-bound — within a pool, a team can play only one match
//        at a time. Each team plays (N-1)*R games sequentially.
//          (N - 1) * R * minutes
//        (Same across pools when pools are equal-sized; with multi-
//        pool we take the max across pools, which here = the single
//        teams-per-pool number.)
//
//   Estimate = max(courtBound, teamBound).
//
// The team-bound branch catches the "we have more courts than teams
// can use simultaneously" case — e.g. 10 courts but a pool of 10
// teams can only run 5 matches at once.
export default function RoundRobinEstimatorPage() {
  const [courts, setCourts] = useState(4);
  const [pools, setPools] = useState(1);
  const [teamsPerPool, setTeamsPerPool] = useState(6);
  const [minutesPerGame, setMinutesPerGame] = useState(15);
  const [playEachOpponentTimes, setPlayEachOpponentTimes] = useState(1);

  // Medal-round add-on. Defaults off; flipping the toggle on uses
  // sensible single-game defaults (15-minute games, top 4 in 1 round).
  const [includeMedal, setIncludeMedal] = useState(false);
  const [teamsAdvancing, setTeamsAdvancing] = useState(4);
  const [medalRounds, setMedalRounds] = useState<1 | 2>(1);
  const [medalFormat, setMedalFormat] = useState<"single_game" | "best_of_3">(
    "single_game",
  );
  const [medalMinutesPerGame, setMedalMinutesPerGame] = useState(20);

  const estimate = useMemo(
    () =>
      estimatePoolPlay({
        courts,
        pools,
        teamsPerPool,
        minutesPerGame,
        playEachOpponentTimes,
      }),
    [courts, pools, teamsPerPool, minutesPerGame, playEachOpponentTimes],
  );

  const medal = useMemo(() => {
    if (!includeMedal) return null;
    return estimateMedalRound({
      courts,
      teamsAdvancing,
      rounds: medalRounds,
      format: medalFormat,
      minutesPerGame: medalMinutesPerGame,
    });
  }, [includeMedal, courts, teamsAdvancing, medalRounds, medalFormat, medalMinutesPerGame]);

  const totalMinutes = estimate.totalMinutes + (medal?.totalMinutes ?? 0);

  return (
    <div style={{ maxWidth: 760 }}>
      <h1 style={{ margin: 0, fontSize: 22 }}>Round-robin time estimate</h1>
      <p style={{ color: "#666", margin: "4px 0 24px", fontSize: 14 }}>
        Plug in your event setup to see how long pool play will take. The
        estimate accounts for both court availability and the fact that a
        team can only play one game at a time.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        <FieldGroup title="Inputs">
          <NumberField
            label="Number of courts"
            value={courts}
            onChange={setCourts}
            min={1}
            max={32}
          />
          <NumberField
            label="Number of pools"
            value={pools}
            onChange={setPools}
            min={1}
            max={16}
            hint="Pools play in parallel and share the same court pool."
          />
          <NumberField
            label="Teams in each pool"
            value={teamsPerPool}
            onChange={setTeamsPerPool}
            min={2}
            max={32}
            hint="Assumes pools are evenly split."
          />
          <NumberField
            label="Minutes per game"
            value={minutesPerGame}
            onChange={setMinutesPerGame}
            min={1}
            max={120}
            hint="Include changeover/scorecard time, not just gameplay."
          />
          <NumberField
            label="Play each opponent (times)"
            value={playEachOpponentTimes}
            onChange={setPlayEachOpponentTimes}
            min={1}
            max={5}
            hint="Most pool play is once; some formats double-round."
          />

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 8,
              paddingTop: 8,
              borderTop: "1px dashed #e5e7eb",
              fontSize: 13,
              color: "#444",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={includeMedal}
              onChange={(e) => setIncludeMedal(e.target.checked)}
            />
            Include medal round
          </label>

          {includeMedal && (
            <>
              <NumberField
                label="Teams advancing"
                value={teamsAdvancing}
                onChange={setTeamsAdvancing}
                min={2}
                max={16}
                hint="Must be even for 1-round playoffs. Top-4 only for 2-round bracket."
              />
              <label
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  fontSize: 12,
                  color: "#555",
                }}
              >
                <span>Number of rounds</span>
                <select
                  value={medalRounds}
                  onChange={(e) =>
                    setMedalRounds(parseInt(e.target.value, 10) as 1 | 2)
                  }
                  style={inputStyle}
                >
                  <option value={1}>1 round (pairwise medal matches)</option>
                  <option value={2}>2 rounds (semis + final + bronze)</option>
                </select>
              </label>
              <label
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  fontSize: 12,
                  color: "#555",
                }}
              >
                <span>Match format</span>
                <select
                  value={medalFormat}
                  onChange={(e) =>
                    setMedalFormat(e.target.value as typeof medalFormat)
                  }
                  style={inputStyle}
                >
                  <option value="single_game">1 game per match</option>
                  <option value="best_of_3">Best of 3 (up to 3 games)</option>
                </select>
              </label>
              <NumberField
                label="Minutes per medal game"
                value={medalMinutesPerGame}
                onChange={setMedalMinutesPerGame}
                min={1}
                max={120}
                hint="Medal games usually run longer than pool games (e.g. 15 win-by-2)."
              />
            </>
          )}
        </FieldGroup>

        <FieldGroup title="Estimate">
          <Stat
            label="Total matches"
            value={estimate.totalMatches.toLocaleString()}
            sub={`${pools} pool${pools === 1 ? "" : "s"} × ${estimate.matchesPerPool} match${estimate.matchesPerPool === 1 ? "" : "es"} per pool`}
          />
          <Stat
            label="Pool play duration"
            value={fmtDuration(estimate.totalMinutes)}
            sub={
              estimate.bindingConstraint === "court"
                ? `Court-bound: ${estimate.courtRounds} rounds of play with all courts in use.`
                : `Team-bound: each team plays ${estimate.gamesPerTeam} games sequentially. You have more courts than teams can fill at once.`
            }
          />
          {medal && (
            <Stat
              label="Medal round duration"
              value={fmtDuration(medal.totalMinutes)}
              sub={medal.summary}
            />
          )}
          {medal && (
            <Stat
              label="Total event duration"
              value={fmtDuration(totalMinutes)}
              sub="Pool play + medal round, run back-to-back."
              emphasize
            />
          )}
          {!medal && (
            <Stat
              label="Total event duration"
              value={fmtDuration(totalMinutes)}
              sub="Toggle “Include medal round” to add bracket time."
              emphasize
            />
          )}
          <Stat
            label="Games per team (pool play)"
            value={String(estimate.gamesPerTeam)}
          />
          <Stat
            label="Court utilization (pool play)"
            value={`${Math.round(estimate.utilization * 100)}%`}
            sub={
              estimate.utilization > 0.95
                ? "Near-perfect — courts run almost continuously."
                : estimate.utilization > 0.75
                  ? "Healthy — a few idle courts here and there."
                  : "Low — courts will sit idle waiting for the same teams to play their next game. Consider fewer courts or larger pools."
            }
          />
        </FieldGroup>
      </div>

      <div
        style={{
          marginTop: 24,
          padding: 12,
          background: "#fafafa",
          border: "1px solid #e5e7eb",
          borderRadius: 6,
          fontSize: 12,
          color: "#555",
          lineHeight: 1.6,
        }}
      >
        <strong>How this is calculated.</strong> Each pool of N teams
        generates N(N−1)/2 matches per repetition. Pool play needs at
        least <code>(N − 1) × repetitions</code> games per team played
        sequentially, regardless of how many courts you have — that's
        the team-bound floor. The court-bound floor is{" "}
        <code>ceil(total ÷ courts)</code> rounds. The longer of the two
        is what you'll actually experience.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// UI bits
// ─────────────────────────────────────────────────────────────────────

function FieldGroup({
  title,
  children,
}: {
  title: string;
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
        gap: 14,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h2>
      {children}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  hint?: string;
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
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value || "0", 10);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        style={inputStyle}
      />
      {hint && (
        <span style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
          {hint}
        </span>
      )}
    </label>
  );
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
        padding: 10,
        background: emphasize ? "#eff6ff" : "#fff",
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
          fontSize: emphasize ? 22 : 16,
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

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #e2e2e2",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  background: "#fff",
  maxWidth: 160,
};
