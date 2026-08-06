/**
 * manage-registration.spec.ts (#657) — the admin "Manage registration" editor.
 *
 * Every edit path an organizer can take on a single registration, driven
 * through the real Attendees UI (By-Player → Manage → Edit) and verified against
 * the DB via the service-role client. Desktop only (the editor isn't in the
 * mobile testMatch). Fixtures come from e2e/seed.ts §9 — one event per scenario,
 * each reset every seed run so these mutating tests start from a known state.
 *
 * MONEY-SAFE invariant: none of these paths touch payments/refunds. They only
 * move players, pair/unpair, and flip registration status.
 */
import { test, expect, admin, loginAs, SEED } from "../fixtures";
import type { Page, Locator } from "@playwright/test";

const MR = SEED.manageReg;
// Lazy so importing this file (e.g. `playwright --list`) doesn't require the
// service-role env — admin() only resolves when a test actually reads the DB.
let _db: ReturnType<typeof admin> | null = null;
const db = () => (_db ??= admin());

// ── DB helpers (service-role reads/asserts) ───────────────────────────────
let tournamentIdCache: string | null = null;
async function tournamentId(): Promise<string> {
  if (tournamentIdCache) return tournamentIdCache;
  const { data, error } = await db().from("tournaments")
    .select("id")
    .eq("slug", MR.tournamentSlug)
    .is("deleted_at", null)
    .limit(1);
  if (error) throw new Error(error.message);
  tournamentIdCache = (data?.[0] as { id: string }).id;
  return tournamentIdCache;
}

async function playerIdByEmail(email: string): Promise<string> {
  const { data, error } = await db().from("players")
    .select("id")
    .eq("email", email)
    .is("deleted_at", null)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data?.[0] as { id: string }).id;
}

async function eventIdByName(name: string): Promise<string> {
  const { data, error } = await db().from("events")
    .select("id")
    .eq("tournament_id", await tournamentId())
    .eq("name", name)
    .is("deleted_at", null)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data?.[0] as { id: string }).id;
}

type Reg = {
  id: string;
  player_id: string;
  status: string;
  partner_status: string;
  partner_registration_id: string | null;
  event_fee_cents: number;
};

async function regById(id: string): Promise<Reg> {
  const { data, error } = await db().from("event_registrations")
    .select("id, player_id, status, partner_status, partner_registration_id, event_fee_cents")
    .eq("id", id)
    .limit(1);
  if (error) throw new Error(error.message);
  return data?.[0] as Reg;
}

async function regFor(email: string, eventName: string): Promise<Reg> {
  const [pid, eid] = await Promise.all([playerIdByEmail(email), eventIdByName(eventName)]);
  const { data, error } = await db().from("event_registrations")
    .select("id, player_id, status, partner_status, partner_registration_id, event_fee_cents")
    .eq("event_id", eid)
    .eq("player_id", pid)
    .is("deleted_at", null)
    .limit(1);
  if (error) throw new Error(error.message);
  return data?.[0] as Reg;
}

async function activeRegsInEvent(eventName: string): Promise<Reg[]> {
  const { data, error } = await db().from("event_registrations")
    .select("id, player_id, status, partner_status, partner_registration_id, event_fee_cents")
    .eq("event_id", await eventIdByName(eventName))
    .is("deleted_at", null);
  if (error) throw new Error(error.message);
  return (data ?? []) as Reg[];
}

// ── UI helpers ────────────────────────────────────────────────────────────

// Attendees defaults to By-Player. Filter to the one player, open their
// Manage → the single Edit → the (accessibly-named) editor dialog.
async function openEditor(page: Page, playerName: string): Promise<Locator> {
  await page.goto(`/admin/${SEED.orgSlug}/tournaments/${MR.tournamentSlug}/attendees`);
  await page.getByPlaceholder(/filter by name/i).fill(playerName);
  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: /manage registration/i });
  await expect(dialog).toBeVisible();
  return dialog;
}

function section(dialog: Locator, page: Page, heading: string): Locator {
  return dialog.locator("section", {
    has: page.getByRole("heading", { name: heading }),
  });
}

// Type into a PlayerPicker and click the matching result. Search by the first
// name only so the "+ Add new player: <query>" row can't collide with the
// full-name result we click.
async function pickPlayer(scope: Locator, fullName: string) {
  const query = fullName.split(/\s+/)[0];
  await scope.getByPlaceholder(/search by name/i).fill(query);
  await scope.getByRole("button", { name: new RegExp(fullName, "i") }).click();
}

