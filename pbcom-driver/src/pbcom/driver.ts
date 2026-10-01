/**
 * The two FORM-SPECIFIC PB.com operations, implemented against the live director-session
 * flows captured on train.pickleballbrackets.dev (D-0045 "trace first").
 *
 * PB.com is ASP.NET WebForms. Two properties dominate the automation:
 *   • Every mutating "Save" pops an "Are you sure?" modal that must be confirmed with
 *     "Continue" — see `saveAndConfirm`. Some saves then show a "Success!" modal whose
 *     "Go to Next Verification Page" advances the wizard.
 *   • The verify wizard (aV.aspx) is STRICTLY SEQUENTIAL: step tabs are not clickable and
 *     `?s=N` jumps reset to s=1. You advance ONLY by Save→Continue, in order.
 *
 * Both operations are VERIFY-AFTER-WRITE: they drive PB.com, then read it back and set
 * `verified` only when the landed state matches what was pushed. The executor records the
 * ledger only on `verified === true`, which is what makes re-runs safe.
 *
 * ⚠️ NEVER click the row's "Official" button — on PB.com that PRINTS a paper score sheet
 * and opens a blocking print dialog. Scores are entered via the score-cell "Match N" modal.
 *
 * Selectors are by role/text (resilient to WebForms' generated ids). Where the live capture
 * did not pin an exact id, the code locates by the on-screen label from the trace and the
 * choice is commented.
 */
import type { Locator, Page } from "playwright";
import type { ResolvedDivisionTarget } from "../binding.js";
import type { BandeMatch, BandeTeam } from "../types.js";
import { log } from "../log.js";
import {
  computeSeedMoves,
  findMatchRow,
  lastNameSet,
  lastNameSetKey,
  type PbMatchRow,
} from "./matchMap.js";
import type { PbcomSession } from "./session.js";

const NAV = { waitUntil: "load" as const, timeout: 45_000 };
const STEP_TIMEOUT = 30_000;

// ── shared WebForms helpers ───────────────────────────────────────────────────────

/** Click a "Save" (or other mutating) control, then confirm the "Are you sure?" modal. */
async function saveAndConfirm(
  page: Page,
  save: Locator,
  opts: { expectSuccess?: boolean } = {},
): Promise<void> {
  await save.scrollIntoViewIfNeeded();
  await save.click();
  // "Are you sure?" → Continue. WebForms renders it as a Bootstrap-style modal button.
  const cont = page.getByRole("button", { name: /^\s*continue\s*$/i }).last();
  await cont.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  await cont.click();
  if (opts.expectSuccess) {
    // A "Success!" modal → "Go to Next Verification Page" advances the wizard.
    const goNext = page.getByRole("button", { name: /go to next verification page/i }).last();
    await goNext.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    await goNext.click();
  }
  await page.waitForLoadState("load", { timeout: STEP_TIMEOUT });
}

/** True if a "Required Fields" validation modal is showing (a bad/incomplete save). */
async function hasRequiredFieldsError(page: Page): Promise<boolean> {
  return (await page.getByText(/required fields/i).count()) > 0;
}

// ── createBracketOnPbcom ───────────────────────────────────────────────────────

/** The seeded draw B&E owns and wants reflected as a PB.com bracket. */
export interface BracketPushInput {
  /** PB.com division label (its identity; events.source_division_label). */
  divisionLabel: string;
  /** How B&E generated the draw — tells the driver which PB.com bracket shape to build. */
  bracketType:
    | "round_robin"
    | "single_elim"
    | "double_elim"
    | "pool_then_bracket"
    | null;
  /** The teams (singles=1 entry, doubles=2), each carrying last names + seed. */
  teams: BandeTeam[];
  /** The generated match structure (slots/rounds), pre-scores, from the `matches` table. */
  matches: BandeMatch[];
}

