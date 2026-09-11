// web/e2e/offline/network-audit.spec.ts
//
// The verification harness for issue #735 (epic #732 -- run Bert & Erne
// fully offline at a venue with no Internet). Drives a full mock event
// through the admin UI -- create a tournament + event, seed 4 teams, run
// the round robin, run the top-4 playoff, see medals awarded -- while every
// request the browser makes is inspected, and FAILS if anything tries to
// reach a host other than localhost/127.0.0.1.
//
// This is a SEPARATE suite from web/e2e/flows/*, run with its own config
// (playwright.offline.config.ts) against the LOCAL offline runtime
// (scripts/offline.sh), never the deployed app -- see docs/OFFLINE.md:
//
//   1. ./scripts/offline.sh                              # start it
//   2. OFFLINE_BASE_URL=http://localhost:5173 \
//        npm run test:e2e:offline                        # (from web/)
//
// "Network interface down" is simulated deterministically at the browser
// level -- Playwright can't toggle the real network interface -- by
// aborting every request whose host isn't local, exactly as a real
// disconnected interface would fail them, and recording each one. The
// assertion at the end is the issue's own acceptance bar: zero such
// requests. This is the repeatable, automatable half of the verification;
// still do the real Wi-Fi-off dry run per docs/OFFLINE.md before trusting a
// laptop to it at the venue.
import { test, expect, type Page } from "@playwright/test";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

test("a full mock event runs to completion with zero non-localhost requests", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);

  const blockedRequests: string[] = [];
  await context.route("**/*", (route) => {
    let hostname: string;
    try {
      hostname = new URL(route.request().url()).hostname;
    } catch {
      hostname = "";
    }
    if (LOCAL_HOSTS.has(hostname)) {
      void route.continue();
      return;
    }
    blockedRequests.push(route.request().url());
    void route.abort("internetdisconnected");
  });

  // Offline mode auto-signs-in the seeded local director on mount (see
  // AuthProvider.tsx + supabase/seed.sql) and that director is already a
  // member of the "wmpc" org, so /admin lands straight on the tournaments
  // dashboard -- no login form to fill in.
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/wmpc(\/|$)/);

  // 1. Create a tournament. Slug auto-fills from the name.
  await page.goto("/admin/wmpc/tournaments/new");
  const stamp = Date.now();
  await page.getByLabel("Name", { exact: true }).fill(`Offline Harness ${stamp}`);
  const today = new Date().toISOString().slice(0, 10);
  await page.getByLabel("Start date").fill(today);
  await page.getByLabel("End date").fill(today);
  await page.getByRole("button", { name: "Create tournament" }).click();
  await expect(page).toHaveURL(/\/admin\/wmpc\/tournaments\/[^/]+$/);

  // 2. Create an event. Every format field is left at its default --
  // doubles / mixed / 1 pool / top-4, 1-round pairwise playoff -- which is
  // already a full round-robin-then-playoff shape.
  await page.getByRole("link", { name: "+ New event" }).click();
  await expect(page).toHaveURL(/\/events\/new$/);
  await page.getByLabel("Name", { exact: true }).fill("Harness Doubles");
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page).toHaveURL(/\/events\/[^/]+$/);
  const eventUrl = page.url();

  // 3. Seed 4 brand-new teams on the Teams tab (the console's default tab).
  for (let i = 1; i <= 4; i++) {
    await addNewTeam(page, `Harness${i}A LastA${i}`, `Harness${i}B LastB${i}`);
  }
  await expect(page.getByText(/^Teams \(4/)).toBeVisible();

  // 4. Round robin: generate the pairings, then score every match.
  await page.goto(`${eventUrl}?tab=games`);
  await page.getByRole("button", { name: "Generate matches" }).click();
  await saveAllVisibleMatches(page);

  // 5. Playoff (top 4, 1 round = two pairwise medal matches: 1v2 for gold,
  // 3v4 for bronze). Generate, then score both.
  await page.getByRole("button", { name: "Generate playoff bracket" }).click();
  await saveAllVisibleMatches(page);

  // 6. Standings tab reflects the finished event -- medals awarded, no
  // separate "finalize" click exists; autoTransitionEventStatus already
  // flipped the event to complete as the last match saved.
  await page.goto(`${eventUrl}?tab=standings`);
  await expect(page.getByText(/gold/i).first()).toBeVisible();

  expect(
    blockedRequests,
    `Requests attempted to a non-localhost host (network-down bar breached): ${blockedRequests.join(", ")}`,
  ).toEqual([]);
});

// Fills both Player A/B slots with brand-new players (typing "First Last"
// into the search box pre-fills both name fields on the "+ Add new player"
// button) and submits. Each PlayerPicker slot is scoped by an XPath match on
// its (non-semantic, div-based) SlotLabel text, since neither slot uses a
// real <label> element.
async function addNewTeam(page: Page, playerA: string, playerB: string) {
  await fillNewPlayerSlot(page, "Player A", playerA);
  await fillNewPlayerSlot(page, "Player B", playerB);
  await page.getByRole("button", { name: "Add team" }).click();
  // onAdd() resets both selections to "empty" only after the writes
  // succeed, so waiting for the search box to reappear is the signal the
  // team was actually persisted before the next iteration reuses it.
  await expect(
    page.locator('xpath=//div[div[normalize-space()="Player A"]]').first().getByPlaceholder("Search by name, email, or phone…"),
  ).toBeVisible();
}

async function fillNewPlayerSlot(page: Page, label: string, fullName: string) {
  const slot = page.locator(`xpath=//div[div[normalize-space()="${label}"]]`).first();
  await slot.getByPlaceholder("Search by name, email, or phone…").fill(fullName);
  await slot.getByRole("button", { name: /^\+ Add new player/ }).click();
}

// Fills in a plausible, non-tied score for every match row currently
// visible with a "Save" button enabled, in whatever section (round robin or
// playoff) is on screen -- generic on purpose so it doesn't hardcode a
// specific bracket shape.
async function saveAllVisibleMatches(page: Page) {
  const rows = page.locator("tr", { has: page.getByRole("button", { name: "Save" }) });
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const scoreInputs = row.locator('input[type="number"]');
    await scoreInputs.nth(0).fill("11");
    await scoreInputs.nth(1).fill("5");
    await row.getByRole("button", { name: "Save" }).click();
    // onSave() re-enables the button once busy resolves either way, so wait
    // on the printed score text (span.print-score) flipping from the "not
    // played yet" placeholder instead -- that only happens after the
    // Supabase update + feed-forward/status-transition calls resolve.
    await expect(row.locator(".print-score")).toHaveText(/\d+–\d+/);
  }
}
