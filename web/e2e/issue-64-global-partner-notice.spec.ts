/**
 * issue-64-global-partner-notice.spec.ts (#64) — "Global partner-selection
 * notification on login."
 *
 * Translated 1:1 from the issue's `## Acceptance criteria` against the live
 * `PartnerInvitesBanner` (rendered app-wide in App.tsx, reading pending
 * `partner_invites` for the current player via `PartnerInvitesContext`):
 *   AC1/2 — logging in as a selected partner and visiting any other
 *           authenticated page (the homepage, not the tournament) surfaces
 *           the banner.
 *   AC3   — the banner names the inviter + event and links to where the
 *           player accepts/declines.
 *   AC4   — a player with no pending selections sees nothing.
 *   AC5   — after accepting, the banner clears (checked via a fresh
 *           navigation, since the banner hides itself on the accept page).
 *
 * Fixtures: e2e/seed.ts §11 via SEED.globalNotice. Gale has one pending
 * inbound invite; Milo (reused from #10's singles fixture) has none.
 */
import { test, expect, loginAs, SEED } from "./fixtures";

const F = SEED.globalNotice;

test.describe("#64 global partner-selection notification", () => {
  test("shows on any authenticated page, names the invite, links to it, and clears after accepting", async ({
    page,
  }) => {
    await loginAs(page, F.inviteeEmail);

    // AC 2 — visible on the homepage, without ever opening the tournament.
    await page.goto("/");
    await expect(page.getByText(/pending partner invite/i)).toBeVisible();

    // AC 3 — names who selected them + which event, and links to act on it.
    await expect(page.getByText(F.inviterName, { exact: false })).toBeVisible();
    await expect(page.getByText(F.eventName, { exact: false })).toBeVisible();
    const reviewLink = page.getByRole("link", { name: /review invite/i });
    await expect(reviewLink).toBeVisible();
    await reviewLink.click();
    await expect(page).toHaveURL(
      new RegExp(`/t/${SEED.orgSlug}/${F.tournamentSlug}/invites/`),
    );

    // AC 5 — accepting clears the invite; the banner doesn't come back.
    await page.getByRole("button", { name: /accept/i }).click();
    await page.goto("/");
    await expect(page.getByText(/pending partner invite/i)).toHaveCount(0);
  });

  test("a player with no pending selections sees no notification", async ({ page }) => {
    await loginAs(page, F.noInviteEmail);
    await page.goto("/");
    await expect(page.getByText(/pending partner invite/i)).toHaveCount(0);
  });
});
