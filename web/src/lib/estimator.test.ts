import { describe, it, expect } from "vitest";
import {
  estimatePoolPlay,
  estimateMedalRound,
  estimateEvent,
  fmtDuration,
} from "./estimator";

describe("estimatePoolPlay", () => {
  it("counts bye rounds: 5 teams playing twice on 4 courts need 10 rounds", () => {
    const r = estimatePoolPlay({
      courts: 4,
      pools: 1,
      teamsPerPool: 5,
      minutesPerGame: 15,
      playEachOpponentTimes: 2,
    });
    expect(r.matchesPerPool).toBe(20);
    expect(r.gamesPerTeam).toBe(8);
    expect(r.courtRounds).toBe(10); // only 2 matches can run at once
    expect(r.totalMinutes).toBe(150);
    expect(r.bindingConstraint).toBe("team");
  });

  it("is court-bound when courts are scarcer than team concurrency", () => {
    const r = estimatePoolPlay({
      courts: 2,
      pools: 1,
      teamsPerPool: 8,
      minutesPerGame: 20,
      playEachOpponentTimes: 1,
    });
    expect(r.matchesPerPool).toBe(28);
    expect(r.courtRounds).toBe(14);
    expect(r.totalMinutes).toBe(280);
    expect(r.bindingConstraint).toBe("court");
    expect(r.utilization).toBeCloseTo(1);
  });

  it("splits courts across pools that run in parallel", () => {
    const r = estimatePoolPlay({
      courts: 4,
      pools: 2,
      teamsPerPool: 4,
      minutesPerGame: 15,
      playEachOpponentTimes: 1,
    });
    expect(r.totalMatches).toBe(12);
    expect(r.courtRounds).toBe(3); // 6 matches per pool, 2 at a time
    expect(r.totalMinutes).toBe(45);
  });
});

describe("estimateMedalRound", () => {
  it("one round: pairwise medal matches in parallel", () => {
    const r = estimateMedalRound({
      courts: 4,
      teamsAdvancing: 4,
      rounds: 1,
      format: "single_game",
      minutesPerGame: 20,
    });
    expect(r.totalMatches).toBe(2);
    expect(r.totalMinutes).toBe(20);
  });

  it("two rounds: semis use the semifinal settings, the final the medal settings", () => {
    const r = estimateMedalRound({
      courts: 4,
      teamsAdvancing: 4,
      rounds: 2,
      format: "best_of_3",
      minutesPerGame: 20,
      semifinalFormat: "single_game",
      semifinalMinutesPerGame: 15,
    });
    expect(r.totalMatches).toBe(4);
    expect(r.totalMinutes).toBe(15 + 60); // semis 1×15, final worst-case 3×20
    expect(r.summary).toContain("15 min/game");
    expect(r.summary).toContain("20 min/game");
  });

  it("two rounds without semifinal overrides falls back to the medal settings", () => {
    const r = estimateMedalRound({
      courts: 1,
      teamsAdvancing: 4,
      rounds: 2,
      format: "single_game",
      minutesPerGame: 20,
    });
    expect(r.totalMinutes).toBe(2 * 20 + 2 * 20);
  });
});

describe("estimateEvent", () => {
  const event = {
    pool_count: 2,
    play_each_team_times: 1,
    pool_minutes_per_game: 15,
    teams_advancing_to_playoff: 4,
    playoff_rounds: 2,
    medal_match_format: "best_of_3" as const,
    medal_minutes_per_game: 20,
    semifinal_match_format: "single_game" as const,
    semifinal_minutes_per_game: 15,
  };

  it("adapts an events row: teams per pool, pool play + medal round", () => {
    const e = estimateEvent(event, 12, 4);
    expect(e.teamsPerPool).toBe(6);
    expect(e.pool.totalMatches).toBe(30);
    expect(e.medal?.totalMatches).toBe(4);
    expect(e.totalMinutes).toBe(e.pool.totalMinutes + (e.medal?.totalMinutes ?? 0));
  });

  it("falls back to one court when none are assigned", () => {
    const e = estimateEvent(event, 12, 0);
    expect(e.courts).toBe(1);
  });

  it("skips the medal round when nobody advances", () => {
    const e = estimateEvent({ ...event, teams_advancing_to_playoff: 0 }, 8, 4);
    expect(e.medal).toBeNull();
    expect(e.totalMinutes).toBe(e.pool.totalMinutes);
  });
});

describe("fmtDuration", () => {
  it("formats hours and minutes", () => {
    expect(fmtDuration(0)).toBe("—");
    expect(fmtDuration(45)).toBe("45 min");
    expect(fmtDuration(120)).toBe("2 hr");
    expect(fmtDuration(200)).toBe("3 hr 20 min");
  });
});
