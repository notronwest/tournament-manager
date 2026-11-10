import { expect, test } from "@playwright/test";
import { SEED } from "./fixtures";

/**
 * POST-DEPLOY SMOKE — does the page actually RENDER?
 *
 * On 2026-10-09 a promotion shipped a public recap page that threw
 * `ReferenceError: cream is not defined` on every load and rendered nothing.
 * Three CI jobs reported success: migrations green, edge functions green,
 * deploy green. All three were telling the truth about their own step, and the
 * page was blank. Ron found it, hours later, by opening it.
 *
 * Every check we had asked "did my step finish?". None asked "is the thing we
 * just shipped actually there?" (D-0083). This asks that, and only that:
 *   · the page responds
 *   · it has VISIBLE TEXT, not just an HTML shell — this is an SPA, so a blank
 *     page still returns 200 with a perfectly good document
 *   · nothing threw in the console
 *
 * Deliberately NOT a feature test. It is the two-second check I skipped.
 */

// Two targets, two data sets. Post-deploy smoke (post-deploy-smoke.yml) points
// this at PRODUCTION, where the real Leaf Peeper recap exists and the credit
// offer is switched on. The nightly regression points the same file at TEST,
// which holds only seeded fixtures (seed.ts) and keeps VITE_CREDIT_OFFER off —
// so there the recap is the seeded completed tournament and /credit correctly
// says "isn't available". Asserting production's content on TEST made both
// recap/credit checks fail every night for a reason that was not a bug.
const IS_PROD = /(^|\/\/|\.)bertanderne\.com/i.test(process.env.E2E_BASE_URL ?? "");

const PAGES = [
  { name: "home", path: "/", expect: /pickleball/i, skip: false },
  IS_PROD
    ? {
        name: "public tournament recap",
        path: "/t/wmpc/2nd-annual-leaf-peeper-tournament/recap",
        expect: /Leaf Peeper/i,
        skip: false,
      }
    : {
        name: "public tournament recap",
        path: `/t/${SEED.orgSlug}/${SEED.recap.tournamentSlug}/recap`,
        expect: /E2E Recap Cup/i,
        skip: false,
      },
  // The credit offer is flag-gated and OFF on TEST by design (see
  // featureFlags.ts); only production turns it on.
  { name: "credit landing", path: "/t/wmpc/credit", expect: /credit/i, skip: !IS_PROD },
];

for (const page_ of PAGES) {
  test(`smoke: ${page_.name} renders`, async ({ page }) => {
    test.skip(page_.skip, "credit offer is flag-gated off on TEST by design");
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    const res = await page.goto(page_.path, { waitUntil: "networkidle" });
    expect(res?.status(), `${page_.path} HTTP status`).toBeLessThan(400);

    // The real assertion. A white screen of death is a 200 with an empty body.
    const text = (await page.locator("body").innerText()).trim();
    expect(text.length, `${page_.path} rendered no visible text`).toBeGreaterThan(80);
    expect(text).toMatch(page_.expect);

    expect(errors, `${page_.path} threw in the console`).toEqual([]);
  });
}
