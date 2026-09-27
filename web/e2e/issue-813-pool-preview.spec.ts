/**
 * issue-813-pool-preview.spec.ts (#813) — "Event form: show registered team
 * count and the per-pool split when choosing pools."
 *
 * Translated 1:1 from the issue's `## Acceptance criteria`:
 *   AC1 — Edit event with registrations: pool-play section shows
 *         "N teams registered (X complete · Y still forming) · cap M",
 *         counting spot-holding registrations only.
 *   AC2 — Below it, the current pool count previews as a split of registered
 *         teams (e.g. "2 pools → 3 + 3 teams"); changing the pool dropdown
 *         updates the preview instantly (no save/reload).
 *   AC3 — A pool split below 4 teams warns amber; below 3 warns red.
 *   AC4 — Edit event with zero registrations: "No registrations yet —
 *         planning on Max teams (M); revisit once teams sign up", previewing
 *         the split on M instead.
 *   AC5 (390px wrap) is covered by the mobile-audit layout specs, not here.
 *
 * Fixtures (e2e/seed.ts §11 via SEED.poolPreview): a dedicated tournament
 * with two events — one with 6 registered teams (4 confirmed pairs + 2
 * still-forming singles) under a 20-team cap (AC1-3), one with zero
 * registrations under a 12-team cap (AC4). Read-only spec (no registrations
 * or event settings are mutated), so it's safe to share across runs/retries.
 */
import { test, expect, admin, loginAs, SEED } from "./fixtures";

const P = SEED.poolPreview;

async function eventEditUrl(eventName: string): Promise<string> {
  const db = admin();
  const { data: t, error: tErr } = await db
    .from("tournaments")
    .select("id")
    .eq("slug", P.tournamentSlug)
    .single();
  if (tErr || !t) throw new Error(`lookup tournament ${P.tournamentSlug}: ${tErr?.message}`);
  const { data: ev, error: eErr } = await db
    .from("events")
    .select("id")
    .eq("tournament_id", t.id)
    .eq("name", eventName)
    .single();
  if (eErr || !ev) throw new Error(`lookup event ${eventName}: ${eErr?.message}`);
  return `/admin/${SEED.orgSlug}/tournaments/${P.tournamentSlug}/events/${ev.id}/edit`;
}

test.describe("#813 pool-count preview on EventFormPage", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, P.adminEmail);
  });

  test("registered-team count, default single-pool preview, and live amber/red warnings (AC 1, 2, 3)", async ({
    page,
  }) => {
    await page.goto(await eventEditUrl(P.eventName));

    // AC 1 — spot-holding-only registered count, split complete/forming, cap.
    await expect(page.getByText(`${P.registeredTeams} teams registered`)).toBeVisible();
    await expect(page.getByText(`${P.completeTeams} complete`, { exact: false })).toBeVisible();
    await expect(page.getByText(`${P.formingTeams} still forming`, { exact: false })).toBeVisible();
    await expect(page.getByText(`cap ${P.maxTeams}`, { exact: false })).toBeVisible();

    // AC 2 — default pool count (1) previews the full registered count,
    // no warning (a single pool never warns).
    await expect(page.getByText("1 pool", { exact: false })).toBeVisible();
    await expect(page.locator("strong", { hasText: `${P.registeredTeams}` })).toBeVisible();
    await expect(page.getByText(/below the 4-team minimum|too small to play/i)).toHaveCount(0);

    // AC 2/3 — 2 pools of 6 registered teams → 3 + 3, amber (below the
    // 4-team minimum, but not so small it can't play).
    await page.getByLabel("Number of pools").selectOption({ label: "2 pools" });
    await expect(page.locator("strong", { hasText: "3 + 3" })).toBeVisible();
    await expect(page.getByText(/a pool of 3 — below the 4-team minimum/i)).toBeVisible();

    // AC 2/3 — 3 pools of 6 registered teams → 2 + 2 + 2, red (too small to
    // play). Confirms the preview updates instantly on each dropdown change,
    // not just once.
    await page.getByLabel("Number of pools").selectOption({ label: "3 pools" });
    await expect(page.locator("strong", { hasText: "2 + 2 + 2" })).toBeVisible();
    await expect(page.getByText(/a pool of 2 — too small to play/i)).toBeVisible();
  });

  test("zero registrations plans on Max teams instead (AC 4)", async ({ page }) => {
    await page.goto(await eventEditUrl(P.zeroRegEventName));

    await expect(page.getByText("No registrations yet", { exact: false })).toBeVisible();
    await expect(
      page.getByText(`planning on Max teams (${P.zeroRegMaxTeams})`, { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("teams registered", { exact: false })).toHaveCount(0);

    // Preview splits the 12-team cap, not a registered count of 0.
    await expect(page.locator("strong", { hasText: `${P.zeroRegMaxTeams}` })).toBeVisible();
  });
});
