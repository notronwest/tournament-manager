// web/e2e/offline/first-paint.spec.ts
//
// The FAST, NON-DESTRUCTIVE half of the offline verification harness (issue
// #735, epic #732). It answers one question: with the network interface down,
// does the app paint at all?
//
// "Network interface down" is simulated deterministically the same way the
// full network-audit.spec.ts does it -- Playwright can't toggle the real
// interface, so every request whose host isn't localhost/127.0.0.1 is aborted
// exactly as a disconnected interface would fail it, and recorded. First paint
// succeeding here proves the fonts, JS, CSS, and Supabase calls the initial
// render needs are all local -- which is precisely what broke live on
// 2026-09-11 (a checkout missing the self-hosted @fontsource/* deps died at
// Vite import time and never painted).
//
// Unlike network-audit.spec.ts this writes NOTHING to the database -- it only
// loads /admin and lets offline mode's auto-sign-in land on the dashboard --
// so it is safe to run against a shared local stack (e.g. the venue laptop's)
// without polluting real tournament data. scripts/offline-verify.sh runs this
// by default; the full mock-event audit is opt-in (--full).
import { test, expect } from "@playwright/test";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

test("the app reaches first paint with the network down (localhost only)", async ({
  page,
  context,
}) => {
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

  // /admin exercises the offline auth path -- offline mode auto-signs-in the
  // seeded local director on mount (see AuthProvider.tsx + supabase/seed.sql),
  // which is a real query against the LOCAL Supabase. Read-only, no writes.
  await page.goto("/admin");

  // First paint actually happened: the branded app shell rendered (proves the
  // self-hosted fonts + JS + CSS all loaded locally -- the exact thing a
  // deps-missing checkout fails at), and the OFFLINE banner confirms we're in
  // offline mode. We deliberately don't assert the /admin -> /admin/<org>
  // redirect: that depends on org-membership rows in the DB, which is mutable
  // shared state, not a first-paint or network property.
  await expect(
    page.getByRole("banner").getByRole("link", { name: /bert & erne/i }),
  ).toBeVisible();
  await expect(page.getByText(/OFFLINE environment/i)).toBeVisible();

  // The whole point: nothing tried to leave localhost while painting -- not a
  // font, not an analytics beacon, not the auth call that just signed us in.
  expect(
    blockedRequests,
    `Requests attempted to a non-localhost host during first paint (network-down bar breached): ${blockedRequests.join(", ")}`,
  ).toEqual([]);
});
