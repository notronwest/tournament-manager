/**
 * AUTO doubles partner-linkage — the standing pass that pairs doubles registrations
 * after a PB.com import, with NO manual script (D-0045 / #984 follow-up).
 *
 * THE GAP. The PB.com flat-file import leaves every doubles registration
 * `partner_status='seeking'` (the export carries no TeamID). The partnership lives
 * only on PB.com's authenticated raS.aspx director Attendees page. This module
 * scrapes that (via the attendees.ts seam), joins partners to B&E players by
 * normalized phone, and writes `partner_registration_id` + `partner_status='confirmed'`
 * on both rows — the SAME write the TeamID pairing did at import time.
 *
 * REUSE (D-0049). All parse/phone-join/apply logic is the PURE pbPartners module
 * (web/src/lib): `parseAttendeesPartners`, `buildPartnerLinks`, `applyPartnerLinks`
 * over the injected `PartnerLinkStore` port. The driver's job is only the browser
 * (attendees.ts) and the service-role Supabase adapter below. Safety plumbing —
 * host gate, same-machine lock, session-lapse handling, Discord alerts — reuses the
 * push loop's helpers (run.ts) so linkage behaves exactly like the push for an
 * unattended, self-healing, singleton run.
 *
 * IDEMPOTENT. A re-run pairs only what is still unlinked: the cheap pre-check skips a
 * tournament with zero `seeking` doubles (so NO browser opens), and applyPartnerLinks
 * no-ops a pair already confirmed to each other. An existing confirmed pairing is
 * NEVER deleted or overwritten.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Alerter } from "../alert.js";
import { MissingCredentials, type DriverConfig } from "../config.js";
import { log } from "../log.js";
import { FileLock, isPushHost, isSessionLapse } from "./run.js";
import {
  applyPartnerLinks,
  buildPartnerLinks,
  normalizePhone,
  type ApplyResult,
  type AttendeeEntry,
  type LinkPlayer,
  type PartnerLinkStore,
  type PartnerReg,
  type UnlinkedEntry,
} from "../../../web/src/lib/pbPartners.js";
import { divisionKey } from "../../../web/src/lib/pbDivision.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** A link-specific lock, distinct from the push lock so the two passes never block each other. */
const LINK_LOCK_PATH = join(REPO_ROOT, "state", "pbcom-link.lock");

const SESSION_LAPSE_ALERT =
  "⚠️ **PB.com session expired** — the B&E doubles partner-linkage (raS.aspx " +
  "Attendees scrape) needs a re-auth on the mini. It stopped cleanly (no crash-loop) " +
  "and will resume next tick. Fix: on the club mini, run the driver **headed** once " +
  "and complete the emailed code.";

// ── the data port (tournament-scoped): the pbPartners write port + the reads ─────

/**
 * Everything linkage needs for ONE tournament: the pbPartners `PartnerLinkStore`
 * write port (resolve a registration by division+phone; set a partner), plus the two
 * reads the join needs (the tournament's players, and the cheap unpaired-doubles
 * pre-check). The DB-backed `DbPartnerData` below implements it; tests use a fake.
 */
export interface TournamentPartnerData extends PartnerLinkStore {
  /** The tournament's B&E players (full phone + name) for the phone/name join. */
  players(): Promise<LinkPlayer[]>;
  /**
   * Count of UNPAIRED (`partner_status='seeking'`) doubles registrations. The cheap
   * pre-check: 0 → there is nothing to link, so DON'T open a browser (mirrors the push
   * loop skipping a session when there is no delta).
   */
  unpairedDoublesCount(): Promise<number>;
}

/** Opens ONE PB.com scraping session for the tick and scrapes attendees per eid. */
export interface PartnerScraper {
  /** Scrape raS.aspx attendees for a PB.com event id → parsed partner entries. */
  scrape(eid: string): Promise<AttendeeEntry[]>;
  /** Tear the session down (always called, even after an error). */
  close(): Promise<void>;
}

// ── per-tournament apply (pure given data + entries; no browser) ──────────────────

export interface TournamentLinkOutcome {
  linked: number;
  unchanged: number;
  unlinked: UnlinkedEntry[];
  skipped: ApplyResult["skipped"];
}

/**
 * Join scraped attendee entries to the tournament's players and apply the pairs.
 * Pure of the browser: it reuses pbPartners end-to-end (buildPartnerLinks →
 * applyPartnerLinks over the injected store). Unlinked entries are RETURNED (never
 * guessed, never written). Testable with a fake `TournamentPartnerData`.
 */
export async function applyScrapedPartners(
  data: TournamentPartnerData,
  entries: AttendeeEntry[],
): Promise<TournamentLinkOutcome> {
  const players = await data.players();
  const { pairs, unlinked } = buildPartnerLinks(entries, players);
  const applied = await applyPartnerLinks(pairs, data);
  return { linked: applied.linked, unchanged: applied.unchanged, unlinked, skipped: applied.skipped };
}

