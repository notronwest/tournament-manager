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
});
