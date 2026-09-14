import { describe, it, expect } from "vitest";
import {
  buildTournamentSummary,
  eventFormatLine,
  fmtMinutes,
  type SummaryEvent,
} from "./tournamentSummary";
import type { EventRegistration, Match, Player } from "./bracketTeams";

// Fixture helpers — only the fields the summary reads are meaningful; the
// rest satisfy the generated row types.

const player = (id: string, first: string, last: string): Player =>
  ({ id, first_name: first, last_name: last } as unknown as Player);

const reg = (
  id: string,
  eventId: string,
  playerId: string,
  partner: string | null = null,
): EventRegistration =>
  ({
    id,
    event_id: eventId,
    player_id: playerId,
    partner_registration_id: partner,
    status: "paid",
    registered_at: `2026-06-01T00:00:00Z`,
    pool_index: null,
    seed: null,
    deleted_at: null,
  }) as unknown as EventRegistration;

const match = (
  o: Partial<Match> & { id: string; event_id: string },
): Match =>
  ({
    stage: "round_robin",
    round: 1,
    position: 0,
    status: "completed",
    court: null,
    scheduled_at: null,
    created_at: "2026-06-06T14:00:00Z",
    updated_at: "2026-06-06T15:00:00Z",
    team_a_reg_id: null,
    team_b_reg_id: null,
    team_a_score: null,
    team_b_score: null,
    winner_reg_id: null,
    ...o,
  }) as Match;

const event = (o: Partial<SummaryEvent> & { id: string; name: string }): SummaryEvent => ({
  format: "doubles",
  gender: "mixed",
  bracket_type: "round_robin",
  status: "complete",
  pool_count: 1,
  teams_advancing_to_playoff: 0,
  playoff_rounds: 0,
  min_rating: null,
  max_rating: null,
  min_age: null,
  max_age: null,
  scheduled_start_at: null,
  ...o,
});

const TZ = "UTC";

describe("eventFormatLine", () => {
  it("reads like a bracket description", () => {
    expect(
      eventFormatLine(
        event({
          id: "e",
          name: "x",
          gender: "mixed",
          format: "doubles",
          min_rating: 3.5,
          max_rating: 4,
          min_age: 50,
          bracket_type: "pool_then_bracket",
          pool_count: 2,
        }),
      ),
    ).toBe("Mixed doubles · 3.5–4.0 · 50+ · 2 pools + bracket");
    expect(
      eventFormatLine(event({ id: "e", name: "x", gender: "men", format: "singles" })),
    ).toBe("Men's singles · round robin");
  });
});