function tallyReasons(unlinked: UnlinkedEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of unlinked) out[u.reason] = (out[u.reason] ?? 0) + 1;
  return out;
}

function fmtReasons(byReason: Record<string, number>): string {
  return Object.entries(byReason)
    .map(([r, n]) => `${n} ${r}`)
    .join(", ");
}

// ── the standing/auto linkage run ────────────────────────────────────────────────

export interface LinkRunOptions {
  /** The B&E tournaments bound to PB.com (poll passes all; link-partners passes one). */
  tournamentIds: string[];
  dryRun: boolean;
  forceHost?: boolean;
  /** Override the same-machine lock path (tests use an isolated one). */
  lockPath?: string;
}

export interface LinkRunDeps {
  cfg: DriverConfig;
  /** A tournament-scoped data port (DbPartnerData in production, a fake in tests). */
  dataFor: (tournamentId: string) => TournamentPartnerData;
  /** The PB.com event id for a tournament (from the binding config). */
  eidFor: (tournamentId: string) => string;
  /**
   * Opens ONE PB.com scraping session for the tick. Throws `PbcomLoginError` when the
   * session has lapsed. Undefined in dry-run (never called).
   */
  openScraper?: () => Promise<PartnerScraper>;
  /** Posts needs_attention / summary alerts to Discord. Optional (unset → logged). */
  alert?: Alerter;
}

export interface LinkTournamentResult {
  tournamentId: string;
  unpaired: number;
  linked: number;
  unchanged: number;
  unlinkedCount: number;
}

export interface LinkRunResult {
  ran: boolean;
  reason?: string;
  /** True when the PB.com session had lapsed — alerted, clean exit (no crash-loop). */
  sessionLapsed: boolean;
  tournaments: LinkTournamentResult[];
}

/**
 * The unattended auto linkage run. Mirrors runAutoPush's shape and safety:
 *   • host + same-machine lock gates (fail-closed; an unset PBCOM-PUSH-HOST drives nowhere).
 *   • CHEAP PRE-CHECK: per tournament, skip when there are no `seeking` doubles — and
 *     if nothing anywhere needs linking, open NO browser.
 *   • Open ONE session for the tick; a lapsed session alerts once (deduped) and exits
 *     cleanly, never a crash-loop.
 *   • Unlinked partners (phone mismatch / waitlisted / placeholder) are LOGGED and
 *     optionally summarized to Discord — never guessed, never a hard failure.
 *   • An existing confirmed pairing is never deleted or overwritten (applyPartnerLinks).
 */
