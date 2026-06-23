import { test, expect, loginAs, gotoRegister, SEED } from "./fixtures";

// Regression for issue #9 — "Cancelling a registration with a picked partner
// needs a confirm step." Translated from the issue's ## Acceptance criteria.
// Cancelling a pending registration must warn before it drops the partner.
//
// STATUS: the harness (seed → suite → Discord) is green; these two specs are
// the Testing agent's first Job-2 task. The selectors below already match the
// real EventCard / ConfirmModal DOM (verified against PublicTournamentPage.tsx)
// — what's left is app-STATE, not selectors. Both are test.fixme so they're
// visible-and-owed without holding the nightly red.

test.describe("#9 confirm before dropping a partner", () => {
  // Path 2 reaches the page (the seed now sets players.email so RequireProfile
  // doesn't bounce to /profile) but the pending card never shows its "Cancel
  // Registration" button — i.e. the seeded pending_payment reg isn't surfacing
  // as `myStatus` for the logged-in player. Finish by capturing a page snapshot
  // (add the HTML reporter or run locally with the E2E secrets) to see whether
  // the card renders "Register" instead — likely a reg↔player_id / RLS-read gap
  // in the seed, not the spec.
  test(
    "Path 2 — cancelling a pending registration pops a confirm step",
    async ({ page }) => {
      await loginAs(page, SEED.playerEmail);
      await gotoRegister(page);

      // The pending card shows "Cancel Registration" (not "Register").
      await page.getByRole("button", { name: /cancel registration/i }).click();

      // #9 guard: a confirm dialog, not an immediate cancel. Scope to the
      // ConfirmModal by its accessible name (its <h2> title) so it isn't
      // confused with the focused-card dialog (named "Registering for …").
      const modal = page.getByRole("dialog", { name: /cancel registration\?/i });
      await expect(modal).toBeVisible();
      await expect(modal).toContainText(/partner/i);
      await expect(
        modal.getByRole("button", { name: /keep registration/i }),
      ).toBeVisible();

      // Confirm → registration removed → the card returns to "Register".
      await modal.getByRole("button", { name: /^cancel registration$/i }).click();
      await expect(
        page.getByRole("button", { name: /^register$/i }),
      ).toBeVisible();
    },
  );

  test("Path 1 — backing out of the register form after picking a partner", async ({ page }) => {
    // A registrant with no existing reg on the discard event picks a partner,
    // then backs out → must confirm before the pick is discarded.
    await loginAs(page, SEED.discard.registrantEmail);
    await gotoRegister(page, SEED.orgSlug, SEED.discard.tournamentSlug);

    await page.getByRole("button", { name: /^register$/i }).click();
    await page.getByPlaceholder(/search by name, email, or phone/i).fill(SEED.discard.partnerQuery);
    await page.getByRole("button", { name: /^search$/i }).click();
    await page.getByRole("button", { name: /^pick$/i }).first().click();

    // Back out → a confirm naming the pick (scoped by the modal's title).
    await page.getByRole("button", { name: /^not now$/i }).click();
    const modal = page.getByRole("dialog", { name: /discard your partner pick\?/i });
    await expect(modal).toBeVisible();

    // Keep editing → modal closes, the partner pick survives (the picked-chip
    // controls only render when a partner is still selected).
    await modal.getByRole("button", { name: /keep editing/i }).click();
    await expect(modal).toBeHidden();
    await expect(page.getByRole("button", { name: /find a new partner/i })).toBeVisible();
  });
});
