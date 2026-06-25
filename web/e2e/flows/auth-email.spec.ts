import { test, expect, admin, expectSignedIn } from "../fixtures";

// E2E flow group #251 — the email-gated half of auth: account creation and
// forgot-password. No real inbox: we mint the confirm/recovery token via the
// Supabase admin API (generateLink) and drive the app's /auth/confirm exchange.
// Fresh timestamped emails each run → no collisions, no cleanup.

const PASSWORD = process.env.E2E_TEST_PASSWORD || "e2e-password";
const stamp = () => Date.now();

test.describe("account & auth — email flows (#251)", () => {
  test("create-account form requests an email link", async ({ page }) => {
    const email = `e2e-signup-${stamp()}@wmpc.test`;
    await page.goto("/login");
    await page.getByRole("radio", { name: /create account/i }).click();
    await page.getByLabel(/email/i).fill(email);
    await page.locator("form").getByRole("button", { name: /email me a link/i }).click();
    await expect(page.getByText(/check your email/i)).toBeVisible();
  });

  test("email confirm link logs a new account in", async ({ page }) => {
    const email = `e2e-confirm-${stamp()}@wmpc.test`;
    const { data, error } = await admin().auth.admin.generateLink({
      type: "signup",
      email,
      password: PASSWORD,
    });
    expect(error).toBeNull();
    const tokenHash = data?.properties?.hashed_token;
    expect(tokenHash).toBeTruthy();

    await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=signup&next=/`);
    await expect(page).not.toHaveURL(/\/login/);
    // Authed signal — Sign out (in the bar on desktop, in the hamburger on mobile).
    await expectSignedIn(page);
  });

  test("forgot password → reset link → set a new password", async ({ page }) => {
    const email = `e2e-reset-${stamp()}@wmpc.test`;
    await admin().auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });

    await page.goto("/login");
    await page.getByRole("button", { name: /forgot password/i }).click();
    await page.getByLabel(/email/i).fill(email);
    await page.getByRole("button", { name: /send reset link/i }).click();
    await expect(page.getByText(/check your email/i)).toBeVisible();

    const { data } = await admin().auth.admin.generateLink({ type: "recovery", email });
    const tokenHash = data?.properties?.hashed_token;
    await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=recovery`);
    await expect(page).toHaveURL(/reset-password/);

    await page.getByLabel(/^new password$/i).fill("newpass-1234");
    await page.getByLabel(/^confirm password$/i).fill("newpass-1234");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page.getByText(/password updated/i)).toBeVisible();
  });
});