export async function runAutoLinkPartners(
  opts: LinkRunOptions,
  deps: LinkRunDeps,
): Promise<LinkRunResult> {
  if (!opts.dryRun && !isPushHost(undefined, opts.forceHost)) {
    return { ran: false, reason: "not the designated PBCOM-PUSH-HOST", sessionLapsed: false, tournaments: [] };
  }

  const lock = new FileLock(opts.lockPath ?? LINK_LOCK_PATH);
  if (!opts.dryRun && !lock.acquire()) {
    return { ran: false, reason: "another link run holds the lock", sessionLapsed: false, tournaments: [] };
  }

  try {
    // 1) Cheap pre-check (no browser): which tournaments actually have unpaired doubles?
    const needs: Array<{ tid: string; data: TournamentPartnerData; unpaired: number }> = [];
    for (const tid of opts.tournamentIds) {
      const data = deps.dataFor(tid);
      const unpaired = await data.unpairedDoublesCount();
      if (unpaired > 0) {
        needs.push({ tid, data, unpaired });
      } else {
        log.info("link: no unpaired doubles — skipping (no browser)", { tournamentId: tid });
      }
    }

    const results: LinkTournamentResult[] = [];

    if (needs.length === 0) {
      log.info("link: nothing to link this tick (no unpaired doubles anywhere)");
      return { ran: true, reason: "no unpaired doubles", sessionLapsed: false, tournaments: results };
    }

    if (opts.dryRun) {
      for (const n of needs) {
        log.info("[link dry-run] would scrape raS.aspx + link", { tournamentId: n.tid, unpaired: n.unpaired });
        results.push({ tournamentId: n.tid, unpaired: n.unpaired, linked: 0, unchanged: 0, unlinkedCount: 0 });
      }
      return { ran: true, reason: "dry-run", sessionLapsed: false, tournaments: results };
    }

    // 2) Open ONE scraping session. A lapse → alert once + clean exit (no crash-loop).
    if (!deps.openScraper) throw new Error("runAutoLinkPartners: deps.openScraper is required for a real run");
    let scraper: PartnerScraper;
    try {
      scraper = await deps.openScraper();
    } catch (err) {
      if (isSessionLapse(err)) {
        await deps.alert?.send("session-lapse", SESSION_LAPSE_ALERT);
        log.warn("link: PB.com session lapsed — alerted, exiting cleanly");
        return { ran: true, reason: "session lapsed", sessionLapsed: true, tournaments: results };
      }
      throw err;
    }

    // 3) Scrape + link each tournament that needs it, on the shared session.
    let sessionLapsed = false;
    try {
      for (const n of needs) {
        try {
          const eid = deps.eidFor(n.tid);
          const entries = await scraper.scrape(eid);
          const out = await applyScrapedPartners(n.data, entries);
          log.info("link: applied partner links", {
            tournamentId: n.tid,
            linked: out.linked,
            unchanged: out.unchanged,
            unlinked: out.unlinked.length,
            skipped: out.skipped.length,
          });
          if (out.unlinked.length > 0) {
            const byReason = tallyReasons(out.unlinked);
            log.warn("link: some doubles entries could not be auto-paired (not guessed)", {
              tournamentId: n.tid,
              byReason,
            });
            await deps.alert?.send(
              `link-unlinked-${n.tid}`,
              `ℹ️ **PB.com partner linkage** — tournament ${n.tid}: paired ${out.linked} new, ` +
                `${out.unchanged} already linked, but ${out.unlinked.length} doubles entr` +
                `${out.unlinked.length === 1 ? "y" : "ies"} could not be auto-paired ` +
                `(${fmtReasons(byReason)}). NOT guessed — a human can pair these in B&E.`,
            );
          }
          results.push({
            tournamentId: n.tid,
            unpaired: n.unpaired,
            linked: out.linked,
            unchanged: out.unchanged,
            unlinkedCount: out.unlinked.length,
          });
        } catch (err) {
          if (isSessionLapse(err)) {
            sessionLapsed = true;
            await deps.alert?.send("session-lapse", SESSION_LAPSE_ALERT);
            log.warn("link: PB.com session lapsed mid-tick — stopping cleanly", { tournamentId: n.tid });
            break;
          }
          const msg = String((err as Error)?.message ?? err);
          log.error("link: tournament linkage errored", { tournamentId: n.tid, error: msg });
          await deps.alert?.send(
            `link-error-${n.tid}`,
            `⚠️ **PB.com partner linkage errored** for tournament ${n.tid}: ${msg}. ` +
              `Nothing was guessed; it will retry next tick.`,
          );
        }
      }
    } finally {
      await scraper.close().catch(() => {});
    }

    return { ran: true, sessionLapsed, tournaments: results };
  } finally {
    lock.release();
  }
}

// ── the service-role Supabase data adapter (idempotent) ──────────────────────────

type DbResult = { data: Array<Record<string, unknown>> | null; error: { message: string } | null };

/** A chainable, awaitable select filter — the slice of the Supabase builder we use. */
export interface PartnerFilter extends PromiseLike<DbResult> {
  eq(col: string, val: string): PartnerFilter;
  in(col: string, vals: readonly string[]): PartnerFilter;
  is(col: string, val: null): PartnerFilter;
}

/**
 * The narrow slice of the Supabase client `DbPartnerData` uses. The real
 * PostgrestFilterBuilder is structurally compatible (`.select().eq().in().is()` is
 * awaitable; `.update().eq()` returns a promise). A test injects a fake.
 */
export interface PartnerDb {
  from(table: string): {
    select(cols: string): PartnerFilter;
    update(row: Record<string, unknown>): { eq(col: string, val: string): PromiseLike<{ error: { message: string } | null }> };
  };
}

/** Lazily build a service-role Supabase client — same custody as DbPushLedger. */
async function supabaseClient(cfg: DriverConfig): Promise<PartnerDb> {
  if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey) {
    throw new MissingCredentials("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  }
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  }) as unknown as PartnerDb;
}

/**
 * The production `TournamentPartnerData`: reads the tournament's pbcom divisions,
 * registrations and players via the SERVICE-ROLE key, builds the (divisionKey, phone)
 * → registration index pbPartners resolves against, and writes the pairing with the
 * exact same update the import's TeamID pairing uses
 * (`partner_registration_id` + `partner_status='confirmed'`, both directions).
 *
 * IDEMPOTENCY lives in pbPartners' applyPartnerLinks (it skips a pair already
 * confirmed to each other); this adapter additionally keeps its in-memory index
 * consistent after a write, so a resolve later in the same run sees the new state.
 * It NEVER clears a partner or writes anything but a confirm.
 */
export class DbPartnerData implements TournamentPartnerData {
  private loaded = false;
  /** (divisionKey::normPhone) → the one registration for that player in that division. */
  private readonly index = new Map<string, PartnerReg>();
  /** registrationId → the SAME PartnerReg object (so a write can keep the index fresh). */
  private readonly byId = new Map<string, PartnerReg>();
  private readonly playerList: LinkPlayer[] = [];
  private unpaired = 0;

