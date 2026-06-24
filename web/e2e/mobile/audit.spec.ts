import { test, loginAs, gotoRegister, SEED } from "../fixtures";
import type { Page, TestInfo } from "@playwright/test";

// Mobile visual audit — runs on the iphone + pixel projects (see
// playwright.config.ts). For each key page it logs horizontal overflow (the #1
// mobile bug) and attaches a full-page screenshot to the HTML report for review.
// Intentionally assertion-free: it captures, it doesn't gate.

async function snap(page: Page, ti: TestInfo, name: string) {
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  const overflow = await page.evaluate(() =>
    Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
  );
  const vw = page.viewportSize()?.width;
  console.log(`[mobile-audit] ${ti.project.name} | ${name} | viewport=${vw}px | horizontal_overflow=${overflow}px`);
  await ti.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

test.describe("mobile audit", () => {
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

  test("tournament — register tab", async ({ page }, ti) => {
    await gotoRegister(page);
    await snap(page, ti, "tournament-register-tab");
  });

  test("register form + partner sheet", async ({ page }, ti) => {
    await loginAs(page, SEED.existingPartner.registrantEmail);
    await gotoRegister(page, SEED.orgSlug, SEED.existingPartner.tournamentSlug);
    await page.getByRole("button", { name: /^register$/i }).click();
    await snap(page, ti, "register-form");
    // Mobile shows a "Choose a doubles partner" sheet trigger; open it.
    const trigger = page.getByRole("button", { name: /choose a doubles partner/i });
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click();
      await snap(page, ti, "partner-sheet");
    }
  });

  test("checkout", async ({ page }, ti) => {
    await loginAs(page, SEED.playerEmail);
    await page.goto(`/t/${SEED.orgSlug}/${SEED.tournamentSlug}/checkout`);
    await snap(page, ti, "checkout");
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