describe("buildTournamentSummary", () => {
  const players = [
    player("p1", "Ann", "Adams"),
    player("p2", "Bo", "Burke"),
    player("p3", "Cy", "Cole"),
    player("p4", "Di", "Dunn"),
    player("p5", "Ed", "Eng"),
    player("p6", "Flo", "Fox"),
  ];
  // Event 1: three doubles teams, round robin only.
  const regs1 = [
    reg("r1", "e1", "p1", "r2"),
    reg("r2", "e1", "p2", "r1"),
    reg("r3", "e1", "p3", "r4"),
    reg("r4", "e1", "p4", "r3"),
    reg("r5", "e1", "p5", "r6"),
    reg("r6", "e1", "p6", "r5"),
  ];
  // Captains are the lower reg ids: r1, r3, r5.
  const rr1 = [
    match({ id: "m1", event_id: "e1", team_a_reg_id: "r1", team_b_reg_id: "r3", team_a_score: 11, team_b_score: 9, winner_reg_id: "r1", court: "Court 1", updated_at: "2026-06-06T14:30:00Z" }),
    match({ id: "m2", event_id: "e1", team_a_reg_id: "r1", team_b_reg_id: "r5", team_a_score: 11, team_b_score: 0, winner_reg_id: "r1", court: "Court 1", updated_at: "2026-06-06T15:00:00Z" }),
    match({ id: "m3", event_id: "e1", team_a_reg_id: "r3", team_b_reg_id: "r5", team_a_score: 15, team_b_score: 13, winner_reg_id: "r3", court: "Court 2", updated_at: "2026-06-06T16:30:00Z" }),
  ];
  // Event 2: singles with a gold + bronze medal round (Ann plays again).
  const regs2 = [reg("s1", "e2", "p1"), reg("s2", "e2", "p2"), reg("s3", "e2", "p3"), reg("s4", "e2", "p4")];
  const playoff2 = [
    match({ id: "g", event_id: "e2", stage: "playoff", round: 1, position: 0, team_a_reg_id: "s1", team_b_reg_id: "s2", team_a_score: 9, team_b_score: 11, winner_reg_id: "s2", court: "Court 3", updated_at: "2026-06-07T18:00:00Z" }),
    match({ id: "b", event_id: "e2", stage: "playoff", round: 1, position: 1, team_a_reg_id: "s3", team_b_reg_id: "s4", team_a_score: 11, team_b_score: 5, winner_reg_id: "s3", court: "Court 3", updated_at: "2026-06-07T17:00:00Z" }),
    match({ id: "pending", event_id: "e2", stage: "round_robin", status: "pending", team_a_reg_id: "s1", team_b_reg_id: "s3" }),
  ];
  const events = [
    // Alphabetically "Men's" sorts first; schedule_order should win.
    event({ id: "e1", name: "Mixed 3.5", schedule_order: 1 }),
    event({ id: "e2", name: "Men's singles open", schedule_order: 2, status: "medal_round", format: "singles", gender: "men", bracket_type: "pool_then_bracket", teams_advancing_to_playoff: 4, playoff_rounds: 1 }),
  ];

  const summary = buildTournamentSummary({
    events,
    regs: [...regs1, ...regs2],
    players,
    matches: [...rr1, ...playoff2],
    timeZone: TZ,
  });

  it("counts players once across events, teams per event, and only scored matches", () => {
    expect(summary.headline).toMatchObject({
      players: 6,
      teams: 7,
      events: 2,
      eventsDecided: 2,
      matchesPlayed: 5,
      matchesTotal: 6,
      pointsScored: 20 + 11 + 28 + 20 + 16,
      courtsUsed: 3,
      days: 2,
      medalsAwarded: 6,
      multiEventPlayers: 4,
    });
  });

  it("uses round-robin standings as the podium when no playoff is configured", () => {
    const e1 = summary.events[0];
    expect(e1.name).toBe("Mixed 3.5");
    expect(e1.podiumSource).toBe("round_robin");
    expect(e1.podium).toEqual([
      { place: "gold", team: "Ann Adams / Bo Burke" },
      { place: "silver", team: "Cy Cole / Di Dunn" },
      { place: "bronze", team: "Ed Eng / Flo Fox" },
    ]);
    expect(e1.perfectRecords).toEqual(["Ann Adams / Bo Burke"]);
    expect(e1.complete).toBe(true);
    expect(e1.teamCount).toBe(3);
    expect(e1.playerCount).toBe(6);
  });

  it("uses the medal matches when they exist", () => {
    const e2 = summary.events[1];
    expect(e2.podiumSource).toBe("medal_matches");
    expect(e2.podium).toEqual([
      { place: "gold", team: "Bo Burke" },
      { place: "silver", team: "Ann Adams" },
      { place: "bronze", team: "Cy Cole" },
    ]);
    expect(e2.matchesPlayed).toBe(2);
    expect(e2.matchesTotal).toBe(3);
    expect(e2.complete).toBe(false);
  });

  it("buckets finishes into days and measures first-to-last score", () => {
    expect(summary.days.map((d) => [d.date, d.matches, d.spanMinutes])).toEqual([
      ["2026-06-06", 3, 120],
      ["2026-06-07", 2, 60],
    ]);
    expect(summary.headline.playMinutes).toBe(180);
    expect(summary.lastResultAt?.toISOString()).toBe("2026-06-07T18:00:00.000Z");
  });

  it("finds the fun facts", () => {
    const by = Object.fromEntries(summary.highlights.map((h) => [h.key, h]));
    expect(by["highest-scoring"].value).toBe("28 points");
    expect(by["highest-scoring"].detail).toContain("Cy Cole / Di Dunn def. Ed Eng / Flo Fox 15–13");
    expect(by["closest"].value).toBe("Decided by 2 points");
    expect(by["nail-biters"].value).toBe("3 matches");
    expect(by["biggest-win"].value).toBe("Won by 11 points");
    expect(by["shutouts"].value).toBe("1 match");
    expect(by["dominant"].value).toBe("Ann Adams / Bo Burke");
    expect(by["dominant"].detail).toContain("2–0 in pool play, +13");
    expect(by["perfect"].detail).toBe("Ann Adams / Bo Burke (Mixed 3.5)");
    expect(by["iron"].value).toBe("3 matches");
    // Ann, Bo, Cy and Di each played 3 (two pool games + a medal match).
    expect(by["iron"].detail).toBe("Ann Adams, Bo Burke, Cy Cole and 1 more");
    expect(by["multi-event"].value).toBe("4 players");
    expect(by["busiest-court"].value).toBe("Court 1, Court 3");
    expect(by["longest-day"].value).toBe("2 hr");
  });

  it("handles an empty tournament without throwing", () => {
    const empty = buildTournamentSummary({ events: [], regs: [], players: [], matches: [], timeZone: TZ });
    expect(empty.headline.players).toBe(0);
    expect(empty.highlights).toEqual([]);
    expect(empty.days).toEqual([]);
    expect(empty.lastResultAt).toBeNull();
  });

  it("reports no podium for an event with unscored matches", () => {
    const s = buildTournamentSummary({
      events: [event({ id: "e1", name: "x" })],
      regs: regs1,
      players,
      matches: [match({ id: "m", event_id: "e1", status: "pending", team_a_reg_id: "r1", team_b_reg_id: "r3" })],
      timeZone: TZ,
    });
    expect(s.events[0].podiumSource).toBe("none");
    expect(s.events[0].podium).toEqual([]);
    expect(s.headline.eventsDecided).toBe(0);
  });
});

