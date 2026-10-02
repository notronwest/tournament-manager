import { describe, expect, it } from "vitest";
import { formatDurationShort, formatElapsed, plannedMinutesFor } from "./matchTiming";

describe("formatElapsed", () => {
  it("renders minutes:seconds under an hour", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(5)).toBe("0:05");
    expect(formatElapsed(754)).toBe("12:34");
    expect(formatElapsed(3599)).toBe("59:59");
  });
  it("adds hours and zero-pads minutes past an hour", () => {
    expect(formatElapsed(3600)).toBe("1:00:00");
    expect(formatElapsed(3725)).toBe("1:02:05");
  });
  it("never goes negative (clock skew) and floors fractions", () => {
    expect(formatElapsed(-3)).toBe("0:00");
    expect(formatElapsed(61.9)).toBe("1:01");
  });
});

describe("formatDurationShort", () => {
  it("rounds to whole minutes", () => {
    expect(formatDurationShort(754)).toBe("13 min");
    expect(formatDurationShort(29)).toBe("0 min");
  });
  it("switches to hours", () => {
    expect(formatDurationShort(3600)).toBe("1 h");
    expect(formatDurationShort(3725)).toBe("1 h 2 min");
  });
});

describe("plannedMinutesFor", () => {
  const event = { pool_minutes_per_game: 15 };
  it("prefers the match's own minutes (playoff rows carry theirs)", () => {
    expect(plannedMinutesFor({ stage: "playoff", match_minutes_per_game: 20 }, event)).toBe(20);
    expect(plannedMinutesFor({ stage: "round_robin", match_minutes_per_game: 12 }, event)).toBe(12);
  });
  it("falls back to the event's pool minutes for round robin only", () => {
    expect(plannedMinutesFor({ stage: "round_robin", match_minutes_per_game: null }, event)).toBe(15);
    expect(plannedMinutesFor({ stage: "playoff", match_minutes_per_game: null }, event)).toBeNull();
  });
  it("is null with no event", () => {
    expect(plannedMinutesFor({ stage: "round_robin", match_minutes_per_game: null }, null)).toBeNull();
  });
});
