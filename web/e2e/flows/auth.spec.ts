import { test, expect, loginAs, expectSignedIn, openAccountMenu, SEED } from "../fixtures";

// E2E flow group #251 — auth & account.
// (Account creation + forgot-password live in auth-email.spec.ts, which uses
//  admin generateLink to handle the emailed confirm/recovery tokens.)

test.describe("auth & account (#251)", () => {
  test("log in with email + password lands authenticated", async ({ page }) => {
    await loginAs(page, SEED.playerEmail);
    await page.goto("/");
    // Authed state: Sign out is present (in the bar on desktop, in the
    // hamburger dropdown on mobile — expectSignedIn opens it when needed).
    await expectSignedIn(page);
    // The "Hi, X" greeting is desktop-only chrome (the mobile dropdown omits
    // it), so only assert it on the wide projects.
    if ((page.viewportSize()?.width ?? 0) > 767) {
      await expect(page.getByText(/hi, pam/i)).toBeVisible();
    }
  });

  test("log out returns to a signed-out state", async ({ page }) => {
    await loginAs(page, SEED.playerEmail);
    await page.goto("/");
    await openAccountMenu(page); // mobile: Sign out lives in the hamburger
    await page.getByRole("button", { name: /sign out/i }).click();
    // Signed-out nav: the Sign out button is gone, a sign-in affordance returns
    // (also inside the menu on mobile, so re-open it before asserting).
    await expect(page.getByRole("button", { name: /sign out/i })).toHaveCount(0);
    await openAccountMenu(page);
    await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
  });
});