test.describe("manage registration editor", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, MR.adminEmail);
  });

  test("reassign to a player not in the event moves the registration", async ({ page }) => {
    const before = await regFor("mr-ray@wmpc.test", MR.reassignOk.event);
    const noraId = await playerIdByEmail(MR.reassignOk.targetEmail);

    const dialog = await openEditor(page, MR.reassignOk.player);
    await pickPlayer(section(dialog, page, "Reassign player"), MR.reassignOk.targetName);
    await dialog.getByRole("button", { name: "Reassign" }).click();
    await expect(dialog).toBeHidden();

    const after = await regById(before.id);
    expect(after.player_id).toBe(noraId); // same reg, new owner
  });

  test("reassign to an already-registered player is blocked with a clear message", async ({ page }) => {
    const before = await regFor("mr-cal@wmpc.test", MR.reassignCollision.event);

    const dialog = await openEditor(page, MR.reassignCollision.player);
    await pickPlayer(section(dialog, page, "Reassign player"), MR.reassignCollision.targetName);
    await dialog.getByRole("button", { name: "Reassign" }).click();

    // Friendly guard, not a raw duplicate-key error; dialog stays open.
    await expect(dialog.getByRole("alert")).toContainText(/already registered for this event/i);
    await expect(dialog).toBeVisible();

    const after = await regById(before.id);
    expect(after.player_id).toBe(before.player_id); // unchanged
  });

  test("assign an already-registered player as partner pairs the existing reg", async ({ page }) => {
    const perry = await regFor("mr-perry@wmpc.test", MR.assignPartnerExisting.event);
    const eddie = await regFor("mr-eddie@wmpc.test", MR.assignPartnerExisting.event);
    const countBefore = (await activeRegsInEvent(MR.assignPartnerExisting.event)).length;

    const dialog = await openEditor(page, MR.assignPartnerExisting.player);
    await pickPlayer(section(dialog, page, "Partner"), MR.assignPartnerExisting.partnerName);
    await dialog.getByRole("button", { name: "Assign partner" }).click();
    await expect(dialog).toBeHidden();

    const perryAfter = await regById(perry.id);
    const eddieAfter = await regById(eddie.id);
    expect(perryAfter.partner_registration_id).toBe(eddie.id);
    expect(eddieAfter.partner_registration_id).toBe(perry.id);
    expect(perryAfter.partner_status).toBe("confirmed");
    expect(eddieAfter.partner_status).toBe("confirmed");
    // No comp reg created — the existing seeking reg was reused.
    expect((await activeRegsInEvent(MR.assignPartnerExisting.event)).length).toBe(countBefore);
  });

  test("assign a player with no reg as partner comp-creates a $0 reg and pairs", async ({ page }) => {
    const nate = await regFor("mr-nate@wmpc.test", MR.assignPartnerNew.event);
    const codyId = await playerIdByEmail(MR.assignPartnerNew.partnerEmail);
    expect((await activeRegsInEvent(MR.assignPartnerNew.event)).length).toBe(1);

    const dialog = await openEditor(page, MR.assignPartnerNew.player);
    await pickPlayer(section(dialog, page, "Partner"), MR.assignPartnerNew.partnerName);
    await dialog.getByRole("button", { name: "Assign partner" }).click();
    await expect(dialog).toBeHidden();

    const regs = await activeRegsInEvent(MR.assignPartnerNew.event);
    expect(regs.length).toBe(2);
    const codyReg = regs.find((r) => r.player_id === codyId);
    expect(codyReg).toBeTruthy();
    expect(codyReg!.status).toBe("paid"); // comp add
    expect(codyReg!.event_fee_cents).toBe(0); // no charge
    expect(codyReg!.partner_status).toBe("confirmed");
    const nateAfter = await regById(nate.id);
    expect(nateAfter.partner_registration_id).toBe(codyReg!.id);
    expect(codyReg!.partner_registration_id).toBe(nate.id);
  });

  test("remove partner sends both registrations back to seeking", async ({ page }) => {
    const tom = await regFor("mr-tom@wmpc.test", MR.removePartner.event);
    const tina = await regFor("mr-tina@wmpc.test", MR.removePartner.event);
    expect(tom.partner_registration_id).toBe(tina.id); // seeded as a confirmed team

    const dialog = await openEditor(page, MR.removePartner.player);
    await section(dialog, page, "Partner").getByRole("button", { name: "Remove partner" }).click();
    await expect(dialog).toBeHidden();

    const tomAfter = await regById(tom.id);
    const tinaAfter = await regById(tina.id);
    expect(tomAfter.partner_registration_id).toBeNull();
    expect(tinaAfter.partner_registration_id).toBeNull();
    expect(tomAfter.partner_status).toBe("seeking");
    expect(tinaAfter.partner_status).toBe("seeking");
  });

  test("withdraw a paid registration marks it withdrawn (no refund)", async ({ page }) => {
    const before = await regFor(MR.withdrawPaid.email, MR.withdrawPaid.event);
    expect(before.status).toBe("paid");

    const dialog = await openEditor(page, MR.withdrawPaid.player);
    await section(dialog, page, "Withdraw").getByRole("button", { name: "Withdraw from event" }).click();
    await page.getByRole("button", { name: "Withdraw", exact: true }).click(); // ConfirmModal
    await expect(dialog).toBeHidden();

    expect((await regById(before.id)).status).toBe("withdrawn");
  });

  test("withdraw a pending registration cancels it", async ({ page }) => {
    const before = await regFor(MR.withdrawPending.email, MR.withdrawPending.event);
    expect(before.status).toBe("pending_payment");

    const dialog = await openEditor(page, MR.withdrawPending.player);
    await section(dialog, page, "Withdraw").getByRole("button", { name: "Withdraw from event" }).click();
    await page.getByRole("button", { name: "Withdraw", exact: true }).click(); // ConfirmModal
    await expect(dialog).toBeHidden();

    expect((await regById(before.id)).status).toBe("cancelled");
  });
});
