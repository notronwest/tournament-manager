/**
 * issue-55-eligibility-guard.spec.ts (#55) — "Eligibility: client-side guard
 * at registration (UX)."
 *
 * `checkEligibility(player, event)` (web/src/lib/eligibility.ts) gates the
 * public register control on PublicTournamentPage: an ineligible player never
 * sees the "Register" button at all — it's replaced by a plain
 * "Not eligible: <reasons>" span naming the specific failing gate(s).
 * Translated 1:1 from the issue's `## Acceptance criteria`:
 *   AC1 — a rating-range miss blocks with a message naming the rating gate.
 *   AC2 — a gender-restriction miss blocks with a message naming the gender
 *         gate; mixed/open events never gate on gender (covered by AC3's
 *         mixed-event fixture, which also carries a set gender).
 *   AC3 — an eligible player registers normally with no eligibility message.
 *   AC4 — scope note only (server enforcement is #56) — nothing to assert.
 *
 * Each test seeds its own tournament/event/player via `seedRegistration`
 * (../registration-fixtures, #950/#936) so the single event card on the
 * Register tab is unambiguous and never shared across runs.
 */
import { expect, loginAs, gotoRegister } from "./fixtures";
import { test } from "./registration-fixtures";

test.describe("#55 eligibility guard at registration", () => {
  test("rating-range miss blocks with the rating gate named (AC 1)", async ({
    page,
    seedRegistration,
  }) => {
    const fixture = await seedRegistration("ratingGate");
    await loginAs(page, fixture.registrantEmail);
    await gotoRegister(page, fixture.orgSlug, fixture.tournamentSlug);

    await expect(page.getByText(/not eligible.*needs rating 3\.5–4\.0/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^register$/i })).not.toBeVisible();
  });

  test("gender-restriction miss blocks with the gender gate named (AC 2)", async ({
    page,
    seedRegistration,
  }) => {
    const fixture = await seedRegistration("genderGate");
    await loginAs(page, fixture.registrantEmail);
    await gotoRegister(page, fixture.orgSlug, fixture.tournamentSlug);

    await expect(page.getByText(/not eligible.*men's event/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^register$/i })).not.toBeVisible();
  });

  test("an eligible player sees no eligibility message and registers normally (AC 3)", async ({
    page,
    seedRegistration,
  }) => {
    const fixture = await seedRegistration("eligible");
    await loginAs(page, fixture.registrantEmail);
    await gotoRegister(page, fixture.orgSlug, fixture.tournamentSlug);

    await expect(page.getByText(/not eligible/i)).not.toBeVisible();
    await expect(page.getByRole("button", { name: /^register$/i })).toBeVisible();
  });
});
