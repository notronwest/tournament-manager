import { test, expect, loginAs, gotoRegister, SEED } from "../fixtures";

// E2E flow group #253 — doubles registration variants. Each flow runs against
// its own single-event tournament (seed), so the Register tab has one card and
// "Go to checkout" is the unambiguous "registration landed" signal.

test.describe("registration (#253)", () => {
  test("register with an existing partner", async ({ page }) => {
    await loginAs(page, SEED.existingPartner.registrantEmail);
    await gotoRegister(page, SEED.orgSlug, SEED.existingPartner.tournamentSlug);

    await page.getByRole("button", { name: /^register$/i }).click();
    // Default mode is "I have a partner" → inline PartnerSearch.
    await page
      .getByPlaceholder(/search by name, email, or phone/i)
      .fill(SEED.existingPartner.partnerQuery);
    await page.getByRole("button", { name: /^search$/i }).click();
    await page.getByRole("button", { name: /^pick$/i }).first().click();
    await page.getByRole("button", { name: /^save$/i }).click();

    await expect(page.getByRole("link", { name: /go to checkout/i })).toBeVisible();
  });

  test("register with a new partner (invite someone not in the system)", async ({ page }) => {
    await loginAs(page, SEED.newPartner.registrantEmail);
    await gotoRegister(page, SEED.orgSlug, SEED.newPartner.tournamentSlug);

    await page.getByRole("button", { name: /^register$/i }).click();
    await page.getByRole("button", { name: /add new player/i }).click();
    await page.getByPlaceholder("First name *").fill(SEED.newPartner.first);
    await page.getByPlaceholder("Last name *").fill(SEED.newPartner.last);
    await page.getByPlaceholder("Email *").fill(SEED.newPartner.email);
    await page.getByRole("button", { name: /^save$/i }).click();

    await expect(page.getByRole("link", { name: /go to checkout/i })).toBeVisible();
  });

  test('register needing a partner ("I need a partner")', async ({ page }) => {
    await loginAs(page, SEED.seeker.registrantEmail);
    await gotoRegister(page, SEED.orgSlug, SEED.seeker.tournamentSlug);

    await page.getByRole("button", { name: /^register$/i }).click();
    await page.getByRole("radio", { name: /i need a partner/i }).click();
    await page.getByRole("button", { name: /^save$/i }).click();

    await expect(page.getByRole("link", { name: /go to checkout/i })).toBeVisible();
  });
});
