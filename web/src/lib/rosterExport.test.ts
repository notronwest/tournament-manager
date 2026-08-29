import { describe, it, expect } from "vitest";
import {
  buildRoster,
  rosterToCsv,
  rosterFilename,
  eventsWhere,
  type RosterEventGroup,
} from "./rosterExport";
import type { PendingInvite } from "./partnerInvites";

const p = (id: string, first: string, last: string, email: string | null = null) => ({
  id, first_name: first, last_name: last, email, phone: null, city: null, state: null,
});

const groups: RosterEventGroup[] = [
  {
    event: { id: "e1", name: "Mixed 3.5", format: "doubles", gender: "mixed" },
    regs: [
      { id: "r1", partner_registration_id: "r2", partner_status: "confirmed", status: "paid", player: p("a", "Ada", "Lovelace", "ada@x.com") },
      { id: "r2", partner_registration_id: "r1", partner_status: "confirmed", status: "paid", player: p("g", "Grace", "Hopper") },
      { id: "r3", partner_registration_id: null, partner_status: "seeking", status: "pending_payment", player: p("v", "Vergie", "Slover") },
      { id: "r4", partner_registration_id: null, partner_status: "pending", status: "paid", player: p("t", "Alan", "Turing") },
      { id: "r5", partner_registration_id: null, partner_status: "solo", status: "withdrawn", player: p("w", "Gone", "Away") },
    ],
  },
];

const invites: PendingInvite[] = [
  {
    inviteId: "i1", eventId: "e1", eventName: "Mixed 3.5",
    inviterName: "Alan Turing", inviteeName: "Dana Reyes", inviteeEmail: "dana@x.com",
    createdAt: "2026-08-01T00:00:00Z", inviterStatus: "paid", inviterPaid: true,
  },
];

describe("buildRoster", () => {
  const roster = buildRoster("Summer Slam", groups, invites);

  it("drops withdrawn/cancelled/refunded registrations", () => {
    expect(roster.everyone.map((e) => e.fullName)).not.toContain("Gone Away");
    expect(roster.everyone).toHaveLength(4);
  });

  it("sorts everyone by last name then first", () => {
    expect(roster.everyone.map((e) => e.lastName)).toEqual([
      "Hopper", "Lovelace", "Slover", "Turing",
    ]);
  });

  it("separates 'needs a partner' from 'waiting to hear back'", () => {
    expect(roster.needsPartner.map((e) => e.fullName)).toEqual(["Vergie Slover"]);
    expect(roster.awaitingReply.map((e) => e.fullName)).toEqual(["Alan Turing"]);
  });

  it("names who a pending invite went to", () => {
    const turing = roster.awaitingReply[0];
    expect(eventsWhere(turing, "pending")[0].invitedName).toBe("Dana Reyes");
  });

  it("resolves confirmed team-mates both ways", () => {
    const ada = roster.everyone.find((e) => e.lastName === "Lovelace")!;
    const grace = roster.everyone.find((e) => e.lastName === "Hopper")!;
    expect(ada.events[0].partnerName).toBe("Grace Hopper");
    expect(grace.events[0].partnerName).toBe("Ada Lovelace");
  });

  it("uses plain-language payment wording", () => {
    const vergie = roster.everyone.find((e) => e.lastName === "Slover")!;
    expect(vergie.events[0].paymentLabel).toBe("Not paid yet");
  });
});

describe("rosterToCsv", () => {
  const csv = rosterToCsv(buildRoster("Summer Slam", groups, invites));
  const lines = csv.split("\r\n");

  it("leads with the contact-import header labels so it round-trips", () => {
    expect(lines[0]).toContain('"First name","Last name","Email","Phone","City","State"');
  });

  it("writes one row per person, not per registration", () => {
    expect(lines).toHaveLength(5); // header + 4 people
  });

  it("carries the partner columns", () => {
    const turing = lines.find((l) => l.includes("Turing"))!;
    expect(turing).toContain("Dana Reyes (Mixed 3.5)");
    const vergie = lines.find((l) => l.includes("Slover"))!;
    expect(vergie).toContain('"Mixed 3.5","",""'); // events, seeking, waiting
  });

  it("escapes quotes and commas", () => {
    const tricky = buildRoster("T", [{
      event: { id: "e", name: 'Big "A" Event, 3.5', format: "singles", gender: "open" },
      regs: [{ id: "r", partner_registration_id: null, partner_status: "solo", status: "paid", player: p("x", "Jo", "O'Neil") }],
    }], []);
    expect(rosterToCsv(tricky)).toContain('"Big ""A"" Event, 3.5"');
  });

  it("neutralises a formula-injection attempt in a name", () => {
    const evil = buildRoster("T", [{
      event: { id: "e", name: "E", format: "singles", gender: "open" },
      regs: [{ id: "r", partner_registration_id: null, partner_status: "solo", status: "paid", player: p("x", "=cmd|'/c calc'!A0", "Evil") }],
    }], []);
    expect(rosterToCsv(evil)).toContain(`"'=cmd`);
  });
});

describe("rosterFilename", () => {
  it("slugifies the tournament and stamps the date", () => {
    expect(rosterFilename("5th Annual Pickleball Angels!", new Date("2026-08-27T12:00:00Z")))
      .toBe("attendees-5th-annual-pickleball-angels-2026-08-27.csv");
  });

  it("falls back when the name has no usable characters", () => {
    expect(rosterFilename("!!!", new Date("2026-01-02T00:00:00Z")))
      .toBe("attendees-tournament-2026-01-02.csv");
  });
});
