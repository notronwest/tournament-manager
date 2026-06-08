import { defineConfig, devices } from "@playwright/test";

// E2E regression suite — see web/e2e/README.md. Runs against a DEPLOYED app
// (E2E_BASE_URL), not a local dev server, so it exercises the same build Ron
// reviews. Deterministic data comes from e2e/seed.ts (run before the suite).
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL || "https://tournament-manager.pages.dev",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