  constructor(
    private readonly cfg: DriverConfig,
    private readonly tournamentId: string,
    /** Injected client for tests; production builds the service-role client lazily. */
    private readonly injectedDb?: PartnerDb,
  ) {
    if (!injectedDb && (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey)) {
      throw new MissingCredentials("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    }
  }

  private async db(): Promise<PartnerDb> {
    return this.injectedDb ?? (await supabaseClient(this.cfg));
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const db = await this.db();

    // 1) The tournament's pbcom divisions (events).
    const evRes = await db
      .from("events")
      .select("id, source_division_label, format")
      .eq("tournament_id", this.tournamentId)
      .eq("source_system", "pbcom")
      .is("deleted_at", null);
    if (evRes.error) throw new Error(`read events: ${evRes.error.message}`);
    const events = evRes.data ?? [];
    const eventDivKey = new Map<string, string>();
    const eventDoubles = new Map<string, boolean>();
    for (const e of events) {
      const id = String(e.id);
      const label = (e.source_division_label as string | null) ?? "";
      eventDivKey.set(id, divisionKey(label));
      eventDoubles.set(id, (e.format as string | null) !== "singles");
    }
    const eventIds = [...eventDivKey.keys()];
    if (eventIds.length === 0) {
      this.loaded = true;
      return;
    }

    // 2) Their registrations.
    const regRes = await db
      .from("event_registrations")
      .select("id, event_id, player_id, partner_registration_id, partner_status")
      .in("event_id", eventIds)
      .is("deleted_at", null);
    if (regRes.error) throw new Error(`read event_registrations: ${regRes.error.message}`);
    const regs = regRes.data ?? [];

    // 3) The players behind those registrations (for the phone/name join).
    const playerIds = [...new Set(regs.map((r) => String(r.player_id)).filter(Boolean))];
    const playerById = new Map<string, { phone: string | null; firstName: string; lastName: string }>();
    if (playerIds.length > 0) {
      const plRes = await db
        .from("players")
        .select("id, first_name, last_name, phone")
        .in("id", playerIds)
        .is("deleted_at", null);
      if (plRes.error) throw new Error(`read players: ${plRes.error.message}`);
      for (const p of plRes.data ?? []) {
        playerById.set(String(p.id), {
          phone: (p.phone as string | null) ?? null,
          firstName: (p.first_name as string | null) ?? "",
          lastName: (p.last_name as string | null) ?? "",
        });
      }
    }

    // 4) Build the index + player list + the cheap pre-check count.
    const seenPlayers = new Set<string>();
    for (const r of regs) {
      const regId = String(r.id);
      const eventId = String(r.event_id);
      const playerId = String(r.player_id);
      const divKey = eventDivKey.get(eventId) ?? "";
      const isDoubles = eventDoubles.get(eventId) ?? true;
      const status = (r.partner_status as string | null) ?? "";
      if (isDoubles && status === "seeking") this.unpaired++;

      const player = playerById.get(playerId);
      if (player && !seenPlayers.has(playerId)) {
        seenPlayers.add(playerId);
        this.playerList.push({ phone: player.phone, firstName: player.firstName, lastName: player.lastName });
      }

      const reg: PartnerReg = {
        id: regId,
        partnerRegistrationId: (r.partner_registration_id as string | null) ?? null,
        partnerStatus: status,
      };
      this.byId.set(regId, reg);
      const normPhone = player ? normalizePhone(player.phone) : null;
      if (normPhone) this.index.set(`${divKey}::${normPhone}`, reg);
    }

    this.loaded = true;
  }

  async players(): Promise<LinkPlayer[]> {
    await this.ensureLoaded();
    return this.playerList;
  }

  async unpairedDoublesCount(): Promise<number> {
    await this.ensureLoaded();
    return this.unpaired;
  }

  async resolveRegistration(divisionKeyArg: string, normPhone: string): Promise<PartnerReg | null> {
    await this.ensureLoaded();
    return this.index.get(`${divisionKeyArg}::${normPhone}`) ?? null;
  }

  async setPartner(registrationId: string, partnerRegistrationId: string): Promise<void> {
    const db = await this.db();
    const { error } = await db
      .from("event_registrations")
      .update({ partner_registration_id: partnerRegistrationId, partner_status: "confirmed" })
      .eq("id", registrationId);
    if (error) throw new Error(`setPartner(${registrationId}): ${error.message}`);
    // Keep the in-memory index consistent so a later resolve in THIS run sees it.
    const reg = this.byId.get(registrationId);
    if (reg) {
      reg.partnerRegistrationId = partnerRegistrationId;
      reg.partnerStatus = "confirmed";
    }
  }
}
