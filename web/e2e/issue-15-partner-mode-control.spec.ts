import { test, expect, loginAs, gotoRegister, tapClear, SEED } from "./fixtures";

// Regression for issue #15 — the "Pick a partner / I need a partner" toggle
// must render as one real selection control (segmented/radio), not two
// separate-looking action buttons. Translated 1:1 from the issue's
// ## Acceptance criteria against the live markup in PublicTournamentPage.tsx:
// a `role="radiogroup"` of two `role="radio"` tiles (partnerModeTileStyle),
// aria-checked driving both the highlight color and which sub-UI shows.

const ACTIVE_BORDER = "rgb(37, 99, 235)"; // #2563eb
const INACTIVE_BORDER = "rgb(209, 213, 219)"; // #d1d5db

test.describe("#15 partner-mode segmented control", () => {
  test("renders as one radiogroup, highlights the selected option, and swaps the sub-UI", async ({
    page,
  }) => {
    await loginAs(page, SEED.partnerMode.registrantEmail);
    await gotoRegister(page, SEED.orgSlug, SEED.partnerMode.tournamentSlug);

    await tapClear(page.getByRole("button", { name: /^register$/i }));

    // AC 1 — one selection control, not two action buttons: a single
    // radiogroup containing exactly the two options.
    const group = page.getByRole("radiogroup", { name: /partner mode/i });
    await expect(group).toBeVisible();
    const havePartner = group.getByRole("radio", { name: /i have a partner/i });
    const needPartner = group.getByRole("radio", { name: /i need a partner/i });
    await expect(group.getByRole("radio")).toHaveCount(2);

    // AC 2 — the currently-selected option is visually highlighted. Default
    // is "I have a partner": checked + the active border color; the other
    // option unchecked + the inactive border color.
    await expect(havePartner).toHaveAttribute("aria-checked", "true");
    await expect(needPartner).toHaveAttribute("aria-checked", "false");
    await expect(havePartner).toHaveCSS("border-color", ACTIVE_BORDER);
    await expect(needPartner).toHaveCSS("border-color", INACTIVE_BORDER);

    // AC 3 — "I have a partner" shows the partner picker.
    await expect(
      page.getByPlaceholder(/search by name, email, or phone/i),
    ).toBeVisible();
    await expect(
      page.getByText(/we'll register you for this event without a partner/i),
    ).toHaveCount(0);

    await needPartner.click();

    // AC 2 — highlight flips to the newly-selected option.
    await expect(needPartner).toHaveAttribute("aria-checked", "true");
    await expect(havePartner).toHaveAttribute("aria-checked", "false");
    await expect(needPartner).toHaveCSS("border-color", ACTIVE_BORDER);
    await expect(havePartner).toHaveCSS("border-color", INACTIVE_BORDER);

    // AC 3 — "I need a partner" shows the seeker sub-UI instead of the picker.
    await expect(
      page.getByText(/we'll register you for this event without a partner/i),
    ).toBeVisible();
    await expect(
      page.getByPlaceholder(/search by name, email, or phone/i),
    ).toHaveCount(0);
  });
});
