import { defineConfig, devices } from "@playwright/test";

// E2E regression suite — see web/e2e/README.md. Runs against a DEPLOYED app
// (E2E_BASE_URL), not a local dev server, so it exercises the same build Ron
// reviews. Deterministic data comes from e2e/seed.ts (run before the suite).
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The first app-driven query can wake the idle (free-tier) test Supabase
  // project — a ~30s cold start that blows the default 30s budget on whichever
  // test runs first. Give CI headroom; warm runs finish in seconds.
  timeout: process.env.CI ? 60_000 : 30_000,
  // STOP MECHANISM — don't waste cycles. Two failure modes burned a 33-min run:
  // (1) a single doomed action (e.g. a CTA pinned under the fixed bottom bar)
  // hangs to the full 60s test timeout; (2) a wholesale break leaves dozens of
  // tests to grind, each ×retry. So:
  //   • actionTimeout caps any single click/fill at 20s — a stuck action fails
  //     fast (20s, not 60s) while still leaving a warm load real headroom.
  //   • expect timeout 10s — a genuinely-slow-but-coming element still passes,
  //     but a missing one fails in 10s instead of waiting the whole test out.
  //   • maxFailures circuit-breaks a meltdown: once >12 tests have failed the
  //     run is fundamentally broken, so abort rather than burn the remainder.
  expect: { timeout: 10_000 },
  maxFailures: process.env.CI ? 12 : undefined,
  // Serialize in CI: the suite drives ONE shared deployed app (tm-test) and
  // mutates registration state, so concurrent workers race the deploy (cold
  // hits time out) and each other. One worker is deterministic; the suite is
  // small (~1 min). Local runs still parallelize.
  workers: process.env.CI ? 1 : undefined,
  // CI: github annotations + console list + an HTML report (downloadable as a
  // run artifact, with traces/screenshots on failure) + a machine-readable JSON
  // report that e2e/record-history.ts ingests into the per-test history table.
  reporter: process.env.CI
    ? [
        ["github"],
        ["list"],
        ["html", { open: "never" }],
        ["json", { outputFile: "playwright-report/results.json" }],
      ]
    : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL || "https://tournament-manager.pages.dev",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Cap a single stuck action (see "STOP MECHANISM" above). Navigation keeps
    // the full per-test budget for cold starts; only element actions are capped.
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  projects: [
    // Desktop journey suite — excludes the mobile/ specs.
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: "**/mobile/**",
    },
    // Mobile profiles run the mobile/ audit plus the NON-MUTATING flows (auth,
    // discovery) at phone width (~390px, touch). They deliberately do NOT run
    // the mutating registration/self-service flows: the suite drives ONE shared
    // tm-test DB, Playwright runs all of chromium first, and those flows consume
    // single-use seed state (a registration, an invite token) — so re-running
    // the identical flow on a second/third project finds the state already
    // consumed (no "Register" button, invite already accepted) and fails. Real
    // mobile journey coverage here = the hamburger nav (auth) + the layout
    // assertions in mobile/audit.spec.ts; full mutation journeys on mobile would
    // need per-project seed isolation (tracked as a follow-up).
    {
      name: "iphone",
      use: { ...devices["iPhone 13"] }, // WebKit, ~390px, touch
      testMatch: ["**/mobile/**", "**/flows/auth.spec.ts", "**/flows/discovery.spec.ts"],
    },
    {
      name: "pixel",
      use: { ...devices["Pixel 5"] }, // Chromium, ~393px, touch
      testMatch: ["**/mobile/**", "**/flows/auth.spec.ts", "**/flows/discovery.spec.ts"],
    },
  ],
});
