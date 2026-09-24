/**
 * issue-12-pricing-preview.spec.ts (#12) — "Pricing model misconfiguration is
 * easy to make (clarify in admin form)."
 *
 * `events.event_fee_cents` is a per-event flat OVERRIDE, not a surcharge
 * added on top of the tournament's entry fee — a model that reads two ways
 * and led organizers to misconfigure pricing. Translated 1:1 from the
 * issue's `## Acceptance criteria`:
 *   AC1/2 — EventFormPage's event-fee field shows explicit inline "override"
 *           helper text (not tooltip-only), using the word "override" and
 *           avoiding "surcharge"/"additional" phrasing that reads as
 *           add-on-top.
 *   AC3   — A "Preview math" box on the tournament pricing step shows the
 *           computed total for 1 and 2 (and 3) events at the current tiers,
 *           reusing web/src/lib pricing math (PricingTiersEditor.tsx).
 *   AC4   — copy/UI only; not re-asserting pricing math itself here (that's
 *           covered by the existing checkout/registration specs) beyond
 *           confirming the numbers shown match the seeded tiers.
 *   AC5   — typecheck/build are a CI concern, not part of this spec.
 *
 * Fixtures (e2e/seed.ts §10 via SEED.pricingPreview): a dedicated tournament
 * with a real (non-$0) pricing tier and one event with a non-zero fee
 * override, so the preview renders computed dollar amounts instead of the
 * "Free tournament" branch. Read-only spec — no registrations touch it, so
 * it's safe to share across runs/retries without the shared-state race
 * tracked in #936.
 */
import { test, expect, admin, loginAs, SEED } from "./fixtures";

const P = SEED.pricingPreview;

test.describe("#12 pricing-model clarity in the admin forms", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, P.adminEmail);
  });

  test("event-fee field shows explicit, always-visible OVERRIDE copy (AC 1, 2)", async ({
    page,
  }) => {
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
      .eq("name", P.eventName)
      .single();
    if (eErr || !ev) throw new Error(`lookup event ${P.eventName}: ${eErr?.message}`);

    await page.goto(`/admin/${SEED.orgSlug}/tournaments/${P.tournamentSlug}/events/${ev.id}/edit`);

    // AC 1 — visible inline near the field, not tooltip-only: no hover/focus
    // needed for this to already be in the DOM and visible.
    const hint = page.getByText(/leave at \$0\.00 to use the tournament/i);
    await expect(hint).toBeVisible();

    // AC 2 — uses the word "override" for the non-zero behavior, and must
    // not describe it as a surcharge/addition on top of the entry fee.
    await expect(hint).toContainText(/override/i);
    await expect(hint).not.toContainText(/surcharge/i);
    await expect(hint).not.toContainText(/on top of/i);

    // The seeded event carries a non-zero override (AC 1's "set a value"
    // case) — the warning box names the flat amount charged.
    await expect(page.getByText(/flat override active/i)).toBeVisible();
    await expect(page.getByText(P.eventOverrideUsd, { exact: false })).toBeVisible();
  });

  test('tournament pricing step shows a "Preview math" box with computed 1/2/3-event totals (AC 3)', async ({
    page,
  }) => {
    await page.goto(`/admin/${SEED.orgSlug}/tournaments/${P.tournamentSlug}/wizard/pricing`);

    await expect(page.getByText(/preview math/i)).toBeVisible();

    // AC 3 — computed total for 1 event and for 2 events (the component also
    // shows a 3rd data point, which is a superset of the AC, not a gap).
    await expect(page.getByText(/entry \(1 event\)/i)).toBeVisible();
    await expect(page.getByText(P.firstEventFeeUsd, { exact: false })).toBeVisible();
    await expect(page.getByText("2 events", { exact: true })).toBeVisible();
    await expect(page.getByText(P.twoEventsUsd, { exact: false })).toBeVisible();
    await expect(page.getByText("3 events", { exact: true })).toBeVisible();
    await expect(page.getByText(P.threeEventsUsd, { exact: false })).toBeVisible();
  });
});
