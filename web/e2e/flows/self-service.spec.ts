import { test, expect, loginAs, tapClear, SEED } from "../fixtures";

// E2E flow group — player self-service: my registrations, withdraw, my invites.
// All RequireAuth-only and exercisable without Stripe (pending regs withdraw
// without a refund charge).

test.describe("self-service", () => {
  test("my tournaments lists my registration", async ({ page }) => {
    await loginAs(page, SEED.selfService.viewerEmail);
    await page.goto("/my-tournaments");
    // `.first()` on purpose: the test asserts the viewer sees THEIR registration,
    // not that the name is globally unique. On the shared TEST DB a tournament
    // name can legitimately appear more than once (seed drift / duplicate data),
    // which would otherwise trip Playwright strict mode.
    await expect(page.getByText(SEED.selfService.tournamentName).first()).toBeVisible();
    await expect(page.getByText(/pending payment/i).first()).toBeVisible();
  });

  test("withdraw from an event", async ({ page }) => {
    await loginAs(page, SEED.selfService.withdrawEmail);
    await page.goto("/my-tournaments");
    await tapClear(page.getByRole("button", { name: /^withdraw$/i }).first());
    // Confirm step, then the reg is no longer withdrawable → the button is gone.
    await tapClear(page.getByRole("button", { name: /confirm withdrawal/i }));
    await expect(page.getByRole("button", { name: /^withdraw$/i })).toHaveCount(0);
  });

  test("view my pending partner invites", async ({ page }) => {
    await loginAs(page, SEED.invitesView.inviteeEmail);
    await page.goto("/invites");
    await expect(page.getByRole("link", { name: /review invite/i })).toBeVisible();
  });
});
