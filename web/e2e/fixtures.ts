import { test as base, expect, type Page } from "@playwright/test";

// Deterministic identities created by e2e/seed.ts. Keep these in sync with
// the seed. Passwords come from CI secret E2E_TEST_PASSWORD.
export const SEED = {
  orgSlug: "e2e-test",
  tournamentSlug: "e2e-regression-cup",
  organizerEmail: "e2e-organizer@wmpc.test",
  playerEmail: "e2e-player@wmpc.test",
  partnerName: "Pat Partner", // the picked partner on the seeded pending reg
  doublesEventName: "E2E Mixed Doubles 3.5",
};

const PASSWORD = process.env.E2E_TEST_PASSWORD || "e2e-password";

// Log in through the real UI via email/password (the app supports
// signInWithPassword). Lands authenticated for the rest of the test.
export async function loginAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(PASSWORD);
  // Scope to the form — the page also has a nav "Sign in" button, which would
  // otherwise trip Playwright's strict-mode (two matches).
  await page.locator("form").getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

export const test = base;
export { expect };
