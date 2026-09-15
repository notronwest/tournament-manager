import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { bytesToBase64, renderSummaryPdf, summaryPdfFilename } from "./summaryPdf";
import { buildTournamentSummary, type ReportHeader, type SummaryEvent } from "./tournamentSummary";
import type { EventRegistration, Match, Player } from "./bracketTeams";

// Node's Buffer is the base64 oracle; the app tsconfig has no node types,
// so declare the sliver we use.
declare const Buffer: {
  from(data: Uint8Array | number[]): { toString(encoding: "base64"): string };
  from(data: string, encoding: "base64"): Uint8Array;
};

// Fixtures — the same minimal shapes tournamentSummary.test.ts uses; only
// the fields the summary reads matter.

const player = (id: string, first: string, last: string): Player =>
  ({ id, first_name: first, last_name: last } as unknown as Player);

const reg = (id: string, eventId: string, playerId: string, partner: string | null = null): EventRegistration =>
  ({
    id,
    event_id: eventId,
    player_id: playerId,
    partner_registration_id: partner,
    status: "paid",
    registered_at: "2026-06-01T00:00:00Z",
    pool_index: null,
    seed: null,
    deleted_at: null,
  }) as unknown as EventRegistration;

const match = (o: Partial<Match> & { id: string; event_id: string }): Match =>
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

const header: ReportHeader = {
  tournamentName: "NH Baners — Fall Classic",
  orgName: "White Mountain Pickleball Club",
  // Local-time string so the filename's date is the same in any TZ.
  startsAt: "2026-09-15T09:00:00",
  endsAt: "2026-09-16T17:00:00",
  venueName: "Bethlehem Courts",
  venueAddress: "1 Main St, Bethlehem, NH 03574",
};

function twoEventSummary() {
  const players = [
    player("p1", "Ann", "Adams"),
    player("p2", "Bo", "Burke"),
    player("p3", "Cy", "Cole"),
    player("p4", "Di", "Dunn"),
    player("p5", "Ed", "Eng"),
    player("p6", "Flo", "Fox"),
  ];
  const regs1 = [
    reg("r1", "e1", "p1", "r2"),
    reg("r2", "e1", "p2", "r1"),
    reg("r3", "e1", "p3", "r4"),
    reg("r4", "e1", "p4", "r3"),
    reg("r5", "e1", "p5", "r6"),
    reg("r6", "e1", "p6", "r5"),
  ];
  const rr1 = [
    match({ id: "m1", event_id: "e1", team_a_reg_id: "r1", team_b_reg_id: "r3", team_a_score: 11, team_b_score: 9, winner_reg_id: "r1", court: "Court 1", updated_at: "2026-06-06T14:30:00Z" }),
    match({ id: "m2", event_id: "e1", team_a_reg_id: "r1", team_b_reg_id: "r5", team_a_score: 11, team_b_score: 0, winner_reg_id: "r1", court: "Court 1", updated_at: "2026-06-06T15:00:00Z" }),
    match({ id: "m3", event_id: "e1", team_a_reg_id: "r3", team_b_reg_id: "r5", team_a_score: 15, team_b_score: 13, winner_reg_id: "r3", court: "Court 2", updated_at: "2026-06-06T16:30:00Z" }),
  ];
  const regs2 = [reg("s1", "e2", "p1"), reg("s2", "e2", "p2"), reg("s3", "e2", "p3"), reg("s4", "e2", "p4")];
  const playoff2 = [
    match({ id: "g", event_id: "e2", stage: "playoff", round: 1, position: 0, team_a_reg_id: "s1", team_b_reg_id: "s2", team_a_score: 9, team_b_score: 11, winner_reg_id: "s2", court: "Court 3", updated_at: "2026-06-07T18:00:00Z" }),
    match({ id: "b", event_id: "e2", stage: "playoff", round: 1, position: 1, team_a_reg_id: "s3", team_b_reg_id: "s4", team_a_score: 11, team_b_score: 5, winner_reg_id: "s3", court: "Court 3", updated_at: "2026-06-07T17:00:00Z" }),
    match({ id: "pending", event_id: "e2", stage: "round_robin", status: "pending", team_a_reg_id: "s1", team_b_reg_id: "s3" }),
  ];
  // Event 3 has matches but nothing scored → "Not final" marker.
  const regs3 = [reg("u1", "e3", "p5"), reg("u2", "e3", "p6")];
  const open3 = [match({ id: "o1", event_id: "e3", status: "pending", team_a_reg_id: "u1", team_b_reg_id: "u2" })];
  const events = [
    event({ id: "e1", name: "Mixed 3.5", schedule_order: 1, min_rating: 3.5, max_rating: 4 }),
    event({ id: "e2", name: "Men's singles open", schedule_order: 2, status: "medal_round", format: "singles", gender: "men", bracket_type: "pool_then_bracket", teams_advancing_to_playoff: 4, playoff_rounds: 1 }),
    event({ id: "e3", name: "Women's singles 4.0+ 🏓", schedule_order: 3, status: "active", format: "singles", gender: "women", min_rating: 4 }),
  ];
  return buildTournamentSummary({
    events,
    regs: [...regs1, ...regs2, ...regs3],
    players,
    matches: [...rr1, ...playoff2, ...open3],
    timeZone: "UTC",
  });
}

