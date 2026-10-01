import { describe, expect, it } from "vitest";
import {
  parseAttendeesPartners,
  parseAttendeeBlock,
  buildPartnerLinks,
  applyPartnerLinks,
  normalizePhone,
  parsePaginationTotal,
  splitAttendeeBlocks,
  fetchAttendeesPartnersPages,
  type AttendeeEntry,
  type LinkPlayer,
  type PartnerLinkStore,
  type PartnerReg,
} from "./pbPartners";
import sampleText from "./__fixtures__/pb-attendees-partners.sample.txt?raw";

// The imported players that the registration import (#983) already created — keyed
// by the SAME full phones the Attendees page shows. Partners "Sc, R" and
// "Ghost, Nomatch" are deliberately NOT players (→ unlinked). All synthetic.
const PLAYERS: LinkPlayer[] = [
  { firstName: "Quen", lastName: "Alder", phone: "+1 5550000001" },
  { firstName: "Rowan", lastName: "Birch", phone: "1 (555) 000-0002" }, // different formatting, same last-10
  { firstName: "Sage", lastName: "Cedar", phone: "5550000003" }, // bare 10-digit
  { firstName: "Wren", lastName: "Dune", phone: "+1 5550000004" },
  { firstName: "Fenn", lastName: "Elm", phone: "+1 5550000005" },
  { firstName: "Glen", lastName: "Fir", phone: "+1 5550000006" },
  { firstName: "Iris", lastName: "Holly", phone: "+1 5550000007" },
  { firstName: "Kit", lastName: "Juniper", phone: "+1 5550000008" },
];

const entries = parseAttendeesPartners(sampleText);
const byOwner = (last: string) =>
  entries.find((e) => e.ownerName.last === last) as AttendeeEntry;

describe("parseAttendeesPartners — fixture", () => {
  it("splits the page into one block per attendee (ignoring pagination/rating lines)", () => {
    expect(splitAttendeeBlocks(sampleText)).toHaveLength(8);
    expect(entries).toHaveLength(8); // one registration entry per attendee here
  });

  it("parses a doubles entry: owner phone, division, partner name + full phone", () => {
    const e = byOwner("Alder");
    expect(e.format).toBe("doubles");
    expect(e.ownerName).toEqual({ last: "Alder", first: "Quen" });
    expect(e.ownerPhone).toBe("+1 5550000001");
    expect(e.divisionLabel).toBe("Mens Doubles Skill: (3.0 To 3.49)");
    expect(e.partnerName).toEqual({ last: "Birch", first: "Rowan" });
    expect(e.partnerPhone).toBe("+1 5550000002");
    expect(e.partnerWaitlisted).toBe(false);
  });

  it("flags a waitlisted partner and still reads the phone (WL: date ignored)", () => {
    const e = byOwner("Cedar");
    expect(e.partnerWaitlisted).toBe(true);
    expect(e.partnerName).toEqual({ last: "Dune", first: "Wren" });
    expect(e.partnerPhone).toBe("+1 5550000004");
    expect(e.divisionLabel).toBe("Mixed Doubles Skill: (3.5 To 3.99)");
  });

  it("reads a placeholder partner (no full profile) with a name but no phone", () => {
    const e = byOwner("Elm");
    expect(e.format).toBe("doubles");
    expect(e.partnerName).toEqual({ last: "Sc", first: "R" });
    expect(e.partnerPhone).toBeNull();
  });

  it("captures a partner phone with a non-US country code verbatim", () => {
    const e = byOwner("Fir");
    expect(e.partnerName).toEqual({ last: "Ghost", first: "Nomatch" });
    expect(e.partnerPhone).toBe("+93 6039312769");
  });

  it("treats a singles entry as having no partner", () => {
    const e = byOwner("Holly");
    expect(e.format).toBe("singles");
    expect(e.partnerName).toBeNull();
    expect(e.partnerPhone).toBeNull();
  });

  it("treats a doubles entry with no partner segment as partner-needed", () => {
    const e = byOwner("Juniper");
    expect(e.format).toBe("doubles");
    expect(e.partnerName).toBeNull();
  });

  it("parses an HTML variant (tags + bullet separators stripped)", () => {
    const html =
      "<div>Nova, Ash · Age: 30 Gender: M · +1 5551110000 · a***@ex.com · DUPR: 9</div>" +
      "<div>Self D: 3.0 S: 2.9 SS: 2.8</div>" +
      "<div>Self 3.0 Mens Doubles Skill: (3.0 To 3.49) Self 3.0 Pine, Bo +1 5551110001 b***@ex.com EVT: 2026-10-03</div>";
    const [e] = parseAttendeeBlock(html);
    expect(e.ownerName).toEqual({ last: "Nova", first: "Ash" });
    expect(e.ownerPhone).toBe("+1 5551110000");
    expect(e.partnerName).toEqual({ last: "Pine", first: "Bo" });
    expect(e.partnerPhone).toBe("+1 5551110001");
  });
});