export interface BracketPushResult {
  /** True only when PB.com was read back and shows the bracket as pushed. */
  verified: boolean;
  /** PB.com's own bracket/division id (the `eaid`), if captured (for future binds). */
  pbcomDivisionId: string | null;
  /** A human-readable note for the log / "out of sync" surface on failure. */
  detail: string;
}

/**
 * Open the Live Console, find the division row by its title text, click its
 * "Verify Event" button, and return the wizard `eaid` (the per-division handle
 * assigned when Verify Event is clicked).
 */
async function openVerifyWizard(page: Page, target: ResolvedDivisionTarget): Promise<string> {
  await page.goto(`${eventsConsoleUrl(page, target.pbcomEid)}`, NAV);
  // The "Verify N" tab lists divisions each with a "Verify Event" button.
  const verifyTab = page.getByRole("tab", { name: /verify/i }).first();
  if (await verifyTab.count()) {
    await verifyTab.click().catch(() => {});
  }
  // Match the division row by its title text (e.g. "Mens Doubles Skill: (3.5 To 3.99)").
  const row = page
    .locator("tr", { hasText: new RegExp(escapeRe(target.divisionLabel), "i") })
    .first();
  await row.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  await row.getByRole("button", { name: /verify event/i }).first().click();
  await page.waitForURL(/aV\.aspx/i, { timeout: STEP_TIMEOUT });
  const eaid = new URL(page.url()).searchParams.get("eaid");
  if (!eaid) throw new Error("verify wizard opened but no eaid in the URL");
  return eaid;
}

