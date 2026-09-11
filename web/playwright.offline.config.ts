import { defineConfig, devices } from "@playwright/test";

// Offline network-audit harness (issue #735, epic #732) -- a SEPARATE suite
// and config from playwright.config.ts (which drives the deployed app). This
// one runs against the LOCAL offline runtime (scripts/offline.sh) and has no
// business touching the hosted TEST/PROD Supabase project or pages.dev, so it
// gets its own baseURL, no globalSetup (there's no hosted project to warm),
// and lives entirely under e2e/offline/.
export default defineConfig({
  testDir: "./e2e/offline",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    // Whatever host:port `scripts/offline.sh` printed for the Vite dev
    // server (usually http://localhost:5173) -- start that first, this
    // config never launches it for you (it depends on Docker + the local
    // Supabase stack, which is orchestrated separately).
    baseURL: process.env.OFFLINE_BASE_URL || "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
