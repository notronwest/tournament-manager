/**
 * The LIVE raS.aspx Attendees fetch — the implementation of pbPartners' trace seam.
 *
 * pbPartners.ts (web/src/lib) ships a PURE parser/linker plus a typed seam
 * (`fetchAttendeesPartnersPages` over the structural `PbcomBrowserSession`) that
 * THROWS until a browser fills it. THIS is the pbcom-driver's fill: it drives the
 * driver's authenticated Playwright `PbcomSession` to PB.com's director Attendees
 * report (raS.aspx), reads each page's rendered TEXT, paginates, and returns the
 * collected pages. The PURE `parseAttendeesPartners` then turns that text into
 * `AttendeeEntry[]` — NO DOM/parse logic lives here (D-0049: reuse pbPartners).
 *
 * Why text, not DOM: pbPartners parses the RENDERED attendee text (its block/entry
 * grammar is the single source of truth), so the browser's only job is to navigate,
 * dump visible text, and click "Next". That keeps Playwright entirely out of
 * pbPartners and this file free of parse logic.
 *
 * Selectors are by role/text (resilient to WebForms' generated ids), mirroring
 * pbcom/driver.ts. The exact raS.aspx query string is a TRACE SEAM: the path below
 * follows the eDB.aspx director-console convention and is VERIFIED in the supervised
 * first live run (`link-partners <tid>` watched) before the loop is trusted.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import type { PbcomSession } from "./session.js";
import {
  parseAttendeesPartners,
  parsePaginationTotal,
  type AttendeeEntry,
  type PbcomBrowserSession,
  type RawAttendeeBlock,
} from "../../../web/src/lib/pbPartners.js";
import { log } from "../log.js";

/** pbcom-driver repo root (…/pbcom-driver), for the debug dump path. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const NAV = { waitUntil: "load" as const, timeout: 45_000 };
const STEP_TIMEOUT = 30_000;

/**
 * The director Attendees report path. raS.aspx is PB.com's authenticated,
 * director-view Attendees list (full UNMASKED partner phones), the one surface that
 * carries doubles partnerships (the flat-file export does not). Built from the
 * configured base URL (never hardcoded host); the `?eid=` query mirrors the
 * eDB.aspx console convention in pbcom/driver.ts. TRACE SEAM: the supervised run
 * confirms/corrects this exact query.
 */
const ATTENDEES_PATH = "/a5_u/pbt/raS.aspx";

/** Safety bound so a mis-behaving "Next" can never spin the loop forever. */
const MAX_PAGES = 200;

/** Build the raS.aspx director Attendees URL for a PB.com event id. */
export function attendeesUrl(baseUrl: string, eid: string): string {
  const u = new URL(ATTENDEES_PATH, baseUrl || "https://pickleballbrackets.com");
  u.searchParams.set("eid", eid);
  return u.toString();
}

/**
 * The Playwright adapter satisfying pbPartners' structural `PbcomBrowserSession`.
 * Navigates, dumps the page's rendered text, and clicks the WebForms "Next" pager.
 * Kept tiny and DOM-only; all parsing happens in the pure pbPartners layer.
 */
export class PlaywrightAttendeesBrowser implements PbcomBrowserSession {
  constructor(private readonly page: Page) {}

  async goto(url: string): Promise<void> {
    await this.page.goto(url, NAV);
  }

  /** The current page's rendered visible text — pbPartners parses TEXT, not the DOM. */
  async pageText(): Promise<string> {
    return this.page.locator("body").innerText();
  }

  /**
   * Click the pager's "Next" postback. Resolves false when there is no next page
   * (no control, or a disabled/aria-disabled one on the last page), which ends the
   * pagination loop.
   */
  async clickNext(): Promise<boolean> {
    const next = this.page
      .getByRole("link", { name: /next|›|»|^\s*>\s*$/i })
      .or(this.page.getByRole("button", { name: /next|›|»|^\s*>\s*$/i }))
      .first();
    if ((await next.count()) === 0) return false;
    const disabled = await next.isDisabled().catch(() => false);
    const ariaDisabled = (await next.getAttribute("aria-disabled").catch(() => null)) === "true";
    if (disabled || ariaDisabled) return false;
    await next.click();
    await this.page.waitForLoadState("load", { timeout: STEP_TIMEOUT }).catch(() => {});
    return true;
  }
}