function eventsConsoleUrl(page: Page, eid: string): string {
  return new URL(`/a5_u/pbt/eDB.aspx?eid=${encodeURIComponent(eid)}`, page.url() || "https://pickleballbrackets.com").toString();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The green "Save" button visible on the current wizard step. */
function saveButton(page: Page): Locator {
  return page.getByRole("button", { name: /^\s*save\s*$/i }).last();
}

/**
 * Create + seed the division's bracket on PB.com by driving the 6-step verify wizard,
 * then starting matches. Returns verified only after the event is read back as started.
 */
export async function createBracketOnPbcom(
  session: PbcomSession,
  target: ResolvedDivisionTarget,
  input: BracketPushInput,
): Promise<BracketPushResult> {
  const page = session.page;
  log.info("createBracket: opening verify wizard", { division: input.divisionLabel });
  const eaid = await openVerifyWizard(page, target);

  // ── s1 Verify Teams — PB already shows the registered teams. Save → Continue.
  await saveAndConfirm(page, saveButton(page));

  // ── s2 Pool Options — Round-Robin is default for ≤5-team RR. Leave it (or select).
  if (input.bracketType && input.bracketType !== "round_robin") {
    // Non-RR formats select a different bracket radio; RR is the default and needs no click.
    const fmt = page.getByRole("radio", { name: bracketRadioLabel(input.bracketType) }).first();
    if (await fmt.count()) await fmt.check().catch(() => {});
  }
  await saveAndConfirm(page, saveButton(page));

  // ── s3 Verify Settings — avoid the "Pool 1 medal round count cannot be zero" error by
  // selecting "NO bracket medal rounds, medal based on end ranked results" (radio value 0).
  const noMedal = page
    .getByRole("radio", { name: /no bracket medal rounds/i })
    .first();
  if (await noMedal.count()) {
    await noMedal.check();
  } else {
    // Fallback: the radio input whose value is "0" under the medal-round group.
    await page.locator('input[type="radio"][value="0"]').first().check().catch(() => {});
  }
  await saveButton(page).click();
  const cont3 = page.getByRole("button", { name: /^\s*continue\s*$/i }).last();
  await cont3.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  await cont3.click();
  await page.waitForLoadState("load", { timeout: STEP_TIMEOUT });
  if (await hasRequiredFieldsError(page)) {
    return {
      verified: false,
      pbcomDivisionId: eaid,
      detail: "s3 Verify Settings still shows a Required Fields error (medal round config)",
    };
  }

  // ── s4 Verify Seeding — apply B&E's seeded order via Sort Item + Move Up/Down.
  await applySeeding(page, input.teams);
  await saveAndConfirm(page, saveButton(page), { expectSuccess: true });

  // ── s5 Verify First-Round Matchups — review, Save → Continue → Success → Next.
  await saveAndConfirm(page, saveButton(page), { expectSuccess: true });

  // ── s6 Go Live Overview — COMPLETE VERIFICATION → "Are you sure? This WILL lock…".
  const complete = page.getByRole("button", { name: /complete verification/i }).last();
  await complete.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  await saveAndConfirm(page, complete);

  // ── Start Matches — Live Console → Waiting tab → row → Options → Start Matches.
  await startMatches(page, target);

  // ── VERIFY — the event should now be in the "Running" queue with scoreable matches.
  const running = await isEventRunning(page, target);
  return {
    verified: running,
    pbcomDivisionId: eaid,
    detail: running
      ? `bracket verified + matches started (eaid=${eaid})`
      : "completed verification but the event was not read back as Running",
  };
}

function bracketRadioLabel(bt: NonNullable<BracketPushInput["bracketType"]>): RegExp {
  switch (bt) {
    case "single_elim":
      return /single elimination/i;
    case "double_elim":
      return /double elimination/i;
    case "pool_then_bracket":
      return /pool.*(bracket|elimination)/i;
    default:
      return /round.?robin/i;
  }
}

/** Read the seeding list into last-name-set keys in current on-screen order. */
async function readSeedOrder(page: Page): Promise<{ key: string; ref: Locator }[]> {
  const rows = page.locator('[data-seed-row], tr:has(button:has-text("Sort Item")), li:has(button:has-text("Sort Item"))');
  const n = await rows.count();
  const out: { key: string; ref: Locator }[] = [];
  for (let i = 0; i < n; i++) {
    const ref = rows.nth(i);
    const text = (await ref.innerText()).trim();
    out.push({ key: lastNameSetKey(splitLastNames(text)), ref });
  }
  return out;
}

/**
 * Apply B&E's seed order on the Verify Seeding page. Computes the minimal Move Up/Down
 * sequence (pure — computeSeedMoves) and drives each: click the team's "Sort Item",
 * then "Move Item Up"/"Move Item Down" to walk it one slot.
 */
async function applySeeding(page: Page, teams: BandeTeam[]): Promise<void> {
  const desired = [...teams]
    .filter((t) => t.seed != null)
    .sort((a, b) => (a.seed! - b.seed!) || a.teamKey.localeCompare(b.teamKey))
    .map((t) => lastNameSetKey(t.lastNames));
  if (desired.length === 0) {
    log.info("createBracket: no seeds to apply — leaving PB.com's default order");
    return;
  }
  const current = (await readSeedOrder(page)).map((r) => r.key);
  // Only reorder teams we can see; if the on-screen set differs, don't guess.
  const currentSet = [...current].sort().join("|");
  const desiredSet = [...desired].sort().join("|");
  if (currentSet !== desiredSet) {
    log.warn("createBracket: seed roster mismatch — skipping reorder", {
      onScreen: current.length,
      desired: desired.length,
    });
    return;
  }
  const moves = computeSeedMoves(current, desired);
  log.info("createBracket: applying seed moves", { moves: moves.length });
  for (const move of moves) {
    // Re-read each iteration: the DOM re-renders after every move.
    const order = await readSeedOrder(page);
    const target = order.find((r) => r.key === move.teamKey);
    if (!target) throw new Error(`seed move target row not found: ${move.teamKey}`);
    await target.ref.getByRole("button", { name: /sort item/i }).first().click();
    const dir = move.direction === "up" ? /move item up/i : /move item down/i;
    await page.getByRole("button", { name: dir }).first().click();
    await page.waitForLoadState("load", { timeout: STEP_TIMEOUT }).catch(() => {});
  }
}

/** Live Console → Waiting tab → the event row → Options → Start Matches. */
async function startMatches(page: Page, target: ResolvedDivisionTarget): Promise<void> {
  await page.goto(eventsConsoleUrl(page, target.pbcomEid), NAV);
  const waitingTab = page.getByRole("tab", { name: /waiting/i }).first();
  if (await waitingTab.count()) await waitingTab.click().catch(() => {});
  const row = page
    .locator("tr", { hasText: new RegExp(escapeRe(target.divisionLabel), "i") })
    .first();
  await row.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  await row.getByRole("button", { name: /options/i }).first().click();
  await page.getByRole("menuitem", { name: /start matches/i })
    .or(page.getByRole("button", { name: /start matches/i }))
    .first()
    .click();
  await page.waitForLoadState("load", { timeout: STEP_TIMEOUT });
}

/** Verify the event moved to the Running queue. */
async function isEventRunning(page: Page, target: ResolvedDivisionTarget): Promise<boolean> {
  await page.goto(eventsConsoleUrl(page, target.pbcomEid), NAV);
  const runningTab = page.getByRole("tab", { name: /running/i }).first();
  if (await runningTab.count()) await runningTab.click().catch(() => {});
  const row = page.locator("tr", { hasText: new RegExp(escapeRe(target.divisionLabel), "i") });
  return (await row.count()) > 0;
}

// ── submitScoreCard ────────────────────────────────────────────────────────────

/** One completed match's score, resolved to the two teams' player last names. */
export interface ScoreCardInput {
  /** B&E matches.id — for logging / traceability. */
  matchId: string;
  /** The reconcile identity (from push/plan.matchIdentity). */
  identity: string;
  /** B&E team A / B last-name sets — how the row is located on PB.com (flow C). */
  teamALastNames: string[];
  teamBLastNames: string[];
  /** B&E team A / B first-name sets — the tiebreak when surnames collide (optional). */
  teamAFirstNames?: string[];
  teamBFirstNames?: string[];
  /** The aggregate score B&E recorded (single pair; B&E has no per-game table). */
  teamAScore: number;
  teamBScore: number;
  /** Which side won, derived from winner_reg_id. */
  winnerSide: "a" | "b";
}

export interface ScoreCardResult {
  /** True only when PB.com was read back and shows this score. */
  verified: boolean;
  /** A human-readable note for the log / "out of sync" surface on failure. */
  detail: string;
}

/** Split one team cell's text into per-player name chunks ("Smith / Jones"). */
function nameChunks(text: string): string[] {
  return text.split(/[/&]|\bvs\b|\n/i).map((s) => s.trim()).filter(Boolean);
}

/** Split a row's visible text into candidate last-name tokens. */
export function splitLastNames(text: string): string[] {
  // Rows read like "Smith / Jones" or "Smith, John & Jones, Amy". Take the token
  // before the first comma of each name chunk; fall back to whitespace splitting.
  const names: string[] = [];
  for (const c of nameChunks(text)) {
    const beforeComma = c.split(",")[0]!.trim();
    // If "Last, First" → beforeComma is the last name. If "First Last" → last token.
    const last = c.includes(",") ? beforeComma : beforeComma.split(/\s+/).pop() ?? beforeComma;
    if (last) names.push(last);
  }
  return names;
}

/** Split a row's visible text into candidate FIRST-name tokens (tiebreak only). */
export function splitFirstNames(text: string): string[] {
  const names: string[] = [];
  for (const c of nameChunks(text)) {
    if (c.includes(",")) {
      // "Last, First" → everything after the first comma is the first name(s).
      const after = c.slice(c.indexOf(",") + 1).trim().split(/\s+/)[0] ?? "";
      if (after) names.push(after);
    } else {
      // "First Last" → the first whitespace token.
      const first = c.split(/\s+/)[0] ?? "";
      if (first) names.push(first);
    }
  }
  return names;
}

/**
 * Parse the round-robin bracket page (ptsrr.aspx) into PbMatchRow[]. Each match row shows
 * both teams and a score cell; the score cell is the click target for the "Match N" modal.
 */
async function parseMatchRows(page: Page): Promise<PbMatchRow[]> {
  const rows = page.locator('tr:has([data-scorecell]), tr:has(td.score), table.bracket tr, tr:has(button:has-text("Simple"))');
  const n = await rows.count();
  const out: PbMatchRow[] = [];
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    // Two team labels per row. PB.com renders each team's players in its own cell.
    const teamCells = row.locator('[data-team], td.team, .match-team');
    let one: string[] = [];
    let two: string[] = [];
    let oneFirst: string[] = [];
    let twoFirst: string[] = [];
    if ((await teamCells.count()) >= 2) {
      const t1 = (await teamCells.nth(0).innerText()).trim();
      const t2 = (await teamCells.nth(1).innerText()).trim();
      one = splitLastNames(t1);
      two = splitLastNames(t2);
      oneFirst = splitFirstNames(t1);
      twoFirst = splitFirstNames(t2);
    } else {
      // Fallback: split the whole row text on the vs/newline separator.
      const parts = (await row.innerText()).split(/\bvs\b|\n/i).map((s) => s.trim()).filter(Boolean);
      one = splitLastNames(parts[0] ?? "");
      two = splitLastNames(parts[1] ?? "");
      oneFirst = splitFirstNames(parts[0] ?? "");
      twoFirst = splitFirstNames(parts[1] ?? "");
    }
    if (one.length === 0 && two.length === 0) continue;
    const cellText = (await row.innerText());
    const hasScore = /\b\d+\s*[-–]\s*\d+\b/.test(cellText) && !/\b0\s*[-–]\s*0\b/.test(cellText);
    out.push({
      ref: `row:${i}`,
      teamOneLastNames: one,
      teamTwoLastNames: two,
      teamOneFirstNames: oneFirst,
      teamTwoFirstNames: twoFirst,
      hasScore,
    });
  }
  return out;
}

