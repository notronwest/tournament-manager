/**
 * issue-801-last-sent.spec.ts (#801) — the pending-partner-invites panel's
 * date column showed the invite's creation date even after a Resend, so an
 * organizer couldn't tell a nudge had gone out. The column is now "Last
 * sent", stamped server-side by send-partner-invite (see #802's
 * `last_sent_at` column and PendingPartnerInvitesPanel.tsx).
 *
 * Fixtures (e2e/seed.ts §11 via SEED.lastSent): one tournament, two
 * never-resent invites, both seeded with a fixed OLD created_at and no
 * last_sent_at (nullable, no default — matches invites that predate the
 * #802 migration). A fixed old date guarantees "Last sent" starts on a
 * calendar day that differs from whenever the suite actually runs, which is
 * required to exercise the "invited <original date>" muted sub-line (AC #4):
 * PendingPartnerInvitesPanel only renders it when the two *formatted* dates
 * diverge, not on raw timestamp difference.
 *   single — resent alone, then the page is reloaded to prove the stamp is
 *            server-side, not just optimistic client state (AC #1, #2, #4, #5).
 *   bulk   — resent via "Resend selected" alongside `single`, to prove a
 *            multi-row resend updates every selected row (AC #3).
 */
import { test, expect, loginAs, SEED } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

const F = SEED.lastSent;
const TODAY = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

async function gotoAttendees(page: Page) {
  await page.goto(`/admin/${SEED.orgSlug}/tournaments/${F.tournamentSlug}/attendees`);
  await expect(page.getByRole("heading", { name: "Attendees", level: 1 })).toBeVisible();
}

function inviteRow(page: Page, inviteeName: string): Locator {
  return page.getByRole("row", { name: new RegExp(inviteeName, "i") });
}

test.describe("pending partner invites — Last sent (#801)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, F.adminEmail);
  });

  test("Resend stamps Last sent, survives reload, and shows the original invite date (AC 1, 2, 4, 5)", async ({ page }) => {
    await gotoAttendees(page);
    const row = inviteRow(page, F.single.inviteeName);

    // AC 1, 5 — never resent: Last sent falls back to the (old) invite date,
    // not blank, and no separate "invited …" line yet (same date, so it
    // wouldn't add information).
    await expect(row).toContainText(F.single.formattedDate);
    await expect(row).not.toContainText(/invited/i);

    // AC 2 — Resend updates the row without a reload.
    await row.getByRole("button", { name: /^resend$/i }).click();
    await expect(row).toContainText(TODAY, { timeout: 15_000 });
    // AC 4 — once Last sent and the original invite date diverge, the
    // original date stays visible in the muted sub-line.
    await expect(row).toContainText(new RegExp(`invited ${F.single.formattedDate}`, "i"));

    // AC 2 — a reload shows the same (server-stamped) value.
    await page.reload();
    await expect(inviteRow(page, F.single.inviteeName)).toContainText(TODAY);
    await expect(inviteRow(page, F.single.inviteeName)).toContainText(new RegExp(`invited ${F.single.formattedDate}`, "i"));
  });

  test("Resend selected updates every selected row (AC 3)", async ({ page }) => {
    await gotoAttendees(page);
    const singleRow = inviteRow(page, F.single.inviteeName);
    const bulkRow = inviteRow(page, F.bulk.inviteeName);

    // Baseline: bulk's invite has never been resent yet.
    await expect(bulkRow).toContainText(F.bulk.formattedDate);

    await singleRow.locator('input[type="checkbox"]').check();
    await bulkRow.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: /resend selected/i }).click();

    await expect(bulkRow).toContainText(TODAY, { timeout: 15_000 });
    await expect(bulkRow).toContainText(new RegExp(`invited ${F.bulk.formattedDate}`, "i"));
    await expect(singleRow).toContainText(TODAY);
  });
});
