import { test, expect, SEED } from "../fixtures";

// E2E flow group #252 — tournament discovery (browse, search, open).
// Public + read-only: no auth required.

const TOURNAMENT = "E2E Regression Cup";
const card = (page: import("@playwright/test").Page) =>
  page.getByRole("link").filter({ hasText: TOURNAMENT });

test.describe("tournament discovery (#252)", () => {
  test("browse: a published tournament shows on the home page", async ({ page }) => {
    await page.goto("/");
    await expect(card(page)).toBeVisible();
  });

  test("search filters the tournament list by name", async ({ page }) => {
    await page.goto("/");
    const search = page.getByLabel("Search tournaments");
    await search.fill("zzz-no-such-tournament");
    await expect(card(page)).toHaveCount(0);
    await search.fill("E2E Regression");
    await expect(card(page)).toBeVisible();
  });

  test("open a tournament from discovery", async ({ page }) => {
    await page.goto("/");
    await card(page).first().click();
    await expect(page).toHaveURL(new RegExp(`/t/${SEED.orgSlug}/${SEED.tournamentSlug}`));
    await expect(page.getByRole("heading", { name: TOURNAMENT })).toBeVisible();
  });

  // The section tabs' wording, asserted deliberately in ONE place. Every other
  // spec reaches the event cards via gotoRegister(), which targets the tab by
  // its stable id — so a rename shows up here as a single honest failure about
  // copy, instead of 11 confusing timeouts in unrelated registration specs
  // (which is exactly what #725's "Register" → "Events" rename caused).
  test("tournament page tabs are labelled Details and Events", async ({ page }) => {
    await page.goto(`/t/${SEED.orgSlug}/${SEED.tournamentSlug}`);
    await expect(page.locator("#tournament-tab-details")).toHaveText(/details/i);
    await expect(page.locator("#tournament-tab-register")).toHaveText(/events/i);
  });

  // Switching to the events tab reveals its panel — the behaviour every
  // registration spec depends on gotoRegister() delivering.
  test("the events tab reveals the events panel", async ({ page }) => {
    await page.goto(`/t/${SEED.orgSlug}/${SEED.tournamentSlug}`);
    const tab = page.locator("#tournament-tab-register");
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#tournament-panel-register")).toBeVisible();
  });
});