describe("normalizePhone — last-10-digits join key", () => {
  it("collapses formatting to the last 10 digits", () => {
    expect(normalizePhone("+1 5550000001")).toBe("5550000001");
    expect(normalizePhone("1 (555) 000-0001")).toBe("5550000001");
    expect(normalizePhone("5550000001")).toBe("5550000001");
  });
  it("does NOT rescue a garbled 11-digit or foreign number to a real one", () => {
    expect(normalizePhone("+1 50826948222")).toBe("0826948222"); // 12 digits → last 10, won't match
    expect(normalizePhone("+93 6039312769")).toBe("6039312769");
  });
  it("returns null for too-short input", () => {
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe("parsePaginationTotal", () => {
  it("reads 'Total: X to Y of N'", () => {
    expect(parsePaginationTotal(sampleText)).toEqual({ from: 1, to: 8, total: 8 });
  });
  it("returns null when absent", () => {
    expect(parsePaginationTotal("no total line here")).toBeNull();
  });
});

describe("buildPartnerLinks — normalized-phone join + symmetric dedup", () => {
  const { pairs, unlinked } = buildPartnerLinks(entries, PLAYERS);

  it("dedups the symmetric listing to one pair per (division, unordered players)", () => {
    expect(pairs).toHaveLength(2); // Alder⇄Birch (D1), Cedar⇄Dune (D2) — not 4
  });

  it("keys pairs by normalized phone with high confidence on a phone match", () => {
    const d1 = pairs.find((p) => p.divisionKey.includes("mens doubles"));
    expect(d1).toBeTruthy();
    expect([d1!.phoneA, d1!.phoneB].sort()).toEqual(["5550000001", "5550000002"]);
    expect(d1!.confidence).toBe("high");
  });

  it("propagates the waitlist flag across the symmetric sides", () => {
    const d2 = pairs.find((p) => p.divisionKey.includes("mixed doubles"));
    expect(d2!.waitlisted).toBe(true); // only Cedar's side showed it; OR-propagated
  });

  it("records non-matching partners as unlinked with a reason (never guessed)", () => {
    const reasons = unlinked.map((u) => u.reason).sort();
    expect(reasons).toEqual(
      ["partner_needed", "partner_no_phone", "partner_phone_unmatched"].sort(),
    );
    expect(unlinked.find((u) => u.reason === "partner_no_phone")!.divisionLabel).toContain(
      "Mens Doubles",
    );
  });
});

describe("buildPartnerLinks — name fallback", () => {
  const players: LinkPlayer[] = [
    { firstName: "Quen", lastName: "Alder", phone: "+1 5550000001" },
    { firstName: "Rowan", lastName: "Birch", phone: "+1 5550000002" },
  ];
  const base: AttendeeEntry = {
    ownerName: { last: "Alder", first: "Quen" },
    ownerPhone: "+1 5550000001",
    divisionLabel: "Mens Doubles Skill: (3.0 To 3.49)",
    format: "doubles",
    partnerName: { last: "Birch", first: "Rowan" },
    partnerPhone: "+1 9998887777", // WRONG phone — forces name fallback
    partnerWaitlisted: false,
  };

  it("falls back to (last, first) when phone fails → low confidence", () => {
    const { pairs } = buildPartnerLinks([base], players);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe("low");
    expect([pairs[0].phoneA, pairs[0].phoneB].sort()).toEqual(["5550000001", "5550000002"]);
  });

  it("refuses an ambiguous name (two players same name) → unlinked", () => {
    const dupPlayers: LinkPlayer[] = [
      ...players,
      { firstName: "Rowan", lastName: "Birch", phone: "+1 5550009999" },
    ];
    const { pairs, unlinked } = buildPartnerLinks([base], dupPlayers);
    expect(pairs).toHaveLength(0);
    expect(unlinked[0].reason).toBe("partner_name_ambiguous");
  });
});

// In-memory PartnerLinkStore for applyPartnerLinks (stands in for the Supabase
// service-role adapter the edge function / driver supplies).
function makeStore(seed: { divisionKey: string; phone: string; id: string }[]) {
  const regs = new Map<string, PartnerReg>(); // id → reg
  const index = new Map<string, string>(); // `${divisionKey}::${phone}` → id
  for (const s of seed) {
    regs.set(s.id, { id: s.id, partnerRegistrationId: null, partnerStatus: "seeking" });
    index.set(`${s.divisionKey}::${s.phone}`, s.id);
  }
  let writes = 0;
  const store: PartnerLinkStore = {
    async resolveRegistration(divisionKey, normPhone) {
      const id = index.get(`${divisionKey}::${normPhone}`);
      return id ? { ...regs.get(id)! } : null;
    },
    async setPartner(registrationId, partnerRegistrationId) {
      writes++;
      const r = regs.get(registrationId)!;
      r.partnerRegistrationId = partnerRegistrationId;
      r.partnerStatus = "confirmed";
    },
  };
  return { store, regs, writes: () => writes };
}

describe("applyPartnerLinks — idempotent both-direction confirm", () => {
  const dkey = "mens doubles skill: (3.0 to 3.49)";
  const seed = [
    { divisionKey: dkey, phone: "5550000001", id: "regA" },
    { divisionKey: dkey, phone: "5550000002", id: "regB" },
  ];
  const pair = { divisionKey: dkey, phoneA: "5550000001", phoneB: "5550000002", confidence: "high" as const, waitlisted: false };

  it("links both registrations to each other and marks them confirmed", async () => {
    const { store, regs } = makeStore(seed);
    const res = await applyPartnerLinks([pair], store);
    expect(res.linked).toBe(1);
    expect(regs.get("regA")).toMatchObject({ partnerRegistrationId: "regB", partnerStatus: "confirmed" });
    expect(regs.get("regB")).toMatchObject({ partnerRegistrationId: "regA", partnerStatus: "confirmed" });
  });

  it("is idempotent: a second run does no writes and reports unchanged", async () => {
    const { store, writes } = makeStore(seed);
    await applyPartnerLinks([pair], store);
    const before = writes();
    const res2 = await applyPartnerLinks([pair], store);
    expect(res2.linked).toBe(0);
    expect(res2.unchanged).toBe(1);
    expect(writes()).toBe(before); // no thrash
  });

  it("skips a pair whose registration is missing", async () => {
    const { store } = makeStore([seed[0]]); // only regA present
    const res = await applyPartnerLinks([pair], store);
    expect(res.linked).toBe(0);
    expect(res.skipped[0].reason).toBe("registration_not_found");
  });
});

describe("fetchAttendeesPartnersPages — TRACE SEAM", () => {
  it("throws until the director-session trace fills it", async () => {
    const session = {
      goto: async () => {},
      pageText: async () => "",
      clickNext: async () => false,
    };
    await expect(fetchAttendeesPartnersPages(session, "EID123")).rejects.toThrow(/TRACE SEAM/);
  });
});
