import {
  test,
  expect,
  loginAs,
  gotoRegister,
  openPartnerPicker,
  tapClear,
  SEED,
} from "./fixtures";

// Regression for issue #10 — "Partner won't be notified until checkout" copy
// on the register form. Translated 1:1 from the issue's ## Acceptance
// criteria. Verified against the live copy in PublicTournamentPage.tsx: the
// note renders once a partner is picked on the open register form (AC 1) and
// again on the resulting pending card (AC 2), but not on the seeker ("I need
// a partner") or singles paths, which have no partner section at all (AC 3).

const NOTE = /partner won't be notified until you check out/i;

test.describe("#10 partner-not-notified-until-checkout copy", () => {
  test("shows on the open form once a partner is picked, and again on the pending card", async ({
    page,
  }) => {
    await loginAs(page, SEED.partnerNotice.pickerEmail);
    await gotoRegister(page, SEED.orgSlug, SEED.partnerNotice.tournamentSlug);

    await tapClear(page.getByRole("button", { name: /^register$/i }));
    await openPartnerPicker(page);
    await page
      .getByPlaceholder(/search by name, email, or phone/i)
      .fill(SEED.partnerNotice.partnerQuery);
    await page.getByRole("button", { name: /^search$/i }).click();
    await page.getByRole("button", { name: /^pick$/i }).first().click();

    // AC 1 — the note appears on the open form once a partner is picked.
    await expect(page.getByText(NOTE)).toBeVisible();

    await tapClear(page.getByRole("button", { name: /^save$/i }));

    // AC 2 — the same note persists on the resulting pending card.
    await expect(page.getByRole("link", { name: /go to checkout/i })).toBeVisible();
    await expect(page.getByText(NOTE)).toBeVisible();
  });

  test('the "I need a partner" seeker path is not cluttered by the note', async ({ page }) => {
    await loginAs(page, SEED.partnerNotice.seekerEmail);
    await gotoRegister(page, SEED.orgSlug, SEED.partnerNotice.seekerTournamentSlug);

    await tapClear(page.getByRole("button", { name: /^register$/i }));
    await page.getByRole("radio", { name: /i need a partner/i }).click();

    // AC 3 — no partner picked, so the note must not appear.
    await expect(page.getByText(NOTE)).toHaveCount(0);
  });

  test("a singles registration (no partner picker at all) is not cluttered by the note", async ({
    page,
  }) => {
    await loginAs(page, SEED.partnerNotice.singlesEmail);
    await gotoRegister(page, SEED.orgSlug, SEED.partnerNotice.singlesTournamentSlug);

    await tapClear(page.getByRole("button", { name: /^register$/i }));

    // AC 3 — singles has no partner section at all, so no note either.
    await expect(page.getByText(NOTE)).toHaveCount(0);
  });
});