/**
 * Walk the paginated Attendees report, collecting one `RawAttendeeBlock` per PAGE
 * (its full rendered text). PURE of Playwright — it drives the structural
 * `PbcomBrowserSession`, so it is unit-tested with a fake session over fixture
 * pages. Pagination ends when "Total: X to Y of N" reports the last attendee, or a
 * "Next" control is absent/disabled, or the "to" counter stops advancing (a final
 * guard against an infinite loop), or MAX_PAGES is hit.
 */
export async function collectAttendeesPages(
  browser: PbcomBrowserSession,
  baseUrl: string,
  eid: string,
): Promise<RawAttendeeBlock[]> {
  await browser.goto(attendeesUrl(baseUrl, eid));
  const pages: RawAttendeeBlock[] = [];
  let lastTo = -1;
  for (let i = 0; i < MAX_PAGES; i++) {
    const text = await browser.pageText();
    pages.push({ text });

    const total = parsePaginationTotal(text);
    if (total) {
      if (total.to >= total.total) break; // reached the final attendee
      if (total.to <= lastTo) break; // pager not advancing → stop (no infinite loop)
      lastTo = total.to;
    }

    const more = await browser.clickNext();
    if (!more) break;
  }
  return pages;
}

/**
 * Turn the collected raw pages into parsed partner entries via the PURE
 * `parseAttendeesPartners`. The pages are joined and handed to the string path so
 * pbPartners' own `splitAttendeeBlocks` (header-anchor grammar) delimits attendees
 * correctly ACROSS page boundaries — no DOM-side splitting, no duplicate logic.
 */
export function parsePages(pages: RawAttendeeBlock[]): AttendeeEntry[] {
  return parseAttendeesPartners(pages.map((p) => p.text).join("\n"));
}

/**
 * Drive the driver's authenticated PB.com session to the raS.aspx Attendees report
 * for `eid` and return the raw per-page blocks. `session.page` throws
 * `PbcomLoginError` when the session is not open; the caller opens it first and
 * treats a lapse as needs_attention (see linkPartners.ts), exactly like the push loop.
 */
export async function fetchAttendeesPartnersPages(
  session: PbcomSession,
  baseUrl: string,
  eid: string,
): Promise<RawAttendeeBlock[]> {
  const url = attendeesUrl(baseUrl, eid);
  log.info("attendees: scraping raS.aspx director attendees", { eid, url });
  const browser = new PlaywrightAttendeesBrowser(session.page);
  const pages = await collectAttendeesPages(browser, baseUrl, eid);

  // TRACE-SEAM DIAGNOSTIC (2026-10-01): the raS.aspx `?eid=` URL is unverified —
  // a run that collects a page but parses 0 attendees can't tell "wrong page /
  // login redirect" from "right page, wrong grammar". So dump exactly what the
  // authenticated browser landed on: the final URL (catches a silent redirect to
  // login), the total rendered-text length, a short preview, and the full text to
  // a file. Remove once the seam is confirmed. Never throws (best-effort).
  try {
    const landedUrl = session.page.url();
    const joined = pages.map((p) => p.text).join("\n");
    const dumpDir = join(REPO_ROOT, "state");
    mkdirSync(dumpDir, { recursive: true });
    const dumpPath = join(dumpDir, `attendees-debug-${eid}.txt`);
    writeFileSync(dumpPath, `REQUESTED: ${url}\nLANDED:    ${landedUrl}\n\n${joined}`, "utf8");
    log.info("attendees: DEBUG dump written", {
      eid,
      requestedUrl: url,
      landedUrl,
      pages: pages.length,
      textLength: joined.length,
      preview: joined.slice(0, 400).replace(/\s+/g, " ").trim(),
      dumpPath,
    });
  } catch (err) {
    log.warn("attendees: debug dump failed (continuing)", { eid, error: String((err as Error)?.message ?? err) });
  }

  log.info("attendees: collected attendee pages", { eid, pages: pages.length });
  return pages;
}
