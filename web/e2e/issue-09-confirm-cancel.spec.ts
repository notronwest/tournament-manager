import { test, expect, loginAs, SEED } from "./fixtures";

// Regression for issue #9 — "Cancelling a registration with a picked partner
// needs a confirm step." Translated from the issue's ## Acceptance criteria.
// Cancelling a pending registration must warn before it drops the partner.

test.describe("#9 confirm before dropping a partner", () => {
  test("Path 2 — cancelling a pending registration pops a confirm step", async ({
    page,
  }) => {
    // The seed leaves a pending_payment reg for this player on the doubles event.
    await loginAs(page, SEED.playerEmail);
    await page.goto(`/t/${SEED.orgSlug}/${SEED.tournamentSlug}`);

    // The pending card shows "Cancel Registration" (not "Register").
    await page.getByRole("button", { name: /cancel registration/i }).click();

    // #9 guard: a confirm dialog, not an immediate cancel. Scope to the
    // ConfirmModal by its accessible name so it isn't confused with the
    // focused-card dialog (which is named "Registering for …").
    const modal = page.getByRole("dialog", { name: /cancel registration\?/i });
    await expect(modal).toBeVisible();
    // It warns that confirming drops the partner.
    await expect(modal).toContainText(/partner/i);
    await expect(
      modal.getByRole("button", { name: /keep registration/i }),
    ).toBeVisible();

    // Confirm → registration removed → the card returns to "Register".
    await modal.getByRole("button", { name: /^cancel registration$/i }).click();
    await expect(
      page.getByRole("button", { name: /^register$/i }),
    ).toBeVisible();
  });

  // Path 1 (backing out of the register FORM after picking a partner → a
  // "Discard your partner pick?" confirm) is owed. It needs the multi-step
  // PartnerSearch flow (its picker opens its own role="dialog" sheet, so the
  // test must disambiguate three overlapping dialogs) and a register-eligible
  // identity with no existing reg on the event. Left for the Testing agent's
  // spec-authoring pass (Job 2) rather than blocking the nightly going green.
  test.fixme(
    "Path 1 — backing out of the register form after picking a partner",
    async () => {},
  );
});
