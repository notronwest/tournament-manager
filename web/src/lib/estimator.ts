// Time-estimation math, shared between the stand-alone RR estimator
// tool and the per-tournament Schedule page.
//
// All functions take primitive inputs (numbers + enums) — no DB rows —
// so they're trivial to unit-test and equally valid against
// hypothetical/what-if inputs or real-event inputs.

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
  format: "single_game" | "best_of_3";
  minutesPerGame: number;
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
    totalMatches = semis + round2;
    totalMinutes =
      Math.ceil(semis / courts) * matchMinutes +
      Math.ceil(round2 / courts) * matchMinutes;
    structure = `${semis} semis → gold + bronze (${semis + round2} medal matches total)`;
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
