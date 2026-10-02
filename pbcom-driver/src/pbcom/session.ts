/**
 * Playwright session/auth SCAFFOLD for PickleballBrackets.com.
 *
 * Mirrors courtreserve-api's `browser_session` (Python) lesson-for-lesson:
 *   • an ISOLATED persistent context in a throwaway profile dir, so the driver
 *     never touches the operator's normal Chrome;
 *   • prefer the REAL installed Google Chrome (channel: "chrome") over Playwright's
 *     managed Chromium — a Playwright package bump without a matching browser install
 *     silently broke the CR scheduler once; binding to the OS Chrome is drift-immune;
 *   • HEADED by default — headless trips bot-management on these WebForms sites; the
 *     driver runs on the club's residential IP on the mini for the same reason;
 *   • one logged-in page reused across all form operations in a run (session reuse).
 *
 * The LOGIN FORM SELECTORS are intentionally NOT invented here. They are captured in
 * the live director-session trace (D-0045 "trace first") and dropped into the marked
 * TODO seam in `login()`. Everything AROUND login — lifecycle, isolation, channel
 * choice, popup dismissal hook, session reuse — is real.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { DriverConfig } from "../config.js";
import { log } from "../log.js";

export class PbcomLoginError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PbcomLoginError";
  }
}

export class PbcomSession {
  private context: BrowserContext | null = null;
  private profileDir: string | null = null;
  private ephemeral = true;
  private _page: Page | null = null;

  constructor(private readonly cfg: DriverConfig) {}

  /** The logged-in page for the current session. Throws if not opened. */
  get page(): Page {
    if (!this._page) throw new PbcomLoginError("session not open — call open() first");
    return this._page;
  }

  /**
   * The configured DIRECTOR host (PBCOM_BASE_URL). Director surfaces (eDB.aspx
   * console, ptsrr.aspx bracket) must be built against THIS, not `page.url()` —
   * after login the page sits on the public portal (pickleballtournaments.com), so
   * a URL built relative to it 404s on the wrong host (the rehearsal caught this).
   */
  get baseUrl(): string {
    return this.cfg.pbcomBaseUrl;
  }

  /** Launch an isolated browser, then log in. */
  async open(): Promise<void> {
    // A configured persistent profile keeps the PB.com login across runs (supervised
    // operator completes the email-code login once); otherwise a throwaway profile.
    this.ephemeral = !this.cfg.profileDir;
    this.profileDir = this.cfg.profileDir ?? mkdtempSync(join(tmpdir(), "pbcom_driver_chrome_"));
    log.info("launching browser", {
      channel: this.cfg.browserChannel,
      headless: this.cfg.headless,
      persistentProfile: !this.ephemeral,
    });
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.cfg.headless,
      channel: this.cfg.browserChannel === "chrome" ? "chrome" : undefined,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    this._page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.login();
  }

  /** True when the current page looks authenticated (director UI, not the login form). */
  private async isAuthenticated(): Promise<boolean> {
    const page = this.page;
    // Login form present → not authenticated. A director-only nav element → authenticated.
    const onLogin =
      /log\s*in|sign\s*in/i.test(page.url()) ||
      (await page.getByRole("button", { name: /log\s*in|sign\s*in|send.*code/i }).count()) > 0;
    if (onLogin) return false;
    // Any director surface link (My Events / Tournaments) is a good positive signal.
    return (await page.getByRole("link", { name: /my events|tournaments|dashboard/i }).count()) > 0;
  }

  /**
   * Establish an authenticated PB.com director session.
   *
   * ┌─ SEAM (login) — SUPERVISED, by design ────────────────────────────────────┐
   * │ PB.com auth is email → one-time code (no password field to fill from a      │
   * │ secret). Unattended login is therefore an OPEN INFRA-INTAKE item (see       │
   * │ DESIGN.md); this on-demand tool logs in one of two supervised ways:         │
   * │                                                                             │
   * │  A. PERSISTENT PROFILE (recommended). With PBCOM_PROFILE_DIR set, the        │
   * │     operator completes the email-code login once in that Chrome profile and  │
   * │     the cookie session is reused on subsequent runs — no code entry needed.  │
   * │  B. INTERACTIVE (headed) first run. If not yet authenticated, the driver     │
   * │     pre-fills the email (cfg.pbcomUsername) and WAITS (up to loginTimeoutMs) │
   * │     for the operator to type the emailed code and land on a director page.   │
   * │                                                                             │
   * │ Fully headless/unattended login is NOT supported here on purpose. It throws  │
   * │ PbcomLoginError so an unattended job fails loudly rather than half-driving.  │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  private async login(): Promise<void> {
    const page = this.page;
    // Wait for DOMContentLoaded, not full "load": PB.com's homepage pulls heavy
    // third-party resources (ads/trackers) that can keep the `load` event from
    // firing for >30s even when the page is usable — which failed an otherwise-fine
    // run. The auth check below only needs the DOM. Generous timeout as a backstop.
    await page.goto(this.cfg.pbcomBaseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});

    // A. Persistent profile already authenticated → reuse it.
    if (await this.isAuthenticated()) {
      log.info("login: reusing authenticated PB.com session (persistent profile)");
      await this.dismissPopups();
      return;
    }

    // Pre-fill the email to speed the operator's supervised login, if a field exists.
    if (this.cfg.pbcomUsername) {
      const email = page
        .getByRole("textbox", { name: /email/i })
        .or(page.locator('input[type="email"], input[name*="email" i]'))
        .first();
      if (await email.count()) {
        await email.fill(this.cfg.pbcomUsername).catch(() => {});
        // Trigger the code send if the button is present.
        const send = page.getByRole("button", { name: /send.*code|continue|next|log\s*in/i }).first();
        if (await send.count()) await send.click().catch(() => {});
      }
    }

    if (this.cfg.headless) {
      throw new PbcomLoginError(
        "PB.com requires an email one-time code; headless/unattended login is not supported. " +
          "Run headed with PBCOM_PROFILE_DIR set and complete the code once (see DESIGN.md).",
      );
    }

    // B. Supervised wait: the operator enters the emailed code; we poll for the signal.
    log.warn("login: waiting for supervised email-code login to complete", {
      timeoutMs: this.cfg.loginTimeoutMs,
    });
    const deadline = Date.now() + this.cfg.loginTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.isAuthenticated()) {
        log.info("login: supervised login complete");
        await this.dismissPopups();
        return;
      }
      await page.waitForTimeout(2_000);
    }
    throw new PbcomLoginError(
      "supervised login did not complete before PBCOM_LOGIN_TIMEOUT_MS elapsed",
    );
  }

  /**
   * Dismiss announcement / survey overlays that can sit on top of the Save button.
   *
   * ┌─ TRACE SEAM (popups) ────────────────────────────────────────────────────┐
   * │ PB.com's specific modal/overlay selectors come from the trace. The CR      │
   * │ driver learned that third-party NPS/announcement overlays silently swallow  │
   * │ clicks; expect the same class of nuisance here and clear them best-effort.  │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  async dismissPopups(): Promise<void> {
    // Best-effort, never throws — an absent popup is the normal case.
    try {
      await this.page.keyboard.press("Escape");
    } catch {
      /* no popup — fine */
    }
    // TODO(trace): add PB.com-specific close-control selectors from the trace.
  }

  /** Tear down the browser and remove the throwaway profile. */
  async close(): Promise<void> {
    try {
      await this.context?.close();
    } finally {
      this.context = null;
      this._page = null;
      // Only remove a throwaway profile; a configured persistent profile is preserved
      // so the next supervised run reuses the login.
      if (this.profileDir && this.ephemeral) {
        rmSync(this.profileDir, { recursive: true, force: true });
      }
      this.profileDir = null;
    }
  }
}

/**
 * Context-manager-style helper: open a logged-in session, run `fn`, always close.
 * Mirrors the Python `with browser_session() as page:` ergonomics.
 */
export async function withSession<T>(
  cfg: DriverConfig,
  fn: (session: PbcomSession) => Promise<T>,
): Promise<T> {
  const session = new PbcomSession(cfg);
  await session.open();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
