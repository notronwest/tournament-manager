import { test, expect, loginAs, SEED } from "./fixtures";

// Regression for issue #9 — "Cancelling a registration with a picked partner
// needs a confirm step." Translated from the issue's ## Acceptance criteria.
// Both cancel paths must warn first when a partner is picked.

test.describe("#9 confirm before dropping a partner", () => {
  test("Path 1 — backing out of the register form after picking a partner", async ({ page }) => {
    await loginAs(page, SEED.playerEmail);
    await page.goto(`/t/${SEED.orgSlug}/${SEED.tournamentSlug}`);

    // Open the doubles event's register form and pick a partner.
    const card = page.getByRole("article").filter({ hasText: SEED.doublesEventName });
    await card.getByRole("button", { name: /register/i }).click();
    await card.getByPlaceholder(/search/i).fill(SEED.partnerName);
    await card.getByText(SEED.partnerName).first().click();

    // Click Cancel to back out → a confirm modal naming the partner.
    await card.getByRole("button", { name: /^cancel$/i }).click();
    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(SEED.partnerName);

    // Keep editing → modal closes, partner still selected.
    await modal.getByRole("button", { name: /keep/i }).click();
    await expect(modal).toBeHidden();
    await expect(card.getByText(SEED.partnerName)).toBeVisible();
  });

  test("Path 2 — cancelling a submitted pending registration", async ({ page }) => {
    await loginAs(page, SEED.playerEmail);
    await page.goto(`/t/${SEED.orgSlug}/${SEED.tournamentSlug}`);

    // The seed leaves a pending_payment reg with a partner on this event.
    const card = page.getByRole("article").filter({ hasText: SEED.doublesEventName });
    await card.getByRole("button", { name: /^cancel$/i }).click();
    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(SEED.partnerName);

    // Confirm → registration removed.
    await modal.getByRole("button", { name: /cancel registration/i }).click();
    await expect(card.getByRole("button", { name: /^register$/i })).toBeVisible();
  });

  // (No-partner / seeker path cancels with no modal — add once the seed
  //  provides a singles or seeker registration.)
});
