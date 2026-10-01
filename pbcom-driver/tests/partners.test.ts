import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  DbPartnerData,
  applyScrapedPartners,
  runAutoLinkPartners,
  type PartnerDb,
  type PartnerFilter,
  type PartnerScraper,
  type TournamentPartnerData,
} from "../src/push/linkPartners.js";
import {
  attendeesUrl,
  collectAttendeesPages,
  parsePages,
} from "../src/pbcom/attendees.js";
import { NoopAlerter } from "../src/alert.js";
import {
  applyPartnerLinks,
  buildPartnerLinks,
  normalizePhone,
  parseAttendeesPartners,
  type AttendeeEntry,
  type LinkPlayer,
  type PartnerReg,
  type PbcomBrowserSession,
} from "../../web/src/lib/pbPartners.js";
import type { DriverConfig } from "../src/config.js";

// ── fixtures ──────────────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(join(HERE, "fixtures", "attendees.sample.txt"), "utf8");
const MD = "mens doubles skill: (3.0 to 3.49)"; // divisionKey("Mens Doubles Skill: (3.0 To 3.49)")
const XD = "mixed doubles skill: (3.5 to 3.99)"; // divisionKey("Mixed Doubles Skill: (3.5 To 3.99)")

/** The 5 B&E players that exist in the DB for this tournament (synthetic). */
function seedTables(): Record<string, Array<Record<string, unknown>>> {
  return {
    events: [
      { id: "ev-md", tournament_id: "t-1", source_system: "pbcom", source_division_label: "Mens Doubles Skill: (3.0 To 3.49)", format: "doubles", deleted_at: null },
      { id: "ev-xd", tournament_id: "t-1", source_system: "pbcom", source_division_label: "Mixed Doubles Skill: (3.5 To 3.99)", format: "doubles", deleted_at: null },
    ],
    event_registrations: [
      { id: "r-alder", event_id: "ev-md", player_id: "p-alder", partner_registration_id: null, partner_status: "seeking", deleted_at: null },
      { id: "r-birch", event_id: "ev-md", player_id: "p-birch", partner_registration_id: null, partner_status: "seeking", deleted_at: null },
      { id: "r-elm", event_id: "ev-md", player_id: "p-elm", partner_registration_id: null, partner_status: "seeking", deleted_at: null },
      { id: "r-cedar", event_id: "ev-xd", player_id: "p-cedar", partner_registration_id: null, partner_status: "seeking", deleted_at: null },
      { id: "r-dune", event_id: "ev-xd", player_id: "p-dune", partner_registration_id: null, partner_status: "seeking", deleted_at: null },
    ],
    players: [
      { id: "p-alder", first_name: "Quen", last_name: "Alder", phone: "+1 5550000001", deleted_at: null },
      { id: "p-birch", first_name: "Rowan", last_name: "Birch", phone: "1 (555) 000-0002", deleted_at: null },
      { id: "p-elm", first_name: "Fenn", last_name: "Elm", phone: "+1 5550000005", deleted_at: null },
      { id: "p-cedar", first_name: "Sage", last_name: "Cedar", phone: "5550000003", deleted_at: null },
      { id: "p-dune", first_name: "Wren", last_name: "Dune", phone: "+1 5550000004", deleted_at: null },
    ],
  };
}

/**
 * A fake Supabase that models the chainable `.select().eq().in().is()` read and the
 * `.update().eq()` write over in-memory tables — enough of the client surface for
 * DbPartnerData. Rows are mutated in place so a re-read sees a prior write.
 */
class FakePartnerDb implements PartnerDb {
  readonly updates: Array<{ id: string; row: Record<string, unknown> }> = [];
  constructor(private readonly tables: Record<string, Array<Record<string, unknown>>>) {}