/** Navigate to the division's round-robin bracket page (ptsrr.aspx). */
async function openDivisionBracket(page: Page, target: ResolvedDivisionTarget): Promise<void> {
  if (target.pbcomDivisionId) {
    // When the bind pins the pool id, go straight there.
    await page.goto(
      new URL(`/a5_u/pbt/ptsrr.aspx?plid=${encodeURIComponent(target.pbcomDivisionId)}`, page.url() || "https://pickleballbrackets.com").toString(),
      NAV,
    );
    return;
  }
  // Otherwise reach it from the Live Console: open the Running division's bracket.
  await page.goto(eventsConsoleUrl(page, target.pbcomEid), NAV);
  const runningTab = page.getByRole("tab", { name: /running/i }).first();
  if (await runningTab.count()) await runningTab.click().catch(() => {});
  const row = page.locator("tr", { hasText: new RegExp(escapeRe(target.divisionLabel), "i") }).first();
  await row.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  await row.getByRole("link", { name: /bracket|scores|matches/i })
    .or(row.getByRole("button", { name: /bracket|scores|matches/i }))
    .first()
    .click();
  await page.waitForLoadState("load", { timeout: STEP_TIMEOUT });
}

/**
 * Enter (or correct) one match's score on PB.com. Locates the row by the two teams'
 * last-name sets (flow C), opens the "Match N" score modal via the SCORE CELL (never
 * the "Official" print button), enters each team's G1 score, saves, and verifies.
 */