// N round-robin singles brackets of three players each, all scored.
function manyEventSummary(n: number) {
  const players: Player[] = [];
  const regs: EventRegistration[] = [];
  const matches: Match[] = [];
  const events: SummaryEvent[] = [];
  for (let i = 0; i < n; i++) {
    const e = `e${i}`;
    events.push(event({ id: e, name: `Bracket ${i + 1} — Mixed ${3 + (i % 3) * 0.5}`, schedule_order: i, format: "singles" }));
    const ids = [0, 1, 2].map((k) => `${e}p${k}`);
    ids.forEach((pid, k) => {
      players.push(player(pid, `Player${i}`, `Number${k}`));
      regs.push(reg(`${e}r${k}`, e, pid));
    });
    const pairs: [number, number][] = [[0, 1], [0, 2], [1, 2]];
    pairs.forEach(([a, b], k) => {
      matches.push(
        match({
          id: `${e}m${k}`,
          event_id: e,
          team_a_reg_id: `${e}r${a}`,
          team_b_reg_id: `${e}r${b}`,
          team_a_score: 11,
          team_b_score: 5 + k,
          winner_reg_id: `${e}r${a}`,
          court: `Court ${(i % 6) + 1}`,
          updated_at: `2026-06-0${6 + (i % 2)}T${String(10 + (k % 8)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}:00Z`,
        }),
      );
    });
  }
  return buildTournamentSummary({ events, regs, players, matches, timeZone: "UTC" });
}

describe("renderSummaryPdf", () => {
  it("produces a real PDF with the report's content", async () => {
    const bytes = await renderSummaryPdf({
      header,
      summary: twoEventSummary(),
      note: "Thanks for hosting us — what a weekend.\n\nEvery podium is below.",
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(2048);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toBe("NH Baners — Fall Classic — Tournament summary");
  });

  it("survives an empty tournament and an empty note", async () => {
    const summary = buildTournamentSummary({ events: [], regs: [], players: [], matches: [], timeZone: "UTC" });
    const bytes = await renderSummaryPdf({ header: { ...header, venueName: null, venueAddress: null }, summary, note: "   " });
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it("breaks across pages when there are many brackets", async () => {
    const bytes = await renderSummaryPdf({ header, summary: manyEventSummary(30), note: "" });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});

describe("summaryPdfFilename", () => {
  it("kebabs the name and appends the start date", () => {
    expect(summaryPdfFilename(header)).toBe("nh-baners-fall-classic-2026-09-15-summary.pdf");
    expect(summaryPdfFilename({ ...header, tournamentName: "  Éte / Été!!  " })).toBe("ete-ete-2026-09-15-summary.pdf");
    expect(summaryPdfFilename({ ...header, tournamentName: "🏓🏓" })).toBe("tournament-2026-09-15-summary.pdf");
    expect(summaryPdfFilename({ ...header, startsAt: "not a date" })).toBe("nh-baners-fall-classic-summary.pdf");
  });

  it("only ever emits safe characters", () => {
    const name = summaryPdfFilename({ ...header, tournamentName: "A".repeat(200) + " & B" });
    expect(name).toMatch(/^[a-z0-9-]+\.pdf$/);
    expect(name.length).toBeLessThanOrEqual(60 + "-2026-09-15-summary.pdf".length);
  });
});

describe("bytesToBase64", () => {
  it("round-trips against Buffer for 100k random bytes", () => {
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe(Buffer.from(bytes).toString("base64"));
    expect(new Uint8Array(Buffer.from(b64, "base64"))).toEqual(bytes);
  });

  it("handles empty and odd-length input", () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
    expect(bytesToBase64(new Uint8Array([0, 255, 1]))).toBe(Buffer.from([0, 255, 1]).toString("base64"));
  });
});
