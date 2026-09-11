// Time-estimation math for the Schedule page and the tournament-page event
// cards (the stand-alone "RR estimator" tool was retired 2026-09-11 — the
// estimate now lives where scheduling happens, fed by each event's own
// settings and its real team count).
//
// Estimates are TIME-based — minutes per game — never derived from points to
// win / win-by (Ron, 2026-09-11). The primitive functions take numbers +
// enums so they unit-test cleanly; estimateEvent adapts an events row.

// ─────────────────────────────────────────────────────────────────────
// Pool play
// ─────────────────────────────────────────────────────────────────────

export type PoolPlayInputs = {
  courts: number;
  // Equal-sized pools assumed. If the caller has unequal pools they
  // should compute per-pool durations and sum/max appropriately.
  pools: number;
  teamsPerPool: number;
  minutesPerGame: number;
  playEachOpponentTimes: number;
};

export type PoolPlayResult = {
  matchesPerPool: number;
  totalMatches: number;
  gamesPerTeam: number;
  courtBoundMinutes: number;
  teamBoundMinutes: number;
  totalMinutes: number;
  courtRounds: number;
  bindingConstraint: "court" | "team";
  utilization: number;
};

// Real-world pool-play scheduling has two parallelism caps that
// compete:
//
//   * Courts available (per pool).
//   * floor(teams / 2) — a pool of N teams can play at most N/2
//     simultaneous matches; the rest of the teams sit out that
//     round. With 5 teams you get 2 parallel matches at most, even
//     if there are 100 courts.
//
// The OLD math took max(courtBound, teamBound) where teamBound was
// `gamesPerTeam × minutes` — that's a per-team lower bound, not the
// schedule total. It silently underestimates whenever
// floor(teams/2) < courts, because it ignores bye rounds: with 5
// teams playing each other twice you have 20 matches and only 2 can
// run at a time, so the schedule needs 10 rounds (not 8) — each
// team has byes.
//
// New math:
//   effectiveCourts = min(courts/pools, floor(teamsPerPool / 2))
//   rounds          = ceil(matchesPerPool / effectiveCourts)
//   totalMinutes    = rounds × minutesPerGame
//
// bindingConstraint tells the caller which lever would actually
// shorten the schedule:
//   "court" — court count is the bottleneck; adding courts helps.
//   "team"  — team concurrency is the bottleneck; adding courts is
//             pointless until you add teams.
export function estimatePoolPlay(i: PoolPlayInputs): PoolPlayResult {
  const courts = Math.max(1, i.courts);
  const pools = Math.max(1, i.pools);
  const teams = Math.max(2, i.teamsPerPool);
  const minutes = Math.max(1, i.minutesPerGame);
  const reps = Math.max(1, i.playEachOpponentTimes);

  const matchesPerPool = ((teams * (teams - 1)) / 2) * reps;
  const totalMatches = pools * matchesPerPool;
  const gamesPerTeam = (teams - 1) * reps;

  // Courts are split evenly across pools that run in parallel.
  const courtsPerPool = Math.max(1, Math.floor(courts / pools));
  const teamCapPerPool = Math.floor(teams / 2);
  const parallelismPerPool = Math.max(
    1,
    Math.min(courtsPerPool, teamCapPerPool),
  );

  // All pools run in parallel and have equal size, so the total
  // pool-play duration is just one pool's schedule.
  const rounds = Math.ceil(matchesPerPool / parallelismPerPool);
  const totalMinutes = rounds * minutes;

  // Diagnostic numbers kept on the result for the UI's "why is it
  // taking this long?" copy.
  const courtBoundMinutes =
    Math.ceil(matchesPerPool / courtsPerPool) * minutes;
  const teamBoundMinutes = gamesPerTeam * minutes;
  const bindingConstraint: "court" | "team" =
    teamCapPerPool < courtsPerPool ? "team" : "court";

  const utilization = Math.min(
    1,
    (totalMatches * minutes) / (totalMinutes * courts),
  );

  return {
    matchesPerPool,
    totalMatches,
    gamesPerTeam,
    courtBoundMinutes,
    teamBoundMinutes,
    totalMinutes,
    courtRounds: rounds,
    bindingConstraint,
    utilization,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Medal round
// ─────────────────────────────────────────────────────────────────────

export type MedalInputs = {
  courts: number;
  teamsAdvancing: number;
  rounds: 1 | 2;
  // The final (gold + bronze) — or the only round when rounds === 1.
  format: "single_game" | "best_of_3";
  minutesPerGame: number;
  // Semifinal round when rounds === 2. Events carry their own semifinal
  // settings (semifinal_match_format / semifinal_minutes_per_game); when
  // omitted the medal settings apply to both rounds.
  semifinalFormat?: "single_game" | "best_of_3";
  semifinalMinutesPerGame?: number;
};

export type MedalResult = {
  totalMatches: number;
  totalMinutes: number;
  summary: string;
};

// Two supported structures, matching the playoff generator:
//   * 1 round: pairwise (1v2, 3v4, …) — N/2 parallel medal matches.
//   * 2 rounds (top-4 only): semis (1v4, 2v3) → gold + bronze.
// best_of_3 is planned as worst-case 3 games per match so scheduling
// has headroom rather than overrunning when matches go to 3.
export function estimateMedalRound(i: MedalInputs): MedalResult {
  const courts = Math.max(1, i.courts);
  const advancing = Math.max(2, i.teamsAdvancing);
  const minutes = Math.max(1, i.minutesPerGame);
  const gamesPerMatch = i.format === "best_of_3" ? 3 : 1;
  const matchMinutes = gamesPerMatch * minutes;

  let totalMatches: number;
  let totalMinutes: number;
  let structure: string;

  if (i.rounds === 1) {
    const matches = Math.floor(advancing / 2);
    totalMatches = matches;
    totalMinutes = Math.ceil(matches / courts) * matchMinutes;
    structure = `${matches} medal match${matches === 1 ? "" : "es"} in 1 round`;
  } else {
    const semis = Math.floor(advancing / 2);
    const round2 = 2;
    const semiMinutes = Math.max(1, i.semifinalMinutesPerGame ?? minutes);
    const semiGames = (i.semifinalFormat ?? i.format) === "best_of_3" ? 3 : 1;
    totalMatches = semis + round2;
    totalMinutes =
      Math.ceil(semis / courts) * semiGames * semiMinutes +
      Math.ceil(round2 / courts) * matchMinutes;
    const semiFmt = semiGames === 3 ? "best of 3" : "1 game";
    const finalFmt = gamesPerMatch === 3 ? "best of 3" : "1 game";
    structure = `${semis} semis (${semiFmt}, ${semiMinutes} min/game) → gold + bronze (${finalFmt}, ${minutes} min/game)`;
    return { totalMatches, totalMinutes, summary: `${structure}.` };
  }

  const fmt = i.format === "best_of_3" ? "best of 3" : "1 game";
  return {
    totalMatches,
    totalMinutes,
    summary: `${structure}; ${fmt}, ${minutes} min/game.`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Display
// ─────────────────────────────────────────────────────────────────────

export function fmtDuration(mins: number): string {
  if (mins < 1) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

// ─────────────────────────────────────────────────────────────────────
// Per-event adapter — the one place an events row becomes an estimate
// ─────────────────────────────────────────────────────────────────────

// The subset of an events row the estimate depends on. Kept as a pick so
// callers can pass a full Row or a hand-built object.
export type EstimableEvent = {
  pool_count: number;
  play_each_team_times: number;
  pool_minutes_per_game: number;
  teams_advancing_to_playoff: number;
  playoff_rounds: number;
  medal_match_format: "single_game" | "best_of_3";
  medal_minutes_per_game: number;
  semifinal_match_format: "single_game" | "best_of_3";
  semifinal_minutes_per_game: number;
};

export type EventEstimate = {
  teamsPerPool: number;
  courts: number;
  pool: PoolPlayResult;
  medal: MedalResult | null;
  totalMinutes: number;
};

// teamCount = teams that hold a spot (the roster's count). courts = courts
// assigned to the event (callers fall back to 1 when none are, so the
// estimate still renders — pessimistically).
export function estimateEvent(
  event: EstimableEvent,
  teamCount: number,
  courts: number,
): EventEstimate {
  const courtsForEvent = Math.max(1, courts);
  const teamsPerPool =
    event.pool_count > 0
      ? Math.max(2, Math.ceil(teamCount / event.pool_count))
      : Math.max(2, teamCount);
  const pool = estimatePoolPlay({
    courts: courtsForEvent,
    pools: event.pool_count,
    teamsPerPool,
    minutesPerGame: event.pool_minutes_per_game,
    playEachOpponentTimes: event.play_each_team_times,
  });
  const medal =
    event.teams_advancing_to_playoff > 0
      ? estimateMedalRound({
          courts: courtsForEvent,
          teamsAdvancing: event.teams_advancing_to_playoff,
          rounds: event.playoff_rounds === 2 ? 2 : 1,
          format: event.medal_match_format,
          minutesPerGame: event.medal_minutes_per_game,
          semifinalFormat: event.semifinal_match_format,
          semifinalMinutesPerGame: event.semifinal_minutes_per_game,
        })
      : null;
  return {
    teamsPerPool,
    courts: courtsForEvent,
    pool,
    medal,
    totalMinutes: pool.totalMinutes + (medal?.totalMinutes ?? 0),
  };
}

// Plain-language "why is pool play this long" — which lever actually
// shortens it. Copy carried over from the retired estimator tool.
export function poolPlayExplanation(
  e: EventEstimate,
  event: Pick<EstimableEvent, "pool_count" | "pool_minutes_per_game">,
): string {
  const pools = Math.max(1, event.pool_count);
  const courtsPerPool = Math.max(1, Math.floor(e.courts / pools));
  const concurrent = Math.floor(e.teamsPerPool / 2);
  if (e.pool.bindingConstraint === "court") {
    return `${e.pool.courtRounds} rounds × ${event.pool_minutes_per_game} min — courts at full use. More courts would shorten this.`;
  }
  return `${e.pool.courtRounds} rounds × ${event.pool_minutes_per_game} min. Team concurrency is the limit: ${e.teamsPerPool} teams in a pool can play at most ${concurrent} matches at once, so only ${concurrent} of the ${courtsPerPool} court${courtsPerPool === 1 ? "" : "s"} per pool are busy. More courts won't help — larger pools or fewer repeats would.`;
}

export function utilizationLabel(utilization: number): string {
  if (utilization > 0.95) return "Near-perfect — courts run almost continuously.";
  if (utilization > 0.75) return "Healthy — a few idle courts here and there.";
  return "Low — courts sit idle waiting for the same teams to finish. Fewer courts or larger pools would use them better.";
}