export async function submitScoreCard(
  session: PbcomSession,
  target: ResolvedDivisionTarget,
  input: ScoreCardInput,
): Promise<ScoreCardResult> {
  const page = session.page;
  await openDivisionBracket(page, target);

  const rows = await parseMatchRows(page);
  const found = findMatchRow(input.teamALastNames, input.teamBLastNames, rows, { teamAFirstNames: input.teamAFirstNames, teamBFirstNames: input.teamBFirstNames });
  if (!found.ok) {
    return {
      verified: false,
      detail: `match ${input.matchId}: row ${found.reason} on PB.com (candidates=${found.candidates})`,
    };
  }
  const { row, aIsTeamOne } = found.match;
  const rowIndex = Number(row.ref.split(":")[1]);
  const rowLoc = page.locator('tr:has([data-scorecell]), tr:has(td.score), table.bracket tr, tr:has(button:has-text("Simple"))').nth(rowIndex);

  // Idempotency: an already-scored row (non-zero score) needs no re-entry unless the
  // score differs. The caller only asks us for scores whose digest changed, so a row
  // that already shows THIS score is a confirmed skip.
  // Open the score modal by clicking the SCORE CELL (the two "0" boxes) — NOT "Official".
  const scoreCell = rowLoc.locator('[data-scorecell], td.score, .match-score').first();
  await scoreCell.scrollIntoViewIfNeeded();
  await scoreCell.click();

  const modal = page.getByRole("dialog").filter({ hasText: /match\s*\d+/i }).last()
    .or(page.locator('.modal:visible').last());
  await modal.waitFor({ state: "visible", timeout: STEP_TIMEOUT });

  // Per-team G1 numeric input. Team-one input is first, team-two second.
  const g1Inputs = modal.locator('input[name*="G1" i], input[id*="G1" i], input.g1, input[type="number"]');
  if ((await g1Inputs.count()) < 2) {
    return { verified: false, detail: `match ${input.matchId}: score modal missing G1 inputs` };
  }
  const oneScore = aIsTeamOne ? input.teamAScore : input.teamBScore;
  const twoScore = aIsTeamOne ? input.teamBScore : input.teamAScore;
  await setNumber(g1Inputs.nth(0), oneScore);
  await setNumber(g1Inputs.nth(1), twoScore);

  // Win/Loss dropdowns, if present — set the winner's side to Win, the other to Loss.
  const winnerIsTeamOne = input.winnerSide === "a" ? aIsTeamOne : !aIsTeamOne;
  const wlSelects = modal.locator('select[name*="win" i], select[name*="result" i], select');
  if ((await wlSelects.count()) >= 2) {
    await selectWinLoss(wlSelects.nth(0), winnerIsTeamOne);
    await selectWinLoss(wlSelects.nth(1), !winnerIsTeamOne);
  }

  await modal.getByRole("button", { name: /save scores/i }).click();
  await page.waitForLoadState("load", { timeout: STEP_TIMEOUT });

  // VERIFY: a saved score card adds scid to the URL and the row shows the final score.
  const scid = new URL(page.url()).searchParams.get("scid");
  await openDivisionBracket(page, target);
  const after = await parseMatchRows(page);
  const reFound = findMatchRow(input.teamALastNames, input.teamBLastNames, after, { teamAFirstNames: input.teamAFirstNames, teamBFirstNames: input.teamBFirstNames });
  const landed = reFound.ok && reFound.match.row.hasScore === true;
  return {
    verified: Boolean(scid) || landed,
    detail: landed
      ? `score ${input.teamAScore}-${input.teamBScore} verified on PB.com${scid ? ` (scid=${scid})` : ""}`
      : `score submit did not read back for match ${input.matchId}`,
  };
}

async function setNumber(input: Locator, value: number): Promise<void> {
  // Triple-click to select the existing "0", then type the new value (per the trace).
  await input.click({ clickCount: 3 });
  await input.fill(String(value));
}

async function selectWinLoss(select: Locator, win: boolean): Promise<void> {
  const label = win ? /win|^w$/i : /loss|lose|^l$/i;
  try {
    await select.selectOption({ label: win ? "Win" : "Loss" });
  } catch {
    // Fall back to matching an option by regex text.
    const opts = select.locator("option");
    const n = await opts.count();
    for (let i = 0; i < n; i++) {
      const t = (await opts.nth(i).innerText()).trim();
      if (label.test(t)) {
        await select.selectOption({ index: i });
        return;
      }
    }
  }
}

// Re-export the pure helpers the CLI/tests use alongside the driver.
export { lastNameSet };
