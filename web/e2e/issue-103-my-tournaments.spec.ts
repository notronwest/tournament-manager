/**
 * issue-103-my-tournaments.spec.ts (#103) — "My Tournaments page for players
 * (upcoming + past), in a prominent spot."
 *
 * Translated 1:1 from the issue's `## Acceptance criteria`:
 *   AC1 — A signed-in player can open "My Tournaments" from a prominent
 *         header link and see every tournament they're registered for.
 *   AC2 — Registrations are split into Upcoming/Running and Past sections;
 *         past tournaments remain listed as history.
 *   AC3 — Each row shows the tournament, the player's events, and their
 *         status (paid / pending / seeking), and links to the tournament
 *         page.
 *   AC4 — A player with no registrations sees a friendly empty state with a
 *         link to browse.
 *   AC5 — Only the player's own registrations are shown (RLS-scoped); no
 *         other players' data leaks.
 *
 * Fixtures (e2e/seed.ts §11 via SEED.myTournaments): Mia is registered in an
 * upcoming tournament (a paid+seeking doubles reg and a pending-payment
 * singles reg — covers all three status labels in one card) and a completed
 * ("Past") tournament (a paid singles reg). Otto is registered in a THIRD
 * tournament Mia has no part in, so AC5 can assert it never leaks onto her
 * page. Vera has zero registrations, for the AC4 empty state. Read-only spec
 * (no registrations or profile fields are mutated), so it's safe to share
 * across runs/retries.
 */
import type { Page } from "@playwright/test";
import { test, expect, loginAs, openAccountMenu, SEED } from "./fixtures";

const MT = SEED.myTournaments;

// Scopes assertions to one TournamentCard — the outer div carries
// role="link" (whole-card click-through) and contains the tournament name,
// so filtering that role by the name text isolates exactly one card even
// though the card ALSO nests its own "View tournament →" <a role="link">.
function cardFor(page: Page, tournamentName: string) {
  return page.locator('div[role="link"]').filter({ hasText: tournamentName });
}

test.describe("#103 My Tournaments page for players", () => {
  test("prominent header link opens My Tournaments showing every registered tournament (AC 1)", async ({
    page,
  }) => {
    await loginAs(page, MT.viewerEmail);
    await openAccountMenu(page);
    await page.getByRole("link", { name: "My Tournaments" }).click();

    await expect(page).toHaveURL(/\/my-tournaments/);
    await expect(page.getByRole("heading", { name: "My Tournaments" })).toBeVisible();
    await expect(page.getByText(MT.upcoming.tournamentName, { exact: true })).toBeVisible();
    await expect(page.getByText(MT.past.tournamentName, { exact: true })).toBeVisible();
  });

  test("registrations split into Upcoming/Running and Past sections; past remains listed as history (AC 2)", async ({
    page,
  }) => {
    await loginAs(page, MT.viewerEmail);
    await page.goto("/my-tournaments");

    const upcomingSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Upcoming & Running" }) });
    const pastSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Past", exact: true }) });

    await expect(upcomingSection).toBeVisible();
    await expect(pastSection).toBeVisible();
    await expect(upcomingSection.getByText(MT.upcoming.tournamentName, { exact: true })).toBeVisible();
    // The completed tournament isn't dropped — it's kept as history, in Past.
    await expect(pastSection.getByText(MT.past.tournamentName, { exact: true })).toBeVisible();
    // And it must NOT also show up under Upcoming.
    await expect(upcomingSection.getByText(MT.past.tournamentName, { exact: true })).toHaveCount(0);
  });

  test("each row shows the tournament's events, status, and links to the tournament page (AC 3)", async ({
    page,
  }) => {
    await loginAs(page, MT.viewerEmail);
    await page.goto("/my-tournaments");

    // Upcoming card: one doubles reg (paid, still seeking a partner) and one
    // singles reg (pending payment) — covers all three AC-named statuses
    // between the two cards under test.
    const upcomingCard = cardFor(page, MT.upcoming.tournamentName);
    await expect(upcomingCard.getByText(MT.upcoming.doublesEventName, { exact: true })).toBeVisible();
    await expect(upcomingCard.getByText(MT.upcoming.doublesStatusLabel, { exact: true })).toBeVisible();
    await expect(upcomingCard.getByText(MT.upcoming.singlesEventName, { exact: true })).toBeVisible();
    await expect(upcomingCard.getByText(MT.upcoming.singlesStatusLabel, { exact: true })).toBeVisible();

    const upcomingLink = upcomingCard.getByRole("link", { name: /view tournament/i });
    await expect(upcomingLink).toHaveAttribute(
      "href",
      `/t/${SEED.orgSlug}/${MT.upcoming.tournamentSlug}`,
    );

    // Past card: paid singles reg.
    const pastCard = cardFor(page, MT.past.tournamentName);
    await expect(pastCard.getByText(MT.past.eventName, { exact: true })).toBeVisible();
    await expect(pastCard.getByText(MT.past.statusLabel, { exact: true })).toBeVisible();

    const pastLink = pastCard.getByRole("link", { name: /view tournament/i });
    await expect(pastLink).toHaveAttribute("href", `/t/${SEED.orgSlug}/${MT.past.tournamentSlug}`);
  });

  test("a player with no registrations sees a friendly empty state with a link to browse (AC 4)", async ({
    page,
  }) => {
    await loginAs(page, MT.emptyEmail);
    await page.goto("/my-tournaments");

    await expect(
      page.getByText("You haven't registered for any tournaments yet.", { exact: true }),
    ).toBeVisible();
    const browseLink = page.getByRole("link", { name: "Browse upcoming events" });
    await expect(browseLink).toBeVisible();
    await expect(browseLink).toHaveAttribute("href", "/");
  });

  test("only the player's own registrations are shown — another player's tournament never leaks (AC 5)", async ({
    page,
  }) => {
    await loginAs(page, MT.viewerEmail);
    await page.goto("/my-tournaments");

    // Sanity: the page did load Mia's own data (a false negative below would
    // be meaningless if the page rendered nothing at all).
    await expect(page.getByText(MT.upcoming.tournamentName, { exact: true })).toBeVisible();

    // Otto's tournament — Mia has no registration in it — must not appear
    // anywhere on her page.
    await expect(page.getByText(MT.otherPlayerTournamentName, { exact: true })).toHaveCount(0);
  });
});
