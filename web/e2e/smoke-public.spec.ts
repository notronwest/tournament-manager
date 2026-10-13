import { expect, test } from "@playwright/test";

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

const PAGES = [
  { name: "home", path: "/", expect: /pickleball/i },
  {
    name: "public tournament recap",
    path: "/t/wmpc/2nd-annual-leaf-peeper-tournament/recap",
    expect: /Leaf Peeper/i,
  },
  { name: "credit landing", path: "/t/wmpc/credit", expect: /credit/i },
];

for (const page_ of PAGES) {
  test(`smoke: ${page_.name} renders`, async ({ page }) => {
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
