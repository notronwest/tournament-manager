import { test, expect, loginAs, gotoRegister, SEED } from "../fixtures";
import type { Page, Locator, TestInfo } from "@playwright/test";

// Mobile audit — runs on the iphone (iPhone 13 / WebKit) + pixel (Pixel 5 /
// Chromium) projects (see playwright.config.ts), ~390px touch viewports.
//
// This used to be screenshot-ONLY: it logged horizontal page overflow and
// attached PNGs for a human to eyeball. That heuristic is blind to the worst
// breaks — a *clipped* (vs scrolled) layout reports ZERO overflow — which is
// exactly how the bugs that reached Ron slipped through (one-char-per-line
// EventCard text at 390px; the checkout "Continue to payment" button clipped
// off the right edge of a 1fr/320px grid that never stacked).
//
// Now the assertions ARE the test. Screenshots stay, but only as debugging
// artifacts. Each gate runs against a POPULATED state — an empty page passing
// proves nothing.

// Attach a full-page screenshot + log horizontal overflow for debugging. No
// longer a gate — just an artifact on the HTML report.
async function snap(page: Page, ti: TestInfo, name: string) {
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  const overflow = await page.evaluate(() =>
    Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
  );
  const vw = page.viewportSize()?.width;
  console.log(
    `[mobile-audit] ${ti.project.name} | ${name} | viewport=${vw}px | horizontal_overflow=${overflow}px`,
  );
  await ti.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

// A primary CTA must be usable on a phone: present, reachable in the viewport,
// NOT clipped past the right edge (the checkout-button bug), and a ≥44px tap
// target (DESIGN_PREFERENCES hard rule).
async function assertCtaUsable(page: Page, cta: Locator, label: string) {
  await expect(cta, `${label}: visible`).toBeVisible();
  await cta.scrollIntoViewIfNeeded();
  await expect(cta, `${label}: reachable in viewport`).toBeInViewport();
  const box = await cta.boundingBox();
  expect(box, `${label}: has a bounding box`).not.toBeNull();
  const vw = page.viewportSize()!.width;
  const right = Math.round(box!.x + box!.width);
  // Right edge within the viewport — catches a horizontally-clipped CTA, the
  // failure mode the old overflow heuristic missed.
  expect(right, `${label}: right edge ${right}px must be ≤ viewport ${vw}px`).toBeLessThanOrEqual(vw + 1);
  expect(Math.round(box!.x), `${label}: left edge on-screen`).toBeGreaterThanOrEqual(-1);
  // Tap target height.
  expect(
    Math.round(box!.height),
    `${label}: tap target height ${Math.round(box!.height)}px must be ≥ 44px`,
  ).toBeGreaterThanOrEqual(44);
}

// A column that's supposed to stack on mobile must not be squeezed to ~0. A
// 1fr/320px grid that never collapsed leaves the content column a few dozen
// px wide and wraps its text one character per line. Floor it.
async function assertColumnNotCollapsed(
  col: Locator,
  label: string,
  floor = 200,
) {
  await expect(col, `${label}: present`).toBeVisible();
  const width = await col.evaluate((el) => (el as HTMLElement).clientWidth);
  expect(
    width,
    `${label}: rendered width ${width}px must be > ${floor}px (column collapsed?)`,
  ).toBeGreaterThan(floor);
}

test.describe("mobile audit — layout assertions", () => {
  // ── Populated checkout: the 1fr/320px grid must stack, and the pay button
  //    must not be clipped off the right edge. This is the spec that fails on
  //    the pre-fix checkout layout and passes after the responsive fix.
  test("checkout (populated): content stacks + pay CTA usable", async ({
    page,
  }, ti) => {
    await loginAs(page, SEED.selfService.viewerEmail);
    await page.goto(`/t/${SEED.orgSlug}/e2e-self-service/checkout`);
    await snap(page, ti, "checkout-populated");

    await assertColumnNotCollapsed(
      page.getByTestId("checkout-content-col"),
      "checkout content column",
    );
    // Free or paid, the primary action sits at the foot of the order summary.
    const payCta = page.getByRole("button", {
      name: /continue to payment|confirm registration/i,
    });
    await assertCtaUsable(page, payCta, "checkout primary CTA");
  });

  // ── Populated EventCard: a pending registration renders the action cluster
  //    (Cancel Registration [+ Change partner]) beside the meta. This is the
  //    card that collapsed to one-char-per-line at 390px (#500). The button
  //    being a usable, un-clipped tap target proves the row stacked.
  test("register tab — pending card actions usable", async ({ page }, ti) => {
    await loginAs(page, SEED.selfService.viewerEmail);
    await gotoRegister(page, SEED.orgSlug, "e2e-self-service");
    await snap(page, ti, "register-pending-card");

    const cancel = page
      .getByRole("button", { name: /cancel registration/i })
      .first();
    await assertCtaUsable(page, cancel, "pending card — Cancel Registration");
  });

  // ── Register CTA on a populated tournament's Register tab.
  test("register tab — Register CTA usable", async ({ page }, ti) => {
    await gotoRegister(page);
    await snap(page, ti, "tournament-register-tab");

    const register = page.getByRole("button", { name: /^register$/i }).first();
    await assertCtaUsable(page, register, "event Register CTA");
  });
});

// ── Screenshot-only smoke captures (artifacts, not gates) for the rest of the
//    surface. Kept so the audit still produces phone-width PNGs for review.
test.describe("mobile audit — screenshots", () => {
  test("home", async ({ page }, ti) => {
    await page.goto("/");
    await snap(page, ti, "home");
  });

  test("login", async ({ page }, ti) => {
    await page.goto("/login");
    await snap(page, ti, "login");
  });

  test("tournament — details tab", async ({ page }, ti) => {
    await page.goto(`/t/${SEED.orgSlug}/${SEED.tournamentSlug}`);
    await snap(page, ti, "tournament-details");
  });

  test("register form + partner sheet", async ({ page }, ti) => {
    await loginAs(page, SEED.existingPartner.registrantEmail);
    await gotoRegister(page, SEED.orgSlug, SEED.existingPartner.tournamentSlug);
    await page.getByRole("button", { name: /^register$/i }).click();
    await snap(page, ti, "register-form");
    const trigger = page.getByRole("button", {
      name: /choose a doubles partner/i,
    });
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click();
      await snap(page, ti, "partner-sheet");
    }
  });

  test("my-tournaments", async ({ page }, ti) => {
    await loginAs(page, SEED.playerEmail);
    await page.goto("/my-tournaments");
    await snap(page, ti, "my-tournaments");
  });

  test("profile", async ({ page }, ti) => {
    await loginAs(page, SEED.playerEmail);
    await page.goto("/profile");
    await snap(page, ti, "profile");
  });
});
