import {
  test,
  expect,
  loginAs,
  gotoRegister,
  openPartnerPicker,
  tapClear,
  SEED,
} from "../fixtures";

// E2E flow group #253 — doubles registration variants. Each flow runs against
// its own single-event tournament (seed), so the Register tab has one card and
// "Go to checkout" is the unambiguous "registration landed" signal.

test.describe("registration (#253)", () => {
  test("register with an existing partner", async ({ page }) => {
    await loginAs(page, SEED.existingPartner.registrantEmail);
    await gotoRegister(page, SEED.orgSlug, SEED.existingPartner.tournamentSlug);

    await tapClear(page.getByRole("button", { name: /^register$/i }));
    // Default mode is "I have a partner". On mobile the picker is a bottom
    // sheet; openPartnerPicker opens it (no-op on desktop's inline search).
    await openPartnerPicker(page);
    await page
      .getByPlaceholder(/search by name, email, or phone/i)
      .fill(SEED.existingPartner.partnerQuery);
    await page.getByRole("button", { name: /^search$/i }).click();
    await page.getByRole("button", { name: /^pick$/i }).first().click();
    await tapClear(page.getByRole("button", { name: /^save$/i }));

    await expect(page.getByRole("link", { name: /go to checkout/i })).toBeVisible();
  });

  test("register with a new partner (invite someone not in the system)", async ({ page }) => {
    await loginAs(page, SEED.newPartner.registrantEmail);
    await gotoRegister(page, SEED.orgSlug, SEED.newPartner.tournamentSlug);

    await tapClear(page.getByRole("button", { name: /^register$/i }));
    await openPartnerPicker(page);
    await page.getByRole("button", { name: /add new player/i }).click();
    await page.getByPlaceholder("First name *").fill(SEED.newPartner.first);
    await page.getByPlaceholder("Last name *").fill(SEED.newPartner.last);
    await page.getByPlaceholder("Email *").fill(SEED.newPartner.email);
    await tapClear(page.getByRole("button", { name: /^save$/i }));

    await expect(page.getByRole("link", { name: /go to checkout/i })).toBeVisible();
  });

  test('register needing a partner ("I need a partner")', async ({ page }) => {
    await loginAs(page, SEED.seeker.registrantEmail);
    await gotoRegister(page, SEED.orgSlug, SEED.seeker.tournamentSlug);

    await tapClear(page.getByRole("button", { name: /^register$/i }));
    await page.getByRole("radio", { name: /i need a partner/i }).click();
    await tapClear(page.getByRole("button", { name: /^save$/i }));

    await expect(page.getByRole("link", { name: /go to checkout/i })).toBeVisible();
  });

  test("register for a singles event (no partner picker)", async ({ page }) => {
    await loginAs(page, SEED.singles.registrantEmail);
    await gotoRegister(page, SEED.orgSlug, SEED.singles.tournamentSlug);

    await tapClear(page.getByRole("button", { name: /^register$/i }));
    // Singles: no partner mode, just Save.
    await tapClear(page.getByRole("button", { name: /^save$/i }));

    await expect(page.getByRole("link", { name: /go to checkout/i })).toBeVisible();
  });

  test("change partner on a pending registration", async ({ page }) => {
    await loginAs(page, SEED.changePartner.registrantEmail);
    await gotoRegister(page, SEED.orgSlug, SEED.changePartner.tournamentSlug);

    await tapClear(page.getByRole("button", { name: /change partner/i }));
    await openPartnerPicker(page);
    await page
      .getByPlaceholder(/search by name, email, or phone/i)
      .fill(SEED.changePartner.newPartnerQuery);
    await page.getByRole("button", { name: /^search$/i }).click();
    await page.getByRole("button", { name: /^pick$/i }).first().click();
    await tapClear(page.getByRole("button", { name: /save partner change/i }));

    // Still a pending reg afterward → cancel affordance returns.
    await expect(page.getByRole("button", { name: /cancel registration/i })).toBeVisible();
  });

  test("accept a partner invite", async ({ page }) => {
    await loginAs(page, SEED.inviteAccept.inviteeEmail);
    await page.goto(`/t/${SEED.orgSlug}/${SEED.inviteAccept.tournamentSlug}/invites/${SEED.inviteAccept.token}`);

    // The accept page hard-redirects to /profile until the player profile has
    // loaded with a name — the real new-invitee path. Complete it (pre-filled
    // from the seed) and ?return= brings us back to the invite. On a warm load
    // the Accept button is there directly; handle either.
    const accept = page.getByRole("button", { name: /^accept/i });
    const saveProfile = page.getByRole("button", { name: /save profile/i });
    await expect(accept.or(saveProfile).first()).toBeVisible({ timeout: 30_000 });
    if (await saveProfile.isVisible()) {
      await tapClear(saveProfile);
      await expect(accept).toBeVisible({ timeout: 30_000 });
    }

    await tapClear(accept);
    await expect(page.getByRole("heading", { name: /partner confirmed/i })).toBeVisible();
  });
});