describe("fmtMinutes", () => {
  it("formats hours and minutes", () => {
    expect(fmtMinutes(0)).toBe("0 min");
    expect(fmtMinutes(45)).toBe("45 min");
    expect(fmtMinutes(120)).toBe("2 hr");
    expect(fmtMinutes(135)).toBe("2 hr 15 min");
  });
});

describe("summaryAsText", () => {
  it("renders an email-ready plain-text twin", async () => {
    const { summaryAsText } = await import("./tournamentSummary");
    const s = buildTournamentSummary({ events: [], regs: [], players: [], matches: [], timeZone: TZ });
    const text = summaryAsText(
      {
        tournamentName: "Spring Smash",
        orgName: "WMPC",
        startsAt: "2026-06-06T14:00:00Z",
        endsAt: "2026-06-06T22:00:00Z",
        venueName: "Main Courts",
        venueAddress: null,
      },
      s,
      "  Thanks for having us.  ",
    );
    expect(text).toContain("Spring Smash — Tournament summary");
    expect(text).toContain("Main Courts");
    expect(text).toContain("Thanks for having us.");
    expect(text).toContain("• 0 players · 0 teams · 0 brackets");
    expect(text).toContain("Prepared by WMPC · Bert & Erne");
    expect(text).not.toContain("HIGHLIGHTS");
  });
});

describe("fmtDateRange", () => {
  it("collapses same-month ranges and keeps single days full", async () => {
    const { fmtDateRange } = await import("./tournamentSummary");
    expect(fmtDateRange("2026-06-06T12:00:00", "2026-06-07T12:00:00")).toBe("June 6–7, 2026");
    expect(fmtDateRange("2026-06-06T12:00:00", "2026-06-06T20:00:00")).toMatch(/June 6, 2026$/);
    expect(fmtDateRange("2026-06-30T12:00:00", "2026-07-01T12:00:00")).toMatch(/^June 30 – .*July 1, 2026$/);
  });
});
