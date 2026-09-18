/**
 * issue-860-reopen-registration.spec.ts (#860) — "Moving the registration
 * deadline into the future doesn't reopen a tournament the auto-close
 * already closed."
 *
 * The fix lives in TournamentWizardPage's saveBasics (see
 * web/src/pages/admin/TournamentWizardPage.tsx): saving the Basics step on a
 * CLOSED tournament reopens it (status -> 'published') ONLY when the new
 * registration_closes_at is both in the future AND later than the old one —
 * i.e. the organizer is deliberately pushing the deadline out. An unrelated
 * edit that leaves the deadline alone (including a tournament closed early
 * via "Close registration" while its deadline is still in the future) must
 * NOT reopen it.
 *
 * Fixtures (e2e/seed.ts §10 via SEED.reopen): two tournaments, both seeded
 * status='closed' so every run starts from a known state —
 *   pastDeadline    — registration_closes_at already in the past.
 *   futureDeadline  — registration_closes_at still in the future.
 */
import { test, expect, admin, loginAs, SEED } from "./fixtures";
import type { Page } from "@playwright/test";

const R = SEED.reopen;
let _db: ReturnType<typeof admin> | null = null;
const db = () => (_db ??= admin());

type TournamentRow = {
  status: string;
  registration_closes_at: string | null;
  description: string | null;
};

async function tournamentBySlug(slug: string): Promise<TournamentRow> {
  const { data, error } = await db()
    .from("tournaments")
    .select("status, registration_closes_at, description")
    .eq("slug", slug)
    .is("deleted_at", null)
    .limit(1);
  if (error) throw new Error(error.message);
  return data?.[0] as TournamentRow;
}

async function gotoBasics(page: Page, slug: string) {
  await page.goto(`/admin/${SEED.orgSlug}/tournaments/${slug}/wizard/basics`);
  // Loading state resolves once the "Registration closes" field is present.
  await expect(page.getByLabel("Registration closes")).toBeVisible();
}

test.describe("reopen registration on Basics edit (#860)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, R.adminEmail);
  });

  test("pushing the deadline into the future reopens a closed tournament (AC 1, 3, 4)", async ({ page }) => {
    const before = await tournamentBySlug(R.pastDeadline.tournamentSlug);
    expect(before.status).toBe("closed");

    await gotoBasics(page, R.pastDeadline.tournamentSlug);
    await page.getByLabel("Registration closes").fill("2099-12-31T10:00");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // AC 1 — save confirmation names the reopen.
    await expect(page.getByRole("status")).toContainText(/Registration reopened/i);
    // AC 1 — the rail's own status pill flips to "published" too.
    await expect(page.getByText("published", { exact: true })).toBeVisible();

    const after = await tournamentBySlug(R.pastDeadline.tournamentSlug);
    expect(after.status).toBe("published");
    expect(new Date(after.registration_closes_at!).getFullYear()).toBe(2099);

    // AC 3 — public tournament page shows registration open immediately.
    await page.goto(`/t/${SEED.orgSlug}/${R.pastDeadline.tournamentSlug}`);
    await expect(page.getByText("Registration Open", { exact: true })).toBeVisible();

    // AC 3 — homepage card shows the same.
    await page.goto("/");
    const card = page.getByRole("link").filter({ hasText: R.pastDeadline.tournamentName });
    await expect(card).toBeVisible();
    await expect(card.getByText("Registration Open", { exact: true })).toBeVisible();

    // AC 4 — the tournament page header still offers the normal published-
    // state control (Close registration), i.e. reopening didn't leave the
    // status actions in a broken state.
    await page.goto(`/admin/${SEED.orgSlug}/tournaments/${R.pastDeadline.tournamentSlug}`);
    await expect(page.getByRole("button", { name: "Close registration" })).toBeVisible();
  });

  test("an unrelated Basics edit does not reopen a tournament closed early with a future deadline (AC 2, 4)", async ({ page }) => {
    const before = await tournamentBySlug(R.futureDeadline.tournamentSlug);
    expect(before.status).toBe("closed");
    expect(new Date(before.registration_closes_at!).getTime()).toBeGreaterThan(Date.now());

    await gotoBasics(page, R.futureDeadline.tournamentSlug);
    // Edit something unrelated to the registration window.
    const newDescription = `Updated by #860 spec at ${Date.now()}`;
    await page.getByLabel("Description").fill(newDescription);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "✓ Saved" })).toBeVisible();

    // AC 2 — no reopen notice, status stays closed, deadline untouched.
    await expect(page.getByRole("status")).toHaveCount(0);
    const after = await tournamentBySlug(R.futureDeadline.tournamentSlug);
    expect(after.status).toBe("closed");
    expect(after.registration_closes_at).toBe(before.registration_closes_at);
    expect(after.description).toBe(newDescription);

    // AC 4 — header still offers "Reopen registration" (still closed, not
    // silently flipped open by the edit).
    await page.goto(`/admin/${SEED.orgSlug}/tournaments/${R.futureDeadline.tournamentSlug}`);
    await expect(page.getByRole("button", { name: "Reopen registration" })).toBeVisible();

    // Public page still reads closed, not accidentally reopened.
    await page.goto(`/t/${SEED.orgSlug}/${R.futureDeadline.tournamentSlug}`);
    await expect(page.getByText("Registration Closed", { exact: true })).toBeVisible();
  });
});
