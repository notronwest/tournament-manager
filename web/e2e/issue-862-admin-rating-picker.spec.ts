import { test, expect, loginAs, admin, SEED } from "./fixtures";

// Regression for issue #862 — "Admin player profile editor should use the
// same rating picker and gender UX as the player's Profile page." Translated
// from the issue's ## Acceptance criteria (org-scoped admin view: an org
// owner opening a player who is registered in their org — see
// resolvePlayerAccess in supabase/functions/_shared/playerOrgAccess.ts — gets
// the same PlayerDetailPage the platform-admin view uses).
//
// The seeded player (SEED.playerEmail) has a registration in the main seeded
// tournament, so Olive (SEED.organizerEmail, an owner of SEED.orgSlug) has
// org-scoped access to their admin player page without any platform_admins
// seed row.

async function seededPlayerId(): Promise<string> {
  const { data, error } = await admin()
    .from("players")
    .select("id")
    .eq("email", SEED.playerEmail)
    .single();
  if (error || !data) throw new Error(`seeded player not found: ${error?.message}`);
  return (data as { id: string }).id;
}

test.describe("#862 admin player profile: rating picker + gender parity", () => {
  test("Doubles/Mixed/Singles use the RatingPicker chip control, and a change round-trips through save", async ({
    page,
  }) => {
    const playerId = await seededPlayerId();
    await loginAs(page, SEED.organizerEmail);
    await page.goto(`/admin/players/${playerId}?org=${SEED.orgSlug}`);

    // AC 1 — same component (chip radiogroup, not a number box) for all three
    // rating fields, with the Profile page's labels.
    const doubles = page.getByRole("radiogroup", { name: /doubles self-rating/i });
    const mixed = page.getByRole("radiogroup", { name: /mixed doubles self-rating/i });
    const singles = page.getByRole("radiogroup", { name: /singles self-rating/i });
    await expect(doubles).toBeVisible();
    await expect(mixed).toBeVisible();
    await expect(singles).toBeVisible();
    // Chip labels are the scale values, not a free-text box.
    await expect(doubles.getByRole("radio", { name: "4.0" })).toBeVisible();

    // AC 2 — gender uses the Profile page's control + inclusive wording.
    const genderSelect = page.getByLabel(/gender/i);
    await expect(genderSelect).toBeVisible();
    await expect(genderSelect.locator("option", { hasText: /other.*prefer not to say/i })).toHaveCount(1);

    const saveBtn = page.getByRole("button", { name: /^save profile$/i });

    // AC 3 — Save stays disabled until something changes.
    await expect(saveBtn).toBeDisabled();

    const chip40 = doubles.getByRole("radio", { name: "4.0" });
    const wasSelected = (await chip40.getAttribute("aria-checked")) === "true";
    await chip40.click(); // toggles: sets 4.0, or clears it if it was already 4.0
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    await expect(page.getByText(/^saved/i)).toBeVisible();

    // Reload — the saved value (number or null) persists exactly as stored,
    // not just held in local component state.
    await page.reload();
    const chip40Again = page.getByRole("radiogroup", { name: /doubles self-rating/i }).getByRole("radio", { name: "4.0" });
    await expect(chip40Again).toHaveAttribute("aria-checked", wasSelected ? "false" : "true");

    // Restore the original value so this spec is idempotent across reruns.
    await chip40Again.click();
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    await expect(page.getByText(/^saved/i)).toBeVisible();
  });

  test("AC 4 — at 390px the rating chips wrap onto more than one row instead of clipping", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const playerId = await seededPlayerId();
    await loginAs(page, SEED.organizerEmail);
    await page.goto(`/admin/players/${playerId}?org=${SEED.orgSlug}`);

    const doubles = page.getByRole("radiogroup", { name: /doubles self-rating/i });
    await expect(doubles).toBeVisible();
    const chips = doubles.getByRole("radio");
    const count = await chips.count();
    expect(count).toBeGreaterThan(1);

    const boxes = await Promise.all(
      Array.from({ length: count }, (_, i) => chips.nth(i).boundingBox()),
    );
    const tops = boxes.map((b) => b?.y ?? 0);
    const rights = boxes.map((b) => (b?.x ?? 0) + (b?.width ?? 0));

    // Clipping ≠ overflow: a fixed-width row that clips instead of wrapping
    // would keep every chip on the same top offset. Assert real wrapping —
    // more than one distinct row — not just "no page-level scrollbar".
    expect(new Set(tops).size).toBeGreaterThan(1);
    // And no chip is clipped off past the 390px viewport.
    for (const right of rights) {
      expect(right).toBeLessThanOrEqual(390);
    }
  });
});
