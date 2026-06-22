import { test, expect, loginAs, SEED } from "../fixtures";

// E2E flow group #251 — auth & account.
// (Account creation + forgot-password live in auth-email.spec.ts, which uses
//  admin generateLink to handle the emailed confirm/recovery tokens.)

test.describe("auth & account (#251)", () => {
  test("log in with email + password lands authenticated", async ({ page }) => {
    await loginAs(page, SEED.playerEmail);
    await page.goto("/");
    // Authed state: the signed-in nav (greeting + Sign out) is shown.
    await expect(page.getByText(/hi, pam/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
  });

  test("log out returns to a signed-out state", async ({ page }) => {
    await loginAs(page, SEED.playerEmail);
    await page.goto("/");
    await page.getByRole("button", { name: /sign out/i }).click();
    // Signed-out nav: the Sign out button is gone, a sign-in affordance returns.
    await expect(page.getByRole("button", { name: /sign out/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
  });
});
