import { test as base, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// Service-role admin client for specs that need to mint email tokens
// (generateLink) or set up auth users directly — used by the email flows so we
// never need a real inbox. Requires E2E_SUPABASE_URL + E2E_SUPABASE_SERVICE_ROLE_KEY
// in the test step env (see regression.yml).
export function admin() {
  const url = process.env.E2E_SUPABASE_URL;
  const key = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("admin(): missing E2E_SUPABASE_URL / E2E_SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

// Deterministic identities created by e2e/seed.ts. Keep these in sync with
// the seed. Passwords come from CI secret E2E_TEST_PASSWORD.
export const SEED = {
  orgSlug: "e2e-test",
  tournamentSlug: "e2e-regression-cup",
  organizerEmail: "e2e-organizer@wmpc.test",
  playerEmail: "e2e-player@wmpc.test",
  partnerName: "Pat Partner", // the picked partner on the seeded pending reg
  doublesEventName: "E2E Mixed Doubles 3.5",
  // Registration flows (#253) — each its own single-event tournament so the
  // Register tab shows exactly one card.
  existingPartner: {
    tournamentSlug: "e2e-existing-partner",
    registrantEmail: "e2e-organizer@wmpc.test", // Olive
    partnerQuery: "Pat", // searches for the existing partner Pat
  },
  newPartner: {
    tournamentSlug: "e2e-new-partner",
    registrantEmail: "e2e-rex@wmpc.test", // Rex
    first: "Nina",
    last: "Newcomer",
    email: "e2e-newpartner@wmpc.test",
  },
  seeker: {
    tournamentSlug: "e2e-seeker",
    registrantEmail: "e2e-sam@wmpc.test", // Sam
  },
  singles: {
    tournamentSlug: "e2e-singles",
    registrantEmail: "e2e-sid@wmpc.test", // Sid
  },
  discard: {
    tournamentSlug: "e2e-discard",
    registrantEmail: "e2e-dana@wmpc.test", // Dana, no existing reg
    partnerQuery: "Pat",
  },
  changePartner: {
    tournamentSlug: "e2e-change-partner",
    registrantEmail: "e2e-cam@wmpc.test", // Cam, pending reg w/ Pat
    newPartnerQuery: "Quinn",
  },
  inviteAccept: {
    tournamentSlug: "e2e-invite",
    token: "e2e-accept-token",
    inviteeEmail: "e2e-ava@wmpc.test", // Ava
    inviterName: "Ivan",
  },
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

// Open a tournament's public page and switch to the Register tab, where the
// event cards (register / partner-pick / cancel) live. The page defaults to the
// Details tab, so every event-card interaction must do this first.
export async function gotoRegister(
  page: Page,
  orgSlug = SEED.orgSlug,
  tournamentSlug = SEED.tournamentSlug,
) {
  await page.goto(`/t/${orgSlug}/${tournamentSlug}`);
  await page.getByRole("tab", { name: /register/i }).click();
}

export const test = base;
export { expect };
