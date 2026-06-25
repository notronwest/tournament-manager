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
  },
  projects: [
    // Desktop journey suite — excludes the mobile/ specs.
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: "**/mobile/**",
    },
    // Mobile profiles run the mobile/ audit AND the core flow suite, so the
    // journeys are exercised at phone width (~390px, touch) — not just audited
    // statically. The flow specs use viewport-aware helpers (loginAs /
    // gotoRegister / openPartnerPicker) so the same specs pass on both desktop
    // and mobile.
    {
      name: "iphone",
      use: { ...devices["iPhone 13"] }, // WebKit, ~390px, touch
      testMatch: ["**/mobile/**", "**/flows/**"],
    },
    {
      name: "pixel",
      use: { ...devices["Pixel 5"] }, // Chromium, ~393px, touch
      testMatch: ["**/mobile/**", "**/flows/**"],
    },
  ],
});
