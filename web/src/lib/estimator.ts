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

// Two binding constraints:
//   * Court-bound: ceil(total / courts) * minutes
//   * Team-bound: (N - 1) * R * minutes — a team can play only one
//     game at a time, so each team's sequential game count is a hard
//     floor regardless of court count.
// The team-bound branch catches the "10 courts but only 5 teams can
// play simultaneously" case so the estimate doesn't overstate
// throughput.
export function estimatePoolPlay(i: PoolPlayInputs): PoolPlayResult {
  const courts = Math.max(1, i.courts);
  const pools = Math.max(1, i.pools);
  const teams = Math.max(2, i.teamsPerPool);
  const minutes = Math.max(1, i.minutesPerGame);
  const reps = Math.max(1, i.playEachOpponentTimes);

  const matchesPerPool = ((teams * (teams - 1)) / 2) * reps;
  const totalMatches = pools * matchesPerPool;
  const gamesPerTeam = (teams - 1) * reps;

  const courtRounds = Math.ceil(totalMatches / courts);
  const courtBoundMinutes = courtRounds * minutes;
  const teamBoundMinutes = gamesPerTeam * minutes;
  const totalMinutes = Math.max(courtBoundMinutes, teamBoundMinutes);
  const bindingConstraint: "court" | "team" =
    teamBoundMinutes > courtBoundMinutes ? "team" : "court";

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
    courtRounds,
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
