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

  // Path 1 (backing out of the register FORM after picking a partner → a
  // "Discard your partner pick?" confirm). Needs the multi-step PartnerSearch
  // flow (its picker opens its OWN role="dialog" sheet, so the test must
  // disambiguate three overlapping dialogs) and a register-eligible identity
  // with no existing reg on the event (e.g. seed organizer Olive, who holds
  // none). The discard modal's accessible name is "Discard your partner pick?"
  // and its keep-button is "Keep editing".
  test.fixme(
    "Path 1 — backing out of the register form after picking a partner",
    async () => {},
  );
});