  from(table: string) {
    const rows = this.tables[table] ?? [];
    const updates = this.updates;
    return {
      select(_cols: string): PartnerFilter {
        const preds: Array<(r: Record<string, unknown>) => boolean> = [];
        const filter: PartnerFilter = {
          eq(col: string, val: string) {
            preds.push((r) => String(r[col]) === String(val));
            return filter;
          },
          in(col: string, vals: readonly string[]) {
            const set = new Set(vals.map(String));
            preds.push((r) => set.has(String(r[col])));
            return filter;
          },
          is(col: string, _val: null) {
            preds.push((r) => r[col] == null);
            return filter;
          },
          then<TResult1 = { data: Array<Record<string, unknown>> | null; error: { message: string } | null }, TResult2 = never>(
            onfulfilled?: ((value: { data: Array<Record<string, unknown>> | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ): PromiseLike<TResult1 | TResult2> {
            const data = rows.filter((r) => preds.every((p) => p(r)));
            return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
          },
        };
        return filter;
      },
      update(row: Record<string, unknown>) {
        return {
          async eq(col: string, val: string) {
            for (const r of rows) {
              if (String(r[col]) === String(val)) {
                Object.assign(r, row);
                updates.push({ id: String(val), row });
              }
            }
            return { error: null };
          },
        };
      },
    };
  }
}

const CFG = {} as DriverConfig; // never used — the fake client is injected

// ── DbPartnerData (the service-role store adapter) ──────────────────────────────

describe("DbPartnerData — service-role store adapter", () => {
  it("resolves a registration by (divisionKey, normalized phone)", async () => {
    const data = new DbPartnerData(CFG, "t-1", new FakePartnerDb(seedTables()));
    const alder = await data.resolveRegistration(MD, "5550000001");
    expect(alder?.id).toBe("r-alder");
    // Birch's stored phone has different formatting but the SAME last-10.
    const birch = await data.resolveRegistration(MD, "5550000002");
    expect(birch?.id).toBe("r-birch");
    // Wrong division for that phone → no match (division-scoped).
    expect(await data.resolveRegistration(XD, "5550000001")).toBeNull();
  });

  it("counts unpaired (seeking) doubles for the cheap pre-check, and lists players", async () => {
    const data = new DbPartnerData(CFG, "t-1", new FakePartnerDb(seedTables()));
    expect(await data.unpairedDoublesCount()).toBe(5);
    const players = await data.players();
    expect(players).toHaveLength(5);
    expect(players.map((p) => p.lastName).sort()).toEqual(["Alder", "Birch", "Cedar", "Dune", "Elm"]);
  });

  it("setPartner writes partner_registration_id + confirmed, and keeps the index fresh", async () => {
    const fake = new FakePartnerDb(seedTables());
    const data = new DbPartnerData(CFG, "t-1", fake);
    await data.resolveRegistration(MD, "5550000001"); // force load
    await data.setPartner("r-alder", "r-birch");
    expect(fake.updates).toEqual([
      { id: "r-alder", row: { partner_registration_id: "r-birch", partner_status: "confirmed" } },
    ]);
    const alder = await data.resolveRegistration(MD, "5550000001");
    expect(alder).toMatchObject({ partnerRegistrationId: "r-birch", partnerStatus: "confirmed" });
  });

  it("applyPartnerLinks over the adapter pairs BOTH ways, skips the unmatched, and is idempotent", async () => {
    const tables = seedTables();
    const fake = new FakePartnerDb(tables);
    const data = new DbPartnerData(CFG, "t-1", fake);

    const entries = parseAttendeesPartners(SAMPLE);
    const players = await data.players();
    const { pairs } = buildPartnerLinks(entries, players);
    // Alder↔Birch (MD) and Cedar↔Dune (XD); Elm's "Sc, R" and absent owners don't pair.
    expect(pairs).toHaveLength(2);

    const first = await applyPartnerLinks(pairs, data);
    expect(first.linked).toBe(2);
    expect(first.unchanged).toBe(0);
    // Two rows per pair → four updates; never a write to the unmatched Elm registration.
    expect(fake.updates).toHaveLength(4);
    expect(fake.updates.some((u) => u.id === "r-elm")).toBe(false);
    const alder = tables.event_registrations!.find((r) => r.id === "r-alder")!;
    expect(alder.partner_registration_id).toBe("r-birch");
    expect(alder.partner_status).toBe("confirmed");

    // Re-run against a FRESH adapter reading the now-paired rows → pure no-op.
    const data2 = new DbPartnerData(CFG, "t-1", fake);
    const second = await applyPartnerLinks(pairs, data2);
    expect(second.linked).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(fake.updates).toHaveLength(4); // no additional writes
  });
});

// ── the linkage loop (fake session, fixture entries) ────────────────────────────

/** An in-memory TournamentPartnerData for loop tests — no DB, mutates reg objects. */
class MemoryPartnerData implements TournamentPartnerData {
  public setCalls = 0;
  private readonly byKey = new Map<string, PartnerReg>();
  private readonly byId = new Map<string, PartnerReg>();
  constructor(
    private readonly _players: LinkPlayer[],
    regs: Array<{ id: string; divisionKey: string; phone: string; status?: string; partner?: string | null }>,
    private readonly unpaired: number,
  ) {
    for (const r of regs) {
      const reg: PartnerReg = { id: r.id, partnerRegistrationId: r.partner ?? null, partnerStatus: r.status ?? "seeking" };
      this.byKey.set(`${r.divisionKey}::${normalizePhone(r.phone)}`, reg);
      this.byId.set(r.id, reg);
    }
  }
  async players(): Promise<LinkPlayer[]> {
    return this._players;
  }
  async unpairedDoublesCount(): Promise<number> {
    return this.unpaired;
  }
  async resolveRegistration(dk: string, phone: string): Promise<PartnerReg | null> {
    return this.byKey.get(`${dk}::${phone}`) ?? null;
  }
  async setPartner(a: string, b: string): Promise<void> {
    const reg = this.byId.get(a);
    if (reg) {
      reg.partnerRegistrationId = b;
      reg.partnerStatus = "confirmed";
    }
    this.setCalls++;
  }
}

function sampleData(unpaired = 5): MemoryPartnerData {
  const players: LinkPlayer[] = [
    { firstName: "Quen", lastName: "Alder", phone: "+1 5550000001" },
    { firstName: "Rowan", lastName: "Birch", phone: "+1 5550000002" },
    { firstName: "Fenn", lastName: "Elm", phone: "+1 5550000005" },
    { firstName: "Sage", lastName: "Cedar", phone: "+1 5550000003" },
    { firstName: "Wren", lastName: "Dune", phone: "+1 5550000004" },
  ];
  return new MemoryPartnerData(
    players,
    [
      { id: "r-alder", divisionKey: MD, phone: "5550000001" },
      { id: "r-birch", divisionKey: MD, phone: "5550000002" },
      { id: "r-elm", divisionKey: MD, phone: "5550000005" },
      { id: "r-cedar", divisionKey: XD, phone: "5550000003" },
      { id: "r-dune", divisionKey: XD, phone: "5550000004" },
    ],
    unpaired,
  );
}

function lockPath(): string {
  return join(tmpdir(), `pbcom-link-test-${randomUUID()}.lock`);
}

function loginError(): Error {
  return Object.assign(new Error("PB.com requires an email one-time code"), { name: "PbcomLoginError" });
}

/** A fake scraper returning the sample's parsed entries. */
function fakeScraper(entries: AttendeeEntry[], opened: { count: number }): () => Promise<PartnerScraper> {
  return async () => {
    opened.count++;
    return {
      scrape: async () => entries,
      close: async () => {},
    };
  };
}

describe("applyScrapedPartners — join + apply, re-run is a no-op", () => {
  it("pairs the matched doubles, reports the unlinked, and no-ops on re-run", async () => {
    const data = sampleData();
    const entries = parseAttendeesPartners(SAMPLE);

    const first = await applyScrapedPartners(data, entries);
    expect(first.linked).toBe(2);
    expect(first.unchanged).toBe(0);
    // Elm's "Sc, R" (not a player) + owners absent from the roster are reported, not guessed.
    expect(first.unlinked.length).toBeGreaterThan(0);
    expect(first.unlinked.some((u) => u.reason === "owner_not_found")).toBe(true);

    const second = await applyScrapedPartners(data, entries);
    expect(second.linked).toBe(0);
    expect(second.unchanged).toBe(2);
  });
});

describe("runAutoLinkPartners — the standing loop", () => {
  it("scrapes once, links, and reports unlinked (forced host)", async () => {
    const entries = parseAttendeesPartners(SAMPLE);
    const data = sampleData();
    const opened = { count: 0 };
    const alert = new NoopAlerter();

    const result = await runAutoLinkPartners(
      { tournamentIds: ["t-1"], dryRun: false, forceHost: true, lockPath: lockPath() },
      { cfg: CFG, dataFor: () => data, eidFor: () => "eid-123", openScraper: fakeScraper(entries, opened), alert },
    );

    expect(result.ran).toBe(true);
    expect(result.sessionLapsed).toBe(false);
    expect(opened.count).toBe(1);
    expect(result.tournaments[0]!.linked).toBe(2);
    expect(result.tournaments[0]!.unlinkedCount).toBeGreaterThan(0);
    // The unlinked summary is surfaced (deduped) to Discord, never a hard failure.
    expect(alert.sent.some((a) => a.kind.startsWith("link-unlinked"))).toBe(true);
  });

  it("CHEAP PRE-CHECK: a tournament with no unpaired doubles opens NO browser", async () => {
    const opened = { count: 0 };
    const result = await runAutoLinkPartners(
      { tournamentIds: ["t-1"], dryRun: false, forceHost: true, lockPath: lockPath() },
      {
        cfg: CFG,
        dataFor: () => sampleData(0), // nothing seeking → skip
        eidFor: () => "eid-123",
        openScraper: fakeScraper(parseAttendeesPartners(SAMPLE), opened),
      },
    );
    expect(result.ran).toBe(true);
    expect(opened.count).toBe(0);
    expect(result.tournaments).toHaveLength(0);
  });

  it("a lapsed PB.com session alerts + exits cleanly (no crash-loop)", async () => {
    const alert = new NoopAlerter();
    const result = await runAutoLinkPartners(
      { tournamentIds: ["t-1"], dryRun: false, forceHost: true, lockPath: lockPath() },
      {
        cfg: CFG,
        dataFor: () => sampleData(5),
        eidFor: () => "eid-123",
        openScraper: async () => {
          throw loginError();
        },
        alert,
      },
    );
    expect(result.ran).toBe(true);
    expect(result.sessionLapsed).toBe(true);
    expect(alert.sent.map((a) => a.kind)).toContain("session-lapse");
  });

  it("refuses to run when this host is not PBCOM-PUSH-HOST (and not forced)", async () => {
    const opened = { count: 0 };
    const result = await runAutoLinkPartners(
      { tournamentIds: ["t-1"], dryRun: false, forceHost: false, lockPath: lockPath() },
      { cfg: CFG, dataFor: () => sampleData(5), eidFor: () => "eid-123", openScraper: fakeScraper([], opened) },
    );
    expect(result.ran).toBe(false);
    expect(result.reason).toMatch(/PBCOM-PUSH-HOST/);
    expect(opened.count).toBe(0);
  });

  it("dry-run reports the pre-check and opens NO browser", async () => {
    const opened = { count: 0 };
    const result = await runAutoLinkPartners(
      { tournamentIds: ["t-1"], dryRun: true },
      { cfg: CFG, dataFor: () => sampleData(5), eidFor: () => "eid-123", openScraper: fakeScraper([], opened) },
    );
    expect(result.ran).toBe(true);
    expect(opened.count).toBe(0);
    expect(result.tournaments[0]!.unpaired).toBe(5);
  });
});

// ── pagination (fake browser session over fixture pages) ────────────────────────

class FakePager implements PbcomBrowserSession {
  public readonly gotos: string[] = [];
  public nextCalls = 0;
  private idx = 0;
  constructor(private readonly pages: string[]) {}
  async goto(url: string): Promise<void> {
    this.gotos.push(url);
    this.idx = 0;
  }
  async pageText(): Promise<string> {
    return this.pages[this.idx] ?? "";
  }
  async clickNext(): Promise<boolean> {
    this.nextCalls++;
    if (this.idx < this.pages.length - 1) {
      this.idx++;
      return true;
    }
    return false;
  }
}

describe("collectAttendeesPages — pagination", () => {
  it("builds the raS.aspx URL from the configured base + eid", () => {
    expect(attendeesUrl("https://pickleballbrackets.com", "E42")).toBe(
      "https://pickleballbrackets.com/a5_u/pbt/raS.aspx?eid=E42",
    );
    // Honors a configured (non-default) base URL — never hardcoded.
    expect(attendeesUrl("https://train.pickleballbrackets.dev", "E7")).toBe(
      "https://train.pickleballbrackets.dev/a5_u/pbt/raS.aspx?eid=E7",
    );
  });

  it("collects every page and STOPS at 'Total: … of N' (to >= total)", async () => {
    const pages = [
      "Attendees\nTotal: 1 to 2 of 6\n...page 1...",
      "Attendees\nTotal: 3 to 4 of 6\n...page 2...",
      "Attendees\nTotal: 5 to 6 of 6\n...page 3...",
      "SHOULD NOT BE READ",
    ];
    const pager = new FakePager(pages);
    const got = await collectAttendeesPages(pager, "https://pickleballbrackets.com", "E1");
    expect(got.map((g) => g.text)).toEqual(pages.slice(0, 3));
    expect(pager.nextCalls).toBe(2); // stopped on the 3rd page (no 4th Next)
    expect(pager.gotos[0]).toContain("raS.aspx?eid=E1");
  });

  it("stops when there is no Next, even without a pagination line", async () => {
    const pager = new FakePager(["one small page, no Total line"]);
    const got = await collectAttendeesPages(pager, "https://pickleballbrackets.com", "E2");
    expect(got).toHaveLength(1);
    expect(pager.nextCalls).toBe(1);
  });

  it("parsePages splits attendees ACROSS page boundaries via the pure parser", async () => {
    // Alder (page 1) and Cedar (page 2) are parsed as separate attendees after join.
    const page1 =
      "Attendees\nTotal: 1 to 1 of 2\n\n" +
      "Alder, Quen · Age: 34 Gender: M · +1 5550000001 · q***@ex.com · DUPR: 1 · Paid: $0.00\n" +
      "Self 3.25 Mens Doubles Skill: (3.0 To 3.49) Self 3.20 Birch, Rowan +1 5550000002 r***@ex.com EVT: 2026-10-03\n";
    const page2 =
      "Attendees\nTotal: 2 to 2 of 2\n\n" +
      "Cedar, Sage · Age: 42 Gender: F · +1 5550000003 · s***@ex.com · DUPR: 2 · Paid: $0.00\n" +
      "Self 3.70 Mixed Doubles Skill: (3.5 To 3.99) Self 3.60 Dune, Wren +1 5550000004 w***@ex.com EVT: 2026-10-04\n";
    const pager = new FakePager([page1, page2]);
    const pages = await collectAttendeesPages(pager, "https://pickleballbrackets.com", "E3");
    const entries = parsePages(pages);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.ownerName.last).sort()).toEqual(["Alder", "Cedar"]);
    expect(entries.every((e) => e.format === "doubles")).toBe(true);
  });
});
