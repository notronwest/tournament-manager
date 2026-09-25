# Status — tournament-manager

Append-only session handoff log. **Read this first; append a dated entry
before you wrap.** Newest on top; new entries supersede old — don't rewrite.
Entries before 2026-08-15 were moved to [`STATUS-ARCHIVE.md`](./STATUS-ARCHIVE.md)
on 2026-08-27 to keep this lean; nothing was lost.

## 2026-09-25 — Testing agent (daytime run): Job 1 triage, harness parse break persists (5th occurrence), #955 still unmerged

Triaged the newest untriaged regression run, [36148433196](https://github.com/notronwest/tournament-manager/actions/runs/36148433196) (2026-09-25 14:34 UTC, daytime) — **failed at the seed step**, identical signature to the prior three runs: `web/e2e/seed.ts:543: ERROR: Unexpected "const"`. Root cause and fix unchanged: the fix (commit `0cf993d`) has been sitting in open PR [#955](https://github.com/notronwest/tournament-manager/pull/955) since 2026-09-24 morning and still isn't merged, so `main` HEAD (`8cd2299`) still can't parse as a Playwright suite. This is now **4 consecutive scheduled CI runs with zero regression signal**. Not a product regression — commented an update on the tracking issue ([#954](https://github.com/notronwest/tournament-manager/issues/954)) rather than filing a duplicate card or re-posting to Discord (already flagged there with urgency this morning, per the "don't re-post the same regression same day" rule).

Job 2 skipped (daytime slot; per-day authoring cap belongs to the morning run).

Housekeeping: this session's checkout had a stale local, uncommitted `CLAUDE.md` diff (missing the "Engineering standard" section already committed on `main`, flagged in prior STATUS entries since 2026-09-20 as out-of-scope drift). While switching branches I ran `git checkout main -- .`, which brought the local file back in sync with `main`'s committed content — flagging transparently since it touched uncommitted state, though nothing committed or pushed was affected and the result matches the canonical `main` version.

**Next:** Ron still needs to merge #955 — every run past this one stays blind to real regressions until it lands.

## 2026-09-22 — Testing agent (daytime run): Job 1 triage, known #936 failure (persistent this time), no new card

Triaged the newest untriaged regression run, [35737353782](https://github.com/notronwest/tournament-manager/actions/runs/35737353782) (2026-09-22 14:00 UTC) — workflow **failed** (56 passed, 1 failed, 1 flaky). `issue-09-confirm-cancel.spec.ts` › "Path 1 — backing out of the register form after picking a partner" failed **both** attempt and retry #1 this time (`TimeoutError: locator.fill` on the partner-search placeholder) — same #936 signature, but landed persistent instead of flaky-then-pass, so this is the first of the last three occurrences to flip the run red. `registration.spec.ts` › "register for a singles event (no partner picker)" flaked once (`TimeoutError: locator.scrollIntoViewIfNeeded`) then passed on retry. PR #951 (self-seeding isolation fix for #950) is still open/unmerged — expected signature until it lands. Commented an update on #936 (with the severity bump noted) rather than filing a duplicate card; posted a one-line Discord triage summary to Backlog.

Job 2 skipped (daytime slot; per-day authoring cap belongs to the morning run). **Next:** #951 merging is the actual fix — worth prioritizing given today's run crossed from flaky-green to red.

## 2026-09-21 — Testing agent (daytime run): Job 1 triage, green with known #936 flake, no new card

Triaged the newest untriaged regression run, [35655046570](https://github.com/notronwest/tournament-manager/actions/runs/35655046570) (2026-09-21 21:05 UTC) — **overall green** (56 passed, 2 flaky). Both flakes are the same tracked #936 family: `registration.spec.ts` › "register needing a partner" and `issue-09-confirm-cancel.spec.ts` › "Path 1 — backing out of the register form after picking a partner" each failed attempt 1 (`TimeoutError: locator.fill` on the partner-search placeholder) but passed retry #1. Notably better than the prior run (35621868067), where Path 1 failed both attempt and retry. PR #951 (self-seeding isolation fix for #950) is still open/unmerged, so this is the expected signature until it lands — commented an update on #936 rather than filing a duplicate card. Posted a one-line Discord triage summary to Backlog.

Job 2 skipped (daytime slot; authoring cap belongs to the morning run). **Next:** once #951 merges, the following run is the real signal on whether #936's flake clears for good.

## 2026-09-21 — Testing agent (daytime run): Job 1 triage, known #936 flake, no new card

Triaged the newest untriaged regression run, [35621868067](https://github.com/notronwest/tournament-manager/actions/runs/35621868067) (2026-09-21 15:52 UTC). Only persistent failure (failed both attempt and retry #1): `issue-09-confirm-cancel.spec.ts` › "Path 1 — backing out of the register form after picking a partner" — `TimeoutError: locator.fill` on the partner-search placeholder, same signature already tracked in #936. Two more flaked-then-passed on retry #1 (`registration.spec.ts` › "register needing a partner", and `mobile/audit.spec.ts` (iphone) › "register tab — pending card actions usable") — same shared-mutable-seed-state family, not previously named in #936 but same root cause.

This run predates PR #951 (Builder's self-seeding fix for #950) merging, so it's the expected signature until that lands — not new information. Commented an update on #936 rather than filing a duplicate card. Posted a one-line Discord triage summary to Backlog.

Job 2 skipped — this is the ~15:00-local (daytime) slot per `agents/testing/PROMPT.md`, and Job 2's per-day cap belongs to the morning run. Note: no "Testing agent morning run" STATUS entry exists for 2026-09-21, so it's unclear whether this morning's run fired — flagging in case the 07:00 slot needs a look, but not investigating scheduler health here (out of this agent's scope). **Next:** once #951 merges, the following run is the real signal on whether #936's flake clears.

## 2026-09-21 — Builder: single-item orphan recovery, #936 reconciled to Backlog

Single-item mode: recover orphaned **In Progress** card #936 (dispatcher assumed a `feature/db/fn/issue-936-*` branch existed with no open PR). Checked local + all remote branches — no branch for #936 exists anywhere; nothing to build or open a PR for.

Found the real state via #936's own comment thread: CoS triage (2026-09-21) already diagnosed and resolved this — the actionable fix was dispatched as **#950** (self-seeding isolation fix), which has an open, mergeable PR **#951** (In Review, see the entry below). That same CoS comment said "This card moves to Backlog as the tracking issue," but the board move was never applied, leaving #936 stranded in In Progress with no work attached to it.

Action: moved #936's board status **In Progress → Backlog** via `gh project item-edit`, and left an explanatory comment (`<!-- wmpc-builder -->`) pointing to #950/#951 and the disposition. No branch, no code, no PR — this card had nothing to build. **Next:** #936 stays open until a week of clean regression runs on the affected specs, per #950's note; nothing further for the Builder here.

## 2026-09-21 — Builder: single-item run, PR #951 for #950 (self-seeding e2e fix)

Built issue #950 in single-item mode (no sub-issues/PRs existed yet — a fresh build, not a mis-queue). Scope: make the five specific subtests named in #950's AC self-seeding (four in `registration.spec.ts` + issue-09 "Path 1"), fixing the recurring #936 flake's root cause (shared single-use seed state from `e2e/seed.ts`).

Added `web/e2e/registration-fixtures.ts` — a Playwright fixture `seedRegistration(kind)` that creates its own tournament/event/player(s) per test invocation (keyed by a fresh random id) and tears them down after, so two runs, two tests, or a CI retry can never collide. Wired it into the four named `registration.spec.ts` subtests and issue-09's "Path 1"; left "change partner", "accept a partner invite", and issue-09 "Path 2" on the shared seed since they weren't named in the AC. Diff confined to `web/e2e/` per the AC — `e2e/seed.ts` and the CI workflow untouched. typecheck/build/lint all clean (lint: scoped diff clean; full run shows the same pre-existing `main` errors, none new).

One snag caught before opening: my first PR body phrase "Fixes the recurring #936 flake" (and "doesn't close #936") tripped GitHub's closing-keyword parser and auto-linked #936 as a second closing issue — violates the one-issue-per-PR rule. Reworded to neutral phrasing ("Addresses... investigated in #936" / "issue #936 should stay open...") and re-verified only #950 closes.

PR: [#951](https://github.com/notronwest/tournament-manager/pull/951) (Closes #950), card moved to In Review. **Next:** Ron reviews/merges; per #950's note, #936 itself stays open until a week of clean regression runs on these specs.

## 2026-09-20 — Testing agent: daytime triage, all green

**Job 1 (triage):** newest untriaged run ([35513866940](https://github.com/notronwest/tournament-manager/actions/runs/35513866940), 2026-09-20 13:33 UTC) — **all green, 56 passed** (up from 33 pre-#945/#942/#938 spec additions still pending merge, so this run reflects the existing merged suite only). No failures to triage, no card needed. Not Monday, so no heartbeat posted to Discord per cadence rules (quiet-when-green).

**Job 2 (author):** skipped — daytime run, per-day authoring cap already spent on this morning's run (PR #945 for #10).

**Housekeeping:** confirmed the previously-flagged locally-modified `CLAUDE.md` (missing Engineering-standard/UI-work/Deployment blocks vs. `origin/main`) is still present and still untouched by me — out of scope for this run, flagging again in case it's stale. Draft PRs #945 (#10), #942 (#862), #938 (#860) remain open awaiting harness-access selector tuning; nothing new to do on them this run.

## 2026-09-20 — Testing agent: morning triage + spec PR for #10 + backlog-scope flag

**Job 1 (triage):** newest untriaged run ([35463990606](https://github.com/notronwest/tournament-manager/actions/runs/35463990606), 2026-09-19 19:19 UTC) failed only the two `e2e/offline/*` specs — the known #934 signature, and this run predates #935 (the fix) merging later the same day, so no new information. Commented on #934 for the record; no new card. `registration.spec.ts` + #936's specs were clean this run.

**Job 2 (author):** opened draft PR [#945](https://github.com/notronwest/tournament-manager/pull/945) (Closes #944) — `web/e2e/issue-10-partner-notice.spec.ts`, translating #10's AC ("partner won't be notified until checkout" copy). Added a dedicated tournament/event/player per scenario in `seed.ts` (not reusing `#253`'s fixtures, to avoid feeding the #936 shared-state race). Verified the copy is still live in `PublicTournamentPage.tsx` before writing the spec. **Draft, not normal PR:** this interactive session has no local access to the CI-only `E2E_*` secrets (they exist only as GH Actions repo secrets), so I could not run the spec against the deployed test app to tune selectors — needs that pass from whoever has harness access (Builder host or Ron) before it can come off draft. Tracking issue #944 set to **Blocked** for that reason. typecheck + lint clean; `playwright test --list` confirms the spec is discovered (33 tests / 8 files, was 30/7).

**Scope flag:** swept the board's Done items for resolved issues with `## Acceptance criteria` lacking a spec — found **~100+** (numbers 10–549), far past the per-run cap of 5 and mostly predating the AC/spec convention. Only picked #10 this run (oldest, simplest, verified-still-live). Worth Ron deciding: keep chipping at 5/day (~20+ days to clear), raise the cap for a dedicated backfill, or accept the older ones as out of scope. **Next:** if continuing the backfill, #12 (pricing-override admin copy) is the next-oldest verified candidate.

**Unrelated observation:** found `CLAUDE.md` locally modified (uncommitted) in this checkout — missing the Engineering-standard/UI-work/Deployment blocks that are present on `origin/main`. Did not touch it (not part of this run's scope, and it may be another agent's in-progress edit on this shared host) — flagging in case it's unintentional.

## 2026-09-19 — Reviewer: PR #935 reviewed (APPROVE)

Reviewed PR #935 ("test(e2e): exclude offline/ specs from the deployed-CI chromium project",
closes #934) per `daemon/agents/reviewer/PROMPT.md`. Diff is a single-file change to
`web/playwright.config.ts`: adds `"**/offline/**"` to the `chromium` project's `testIgnore`
alongside the existing `"**/mobile/**"` exclusion, so `e2e/offline/first-paint.spec.ts` and
`e2e/offline/network-audit.spec.ts` (which abort any non-localhost request to simulate the
network being down) stop running under the deployed-CI regression, where they were 100%-repro
failing on the first `page.goto` (6+ consecutive nightly runs, 2026-09-15 through 2026-09-17).

Verified independently rather than trusting the PR body: pulled the branch into a scratch
worktree and ran `npx playwright test --list --project=chromium` myself — 30 tests / 7 files,
no `offline/**` specs listed (matches the PR's claimed 32→30 / 9→7 before/after). Confirmed
`scripts/offline-verify.sh` and `playwright.offline.config.ts` are untouched (AC #2), and that
the `iphone`/`pixel` projects (explicit `testMatch` whitelist, never included `offline/**`) are
unaffected (32 tests / 3 files, unchanged). No UI change, no `DECISIONS.md` record touches CI
test scoping. Scope matches #934's acceptance criteria exactly — no scope creep.

Posted the verdict comment (`<!-- wmpc-reviewer -->` marker) and applied `reviewed:approve`.

**Next:** queue clear for this session (#878, #884, #935 all reviewed 2026-09-19).

## 2026-09-19 — Reviewer: PR #884 reviewed (REQUEST CHANGES)

Reviewed PR #884 ("feat(tournament): in-app printable round-robin pool tracking sheets") per
`daemon/agents/reviewer/PROMPT.md`. No `Closes #N` / linked issue (`closingIssuesReferences` empty;
searched for a matching story across "print", "pool sheets", "round robin", "tracking sheet",
"gen_sheets" — none found) — flagged as a non-blocking hygiene note, graded against the PR's own
stated contract instead.

Blocking finding: `PoolSheetsPage.tsx:31` (local `Team` type) and `:427-468` (local `buildTeams`)
reimplement, field-for-field, the `Team` type + `buildTeams` already in `web/src/lib/bracketTeams.ts`
(which `EventConsolePage.tsx` imports) — extracted there specifically so every consumer computes
teams "exactly the way the console shows them." The duplicate happens to match today, but the next
fix to the canonical `buildTeams` won't propagate here, silently breaking the PR's own claim that
printed `T1..Tn` numbers match the app's. Cited CLAUDE.md's "reuse before adding" and gave the fix
(import `buildTeams`/`Team` from `lib/bracketTeams` instead).

Independently verified the circle-method round-robin schedule (n=4,5,6,7: every pair plays exactly
once, no dupes/omissions), the multi-tenant scoping on the event fetch, and that the registration
status filter (`SPOT_HOLDING_STATUSES`) matches `EventConsolePage`'s own team-list query.

Posted the verdict comment (`<!-- wmpc-reviewer -->` marker) and applied `reviewed:changes`.

**Next:** #935 still open in the queue, not reviewed this session (out of this session's scope).

## 2026-09-19 — Reviewer: PR #878 reviewed (REQUEST CHANGES)

Reviewed PR #878 ("feat(playoff): single-elimination brackets for Top-6 and Top-8") per
`daemon/agents/reviewer/PROMPT.md`. Verified correctness independently rather than trusting the PR
body: pulled the branch into a scratch worktree, ran `vitest run` (83/83 green, incl. the new
20-case `playoffBracket.test.ts`) and `tsc -b --noEmit` (clean) myself, and hand-traced the Top-6/
Top-8 seeding, bye pre-placement, and `winnerTarget`/`bronzeTarget` feed-forward math in
`web/src/lib/playoffBracket.ts`, plus the bye-restore path in `EventConsolePage.tsx`'s
`onResetAllScores` (`:349-388`) — all correct, including the Top-6 play-in-upset-into-bronze edge
case the tests cover.

Blocked on one hard, CI-enforced finding: `gh pr view 878 --json closingIssuesReferences` is empty
and the required `PR links an issue` check is **FAILING**
(https://github.com/notronwest/tournament-manager/actions/runs/34672782995/job/103497197636). Per
`wmpc-meta/conventions/backlog.md` § "Every PR ties to an issue," every PR must `Closes #N`; I found
no existing story for this Top-6/Top-8 work (the double-elim epic #892/893/896/898 is a different,
separate feature). Builder needs to open a small tracking issue and add the closing keyword.

Design/scope/hygiene: clean — the new `playoff_rounds` `<option>`s reuse the existing native
`<select>` pattern (not a mode-selection surface, so the choice-tiles convention doesn't apply), and
the `matchLabel`/`playoffStageLabel` generalizations are in-scope for supporting 3-round brackets.

Posted the verdict comment (`<!-- wmpc-reviewer -->` marker) and applied `reviewed:changes`.

**Next:** per the task scope, did not review #884 or #935 this session — still open in the queue.

## 2026-09-19 — Reviewer: PR #877 reviewed (APPROVE)

Reviewed PR #877 ("fix(schedule): explain locked setup dropdowns in per-event panels") per
`daemon/agents/reviewer/PROMPT.md`. No `Closes #N` / linked issue (`closingIssuesReferences` empty,
no matching story found) — same Ron-productized-local-fix pattern as #874/#869, so graded against
the PR's own stated goal plus written standards rather than acceptance criteria.

Diff is a single file, `web/src/pages/admin/SchedulePage.tsx`, +19/-0: new `locked: boolean` prop
threaded from the page's `const locked = !!tournament?.schedule_locked_at` (`:377`) through the
single `<SetupPanel>` call site (`:1412`) into the component's props type and a new hint block
(`:1710-1725`) rendered when locked. Confirmed only one `<SetupPanel>` call site exists (no other
caller missing the new prop), and the hint's copy ("click \"Unlock schedule\" at the top") matches
the actual button label at `:972` exactly.

This is a direct instance of the documented design-system convention (`wmpc-meta/design-system/DESIGN_SYSTEM.md`
changelog, 2026-06-06): "Don't render dead ends" — gate the affordance and show the reason instead
of silently disabling. Styling reuses the file's existing `warnBg`/`warnFg` tokens (no new raw hex)
and matches the visual pattern of the adjacent `warning`/`error` blocks and the existing lock banner
elsewhere in the same file. No `DECISIONS.md` entry applies (no migration, no deploy/branch change,
no money path). Independently verified `npm run typecheck` clean in a scratch worktree off the PR
branch rather than trusting the PR body's claim.

Posted the verdict comment (`<!-- wmpc-reviewer -->` marker) and applied `reviewed:approve`.

**Next:** Reviewer queue (867/869/872/874/877) is now fully drained for this pass.

## 2026-09-19 — Reviewer: PR #874 reviewed (APPROVE)

Reviewed PR #874 ("feat(scorecards): show pool on printed round-robin scorecards") per
`daemon/agents/reviewer/PROMPT.md`. No `Closes #N` / linked issue exists (`closingIssuesReferences`
empty, no matching story found) — same pattern as #869/#877, read as Ron productizing a fix he'd
already verified locally, so graded against the PR's own stated goal (multi-pool round-robin
scorecards were printing identical, unsorted-by-pool) plus written standards. Diff is a single
file, `web/src/pages/admin/ScorecardsPage.tsx`: new `poolLetter()` helper is byte-identical to the
existing convention in `EventConsolePage.tsx` (1-based `pool_index` → A/B/C), the pool is only
shown when `event.pool_count > 1 && m.stage === "round_robin"` (matches the file's existing stage
filter), and playoff matches correctly show no pool since they can be cross-pool. Lookup keys off
`team_a_reg_id` only, safe because round-robin matches are always intra-pool; null-safety checked
throughout (no crash paths for a missing team or unset `pool_index`).

Independently verified in a scratch worktree off the PR head rather than trusting the PR body's
claims: `npm install && npx tsc -b --noEmit && npm run build` all clean. No `DECISIONS.md`
violations (no migration, single file, no direct-to-main push). Design is a plain-text addition
next to the existing "Match:" label in the printed card's meta line — no new component/token,
nothing in `docs/DESIGN_PREFERENCES.md` it could violate. Scope matches the PR description exactly.

Posted the verdict comment (`<!-- wmpc-reviewer -->` marker) and applied `reviewed:approve`.

**Next:** queue still has #877 awaiting review (out of scope for this session).

## 2026-09-19 — Reviewer: PR #872 reviewed (APPROVE)

Reviewed PR #872 ("fix(standings): break record ties by head-to-head before differential,"
Closes #873, part of #40) per `daemon/agents/reviewer/PROMPT.md`. Bug: `computeStandings`
(feeds both the Standings tab and playoff seeding) broke record ties by differential then
points-for, never considering head-to-head — real data showed a 4-2 three-way tie seeded
exactly backwards (worst-record-vs-the-tied-group ranked #1). Fix builds a head-to-head win
map while tallying, then within each equal-wins group sorts by H2H wins scoped to *that
tied group* (mini round-robin), falling through to diff → points-for on a circular tie.
Extracted into new `web/src/lib/standings.ts` (React-free, mirrors `lib/resultsExport.ts`)
so it's unit-testable; `EventConsolePage.tsx` now imports it instead of defining it inline.

Independently verified in a scratch worktree on the PR head (not just trusting the PR body):
`tsc -b --noEmit` clean, `vitest run` 59/59 green (incl. 3 new tiebreak tests: 2-way, 3-way
mini round-robin, circular), `eslint` clean on both new files. Traced the algorithm by hand
against the issue's required order and confirmed `captainRegId` is used consistently as the
match-team key everywhere else in `EventConsolePage.tsx`, so the H2H map keys line up. No
DECISIONS.md entry governs this; no UI touched; scope is tight. PR body's own "⚠️ Seeding
impact" section already flags that this reorders standings/seeding for any event with record
ties and recommends a sanity check before PROD promotion.

Posted the verdict comment (`<!-- wmpc-reviewer -->` marker) and applied `reviewed:approve`.

**Next:** queue still has #874, #877 awaiting review (out of scope for this session).

## 2026-09-19 — Reviewer: PR #869 reviewed (REQUEST CHANGES)

Reviewed PR #869 ("feat(admin): preview the playoff bracket before generating it") per
`daemon/agents/reviewer/PROMPT.md`. No `Closes #N` / linked issue exists for this PR
(`closingIssuesReferences` empty, no matching story issue found) — read as Ron
productizing his own dry-run prototype, so graded against the PR's own stated design
goal ("what an organizer confirms can't drift from what gets created") plus written
repo standards. Independently verified `tsc -b` clean and `vitest run` 65/65 pass in a
scratch checkout of the PR head. Two concrete findings, both REQUEST CHANGES-worthy:

1. **Correctness** — the preview only shows its "not enough teams" warning when
   `previewSeeds.length === 0` (`EventConsolePage.tsx:2302`), but the non-cross-pool
   path can return a short-but-nonempty array (e.g. 3 of 4 needed — the exact case
   `playoffSeeding.test.ts` documents). Preview silently renders an incomplete
   matchup as fine; `onGenerate` then rejects it *after* the organizer confirms —
   the drift the PR claims the shared helper prevents.
2. **Design/mobile** — `ConfirmModal`'s `modalStyle` (`ConfirmModal.tsx:122-128`) has
   no `maxHeight`/scroll, and this PR is the first caller to pass an unbounded-height
   body (full standings table + lists) into it. On a phone viewport with a realistic
   team count, content will clip the Generate/Go-back buttons with no way to scroll —
   violates DESIGN_PREFERENCES.md's mobile-first hard rule (test populated states at
   390px) and DESIGN_SYSTEM.md's Adaptive principle (#9).

Posted the verdict comment (`<!-- wmpc-reviewer -->` marker) and applied
`reviewed:changes`, creating that label in the repo (only `reviewed:approve` existed
so far).

**Next:** Builder picks up #869's two findings for rework. Queue still has #872, #874,
#877 awaiting review (out of scope for this session).

## 2026-09-19 — Reviewer: PR #867 reviewed (APPROVE)

Reviewed PR #867 ("Polish and unify score entry across all three surfaces," Closes #868) per
`daemon/agents/reviewer/PROMPT.md` — the first PR review by the new Reviewer agent (D-0018).
Checked the diff against #868's acceptance bullets (numeric `type="text"` score boxes replacing
`type="number"`'s misaligned spin-arrows, `aria-label` replacing the redundant A/B placeholder,
Enter-to-submit on all three surfaces, validation paths unchanged) — all implemented, none
missing. Independently re-verified in a scratch worktree off the PR head rather than trusting
the PR body's claims: `typecheck` clean, `build` clean, and `eslint` on the three touched files
shows the same 4 pre-existing `set-state-in-effect` errors present on `main` (no new lint
findings). No `DECISIONS.md` violations (no migration, no direct-to-main push); design aligns
with `wmpc-meta/design-system/DESIGN_SYSTEM.md` principles 2 and 8. Scope was clean — exactly
the three files the issue named, PR body explicitly excludes unrelated local changes. Posted the
verdict comment (`<!-- wmpc-reviewer -->` marker) and applied `reviewed:approve`, creating that
label in the repo since it didn't exist yet (also needed for future `reviewed:changes` /
`reviewed:escalate` verdicts).

**Next:** merge #867 (Ron's step per D-0018 — Reviewer never merges); the queue still has #869,
#872, #874, #877 awaiting review (out of scope for this session, which was scoped to #867 only).

## 2026-09-19 — Testing agent (daytime run): Job 1 triage only, no new signal

Triaged the newest regression run, [35444828534](https://github.com/notronwest/tournament-manager/actions/runs/35444828534) (2026-09-19 13:07 UTC, the scheduled daytime cron — the two `workflow_dispatch` runs from this morning's #862 debugging were skipped as not part of the triage cadence). Final tally: 2 failed / 55 passed. Both failure classes are already-tracked, no new cards:

- **Offline scoping bug (#934):** `first-paint.spec.ts` + `network-audit.spec.ts` still `ERR_INTERNET_DISCONNECTED` on both base + retry — same signature as every prior run. Fix is PR #935, still unmerged. Commented an update on #934.
- **Shared-state flake (#936):** three `registration.spec.ts` subtests ("register with a new partner", "register needing a partner", "register for a singles event") each failed on attempt 1, passed on retry — net 0 failures on this file, consistent with the documented race. Still Blocked on Ron's isolation-vs-quarantine call (already asked in the issue body — not re-proposing). Commented an update on #936.

No Discord post — both patterns already surfaced today, nothing new to report. Job 2 skipped (daytime run; authoring cap belongs to mornings). Noticed in passing: #934 and #936 don't appear on the WMPC Roadmap board (Project #1) despite being filed as bug issues — only #862 (unrelated) shows up under tournament-manager in a 500-item board pull. Not fixing that today (out of scope for a triage pass), flagging so it doesn't silently stay a gap.

**Next:** same as this morning — Ron reviews/merges #935 (quick, mechanical, verified); decides #936's isolation-vs-quarantine question; PR #942 still needs its second failure root-caused (untouched today, Job 2 is morning-only).

## 2026-09-19 — Testing agent (morning run): Job 1 triage + #862 regression spec (PR #942, verification in flight)

**Job 1:** triaged the newest run, [35386996729](https://github.com/notronwest/tournament-manager/actions/runs/35386996729) (2026-09-18 19:37 UTC — later than the daytime run already covered, so a real third run needed its own pass). All 4 failures matched already-filed issues: the offline/ CI-scoping bug (#934, fix PR #935 still unmerged) and `registration.spec.ts` "register for a singles event" + `issue-09-confirm-cancel.spec.ts` Path 1 — both instances of the shared-mutable-DB flake tracked in #936 (still Blocked on Ron's isolation-vs-quarantine call). Commented an update on #936 with the new subtest + the prior run's "register with a new partner" flake-then-pass, rather than filing a duplicate. No new cards.

Housekeeping: found CLAUDE.md + STATUS.md uncommitted in the working tree at session start — yesterday's daytime-triage STATUS entry had never made it into a commit before the next `git pull` fast-forwarded past it, silently dropping it. Recovered it from the stash and committed (`bb9707e`); dropped an unrelated, already-in-progress CLAUDE.md block-reorder edit rather than commit something out of this agent's scope.

**Job 2:** authored `web/e2e/issue-862-admin-rating-picker.spec.ts` for #862 ("Admin player profile editor should use the same rating picker and gender UX as the player's Profile page," Done, no spec) — the oldest resolved-and-uncovered issue found. Tracking issue #941, PR #942 (`test/issue-862-spec`), draft. First dispatch (run 35439313256) **failed** — "Not authorized to view this player": the spec targeted Pam (`SEED.playerEmail`), whose *only* registration is the exact one `issue-09-confirm-cancel.spec.ts`'s Path 2 test cancels earlier in the same suite run, so by the time this spec ran she no longer belonged to the org and `resolvePlayerAccess` denied it — a shared-mutable-seed-state bug in the spec itself, same failure class as #936. Fixed by targeting Mona (`SEED.selfService.viewerEmail`) instead — her registration is a stable "read-only view" fixture nothing else touches. Re-dispatched (run 35439668974): **still failed**, same assertion (radiogroup not found) but ~4x faster (2.7s vs. the first run's full 10s timeout) — a different cause than the first failure, not yet root-caused. Session ran out of budget to keep debugging live against CI; left **draft** with both failure signatures noted on PR #942 for the next run or a manual look.

**Next:** Ron reviews/merges #935 (quick, mechanical, verified); decides #936's isolation-vs-quarantine question; PR #942 needs its second failure root-caused before it can go green — do not merge as-is.

## 2026-09-18 — SYNCED NH Baners results from the offline laptop → PROD

Ron: "Sync the nh baners tournament from my laptop to production." Same hand
procedure as the Angels sync (memory `offline-to-prod-sync`), one transaction via
`supabase db query --linked --file`, PROD pre-state in
`backups/prod-pre-sync-nh-baners-20260918T141527.tgz`.

What the desk did on event day: re-created the field as **7 teams / 14 regs** (PROD
had 6 teams / 12), all at 18:52–18:55 UTC 09-15. Mapping applied: 7 players already
on PROD → their PROD reg rows updated (seed, paid, partner) and match refs remapped;
desk-created "Ron West" (no email) → Ron's real PROD player; 6 genuinely new players
inserted (Berg, G+D Gove, Kalis, K+L Wilhite — no emails on file); 5 PROD players who
never played → `withdrawn` (Candace Byrnes, Stephen Kendall, Evangelista, Wade,
Parisi; Ron decides refunds); 12 completed matches (crossover DE, feeds wired after
insert), event_courts 1–2, event `complete`, tournament `completed`. Verified: 14
paid regs all mutually paired, seeds 1–7, 0 dangling team refs; Final = Berg / West
def. Kalis / Laurinaitis 15–8. Public Results tab now shows it.

Gotcha (cost one rollback): `event_registrations.partner_status` is NOT NULL
(default `solo`) — withdrawn rows must use `'solo'`, not null. Local tournament had
picked a saved `location_id` that doesn't exist on PROD; PROD kept its text
location fields (not synced).

Still true: every NH Baners player has **no email**, so the summary email can't reach
them until addresses are added on their player records. Next: build `push-live.py`
so this stops being a hand job (third time now).

## 2026-09-18 — Testing agent: offline/ specs were failing every regression run (scoping bug, not a product break)

Morning triage of the nightly+daytime regression runs found the last 6+ runs (2026-09-15
through 2026-09-17) all red on exactly `e2e/offline/first-paint.spec.ts` +
`e2e/offline/network-audit.spec.ts`, 100% reproducible, same `ERR_INTERNET_DISCONNECTED`
error every time. Root cause: those two specs (added in #843, part of the offline epic
#732) are purpose-built to run ONLY via `scripts/offline-verify.sh` +
`playwright.offline.config.ts` against `localhost` — each installs a `context.route` guard
that aborts any non-localhost request to simulate the network being down. They were never
excluded from `web/playwright.config.ts`'s `chromium` project (which runs the deployed
nightly suite against `E2E_BASE_URL`), so the guard aborted the very first navigation.
**Not a product regression** — the app never broke. Filed #934, fixed in PR #935 (adds
`"**/offline/**"` to the chromium project's `testIgnore`, mirroring the existing
`"**/mobile/**"` exclusion). Verified locally: `--list --project=chromium` goes from
32→30 tests / 9→7 files; typecheck clean; lint unchanged from `main` (27 pre-existing,
unrelated errors). **Not merged — awaiting Ron's review.**

Also surfaced (not this run's regression, but a pattern worth a card): `registration.spec.ts`
+ `issue-09-confirm-cancel.spec.ts` failed intermittently in 4 of the last 6 runs — a shared
mutable-DB-state race the suite's own config comments already call out (`workers: 1` because
the suite "mutates registration state" against one shared `tm-test` deploy), clean on the
most recent run. Filed #936, **Blocked** — needs a call from Ron: per-test seed isolation vs.
quarantining those specs.

Also kicked off (background agent, morning-only Job 2 cap): a regression spec for #860
(registration-deadline reopen bug Ron hit live on PB Angels 2026-09-11) — tracking issue
#937, PR #938 (`test/issue-860-spec`). The agent had no local E2E credentials so it
authored the spec from source only, never ran it. Verified that directly: manually
dispatched the real regression workflow against that branch (run 35338842927) — both new
tests fail. **Converted PR #938 to draft** with the failure-run link, rather than leave an
unverified spec looking merge-ready.

**Next:** Ron reviews/merges PR #935 (quick, mechanical, verified); decides #936's
isolation-vs-quarantine question; PR #938 stays draft until a future Testing-agent run (with
real E2E creds) or Ron tunes it against the linked failure traces.

## 2026-09-18 — Testing agent (daytime run): newest regression run reconfirms #934/#936, no new cards

Daytime (~15:00 local) Job 1 triage of run [35350980672](https://github.com/notronwest/tournament-manager/actions/runs/35350980672) (13:34 UTC, the newest one not yet covered by this morning's triage). All 3 failures matched already-filed issues exactly — the offline/ CI-scoping bug (#934, fix PR #935 still unmerged) and the shared-mutable-DB registration/issue-09 flake (#936, still Blocked on Ron's isolation-vs-quarantine call). Commented an update on each rather than filing duplicates (idempotency rule); no new Discord post since nothing changed beyond confirming the pattern persists.

**Next:** unchanged from the morning entry above — merge #935, decide #936.

## 2026-09-16 — Email/Contacts "Registrants" filter now overlaps with Imported

Ron: Email page said 44 registrants for Pickleball Angels; PROD has 70 active
registrant players with email. Cause: `lib/orgContacts` gives each contact ONE
label (manual > import > registrant) and the filter compared the label, so the 26
registrants who were also on the imported list only showed under "Imported".
Fix: `OrgContact.isRegistrant` + pure `lib/contactSource.ts` `matchesSource()`
(tests) — "Registrants" = anyone with an active registration, "Imported"/"Added
manually" = how the link was created; used by EmailPage and OrgContactsPage;
Contacts table shows "· registered" next to an Imported/Manual pill when the
person also registered. Labels and recipients otherwise unchanged.

Also found: the 12 NH Baners players (wmpc org) have **no email on file**, so no
summary/broadcast can reach them until emails are added to their player records.

## 2026-09-15 — PDF attachments on the admin Email page (story #925)

Ron: "attach the pdf to the normal email functionality we have as an admin." Same
mechanics as the summary email: `send-contact-broadcast` keeps its `/emails/batch`
path when no attachments, and switches to per-recipient windowed sends
(`attachments[]`, `cursor`/`limit`/`broadcastId`) when PDFs are attached; the
attachment validation + paced `sendOne` move to `_shared/attachments.ts` and
`send-tournament-summary` is refactored onto it. UX: Email page composer gets
**Attach PDF…** (≤3 files, 5 MB total, chips, inline rejections) and the progress
loop from `SummaryEmailModal`. Worktrees `feat/broadcast-attachments-fn` (`[FN]`
first) and `feat/broadcast-attachments-ux`. No new secret.
Shipped: `[FN]` PR #926 (15dacea: `_shared/attachments.ts`, windowed path in
`send-contact-broadcast`, summary fn refactored onto the helper) + UX PR (this one:
`lib/emailAttachments.ts` + 13 tests, EmailPage picker/chips/drag-drop/progress loop).
Gates green; **not browser-checked at 390px** (composer is behind admin auth; no env
here). Next: Ron sends himself a test with a PDF from the Email page on PROD.

## 2026-09-15 — Event morning: offline laptop DB restored to pristine NH Baners snapshot

Ron finished dry-running double elim on the laptop; ran `backups/restore-pristine.sh`
(snapshot `pa-loaded-pristine.sql`, refreshed 09-14 19:50 after the NH Baners pull).
Verified after restore: NH Baners 1 event, 12 registrations all paired, 0 seeds,
0 matches, 0 check-ins, 0 court slices; director org membership intact; app at
:5173 answers 200. Local DB is at migration head (`20260914220000`). Script's
"95 registrations" success line is stale copy from the Angels weekend — harmless.
Next: run the event per the cheat sheet; afterwards "sync the tournament back to
B&E" (procedure in memory `offline-to-prod-sync`).

**In flight (same day, Ron's ask: "send the summary to attendees as an attachment"):**
building "Email to attendees" on the Summary report page. Design: client-side
text PDF via `pdf-lib` (`web/src/lib/summaryPdf.ts`, dynamic import) — also a
new "Download PDF" button so the file Ron downloads is byte-identical to what
attendees get; new edge fn `send-tournament-summary` (mirrors
`send-tournament-briefing`: staff auth, spot-holding registrants deduped by
email, `contact_broadcasts` logging) sending ONE Resend request per recipient
with `attachments[]` because `/emails/batch` can't carry attachments, paced for
Resend's 2 req/s and windowed (`cursor`/`limit`/`broadcastId`, client loops).
UI: `components/SummaryEmailModal.tsx` (count preview, send-test-to-me, consent,
confirm, progress). Worktrees `feat/summary-email-fn` (`[FN]` PR first) and
`feat/summary-email-ux`. No new secret needed (RESEND_* exist on both projects).
Shipped: story #920; `[FN]` PR #921 (b63c41a) + UX PR (this one): `lib/summaryPdf.ts`
(pdf-lib 1.17.1, lazy chunk ~438 kB/181 kB gz, WinAnsi-sanitized text, 7 tests),
`components/SummaryEmailModal.tsx`, Summary page buttons **Email to attendees** /
**Download PDF** / Print / Copy as text. Not browser-verified end to end (needs a
logged-in admin on TEST with Resend) — typecheck/135 tests/lint/build green, sample PDF
eyeballed. Next: Ron sends himself a test from a real tournament on PROD.

## 2026-09-14 — Double elimination shipped to PROD; day-of PRs merged for tomorrow's NH Baners event; laptop offline stack

**Double elimination (epic built end-to-end, all on PROD):** PRs #902 (pure
`lib/doubleElim.ts` + 17 tests), #903 (`[DB]` migration
`20260914210000_double_elim.sql` — `events.double_elim_final` enum
`crossover|bronze_only`, `matches.bracket/slot_key/label/if_necessary/
feeds_winner_to(+side)/feeds_loser_to(+side)`), #905 (event form "Tournament
style" round_robin|double_elim + Final format; Teams tab seed randomizers;
Event console `DoubleElimSection` — Generate inserts slots then wires feeds by
`slot_key`; data-driven `feedForwardPlayoffWinners` — W-champ wins F1 deletes
the if-necessary F2; fair court queue via `bracketRank`), #907 (public
Results tab — medals + playoff/bracket scores), #910 (`BracketView`: zoomable
0.4–2×, scrollable, real bracket picture; Bracket|Table toggle; click a card to
score). Design notes in memory `double-elim-design.md`. Ron's call: **offer both**
finals — crossover (true DE, 2N−2 games +1 if F2) and bronze-only (consolation
ends at L(2k−3), 2N−4 games).

**Merged today for the event (Builder PRs Ron asked to run "today"):** #880
`[DB]` `event_registrations.checked_in_at` (renumbered to
`20260914220000` — the original `20260912…` stamp was behind remote head and
would have failed closed; TEST migration workflow green), #865 offline
runtime hardening, #866 assign Player B to a partnerless team, #881 day-of
check-in screen + printable sheet + Start gate (rebased; kept both import
groups), #870 score-entry safety (rebased; `MatchRow` now requires `event` —
added at both `DoubleElimSection` call sites). Typecheck / 125 vitest / build
green on each. Tracking issues for the Builder PRs' `Closes` check: #912 (#865),
#913 (#866). Promotion PR main→production follows this entry.

**Laptop / offline for NH Baners:** `backups/pull-live.py` now takes
`TM_ORG_ID` / `TM_TID` env and clears a same-slug seeded org before load;
run order in `backups/OFFLINE-CHEATSHEET.md`; `.claude/launch.json` has an
`offline` config (`scripts/offline.sh`, :5173). Local DB migrated to head
(`checked_in_at` present; migration is idempotent). Docker reinstalled on the
new laptop via Homebrew cask.

**Incident (this session):** a failed `cd` into a worktree made a
`reset --hard` + rebase run in the shared main checkout, wiping its
*uncommitted* STATUS.md/CLAUDE.md edits (CLAUDE.md is the bootstrap block
sync — harmless; the STATUS content is re-recorded in this entry). Rule
re-learned: `cd "$WT" || exit 1` before any destructive git op, and the
worktree script wants the **repo path**, not its basename.

**Still open / not merged:** Builder PRs #867, #869, #872, #874, #877, #878,
#884, #885; medal-match score editing for brackets on Edit event; bracket
rounds on the print sheet; pg_net on PROD (#785).

## 2026-09-11 — Score-entry safety: valid-score enforcement + confirm modal (#871/#868), PR #870 open

Productized two score-entry safety features Ron applied locally on the offline
laptop from live tournament-desk feedback: score entry accepted physically
impossible finals (a game to 11 win-by-2 took 9–7, which nobody had won —
only NaN/negative/tied were checked). New shared, tested helper
`web/src/lib/scoreValidation.ts`: `resolveScoreRules(match,event)` (per-match
`points_to_win`/`win_by` win — playoff rows carry their semifinal/medal config
stamped at bracket generation; round-robin falls back to the event) +
`validateScore` (reach the target, win by the margin, end by exactly win-by
past the target; target checks only when a target is known so time-capped
formats aren't false-rejected). Wired into both Court Manager screens
(validate → ConfirmModal showing teams/scores/winner before writing) and the
Games-tab MatchRow (validation inline, no modal). Also folded in the #868
polish across all three surfaces: `number`→`text inputMode=numeric` + digit
sanitize + `aria-label`s + Enter-to-submit. Tests: all required cases (11-9 ok,
11-10/9-7/13-9 rejected, 12-10/15-13 ok) + guards + RR-vs-playoff resolution;
full suite 71/71, `tsc -b` clean, Pages preview built.

**Scope note:** the offline laptop also had UNRELATED uncommitted edits in
`EventConsolePage.tsx` (doubles partner-registration fix + playoff-bracket
preview modal) and `supabase/config.toml`/`seed.sql` — deliberately left out
of this PR; still uncommitted in the main checkout for separate handling.

**Next:** Ron review + merge PR #870 → TEST, validate at a desk (9–7 rejected,
valid score confirms the winner), then promote via a `main`→`production` PR.
## 2026-09-12 — Day-of player check-in: schema PR #880 + UX PR #881 open

Requested live by Ron during the Pickleball Angels tournament — nothing
check-in-related existed (front desk ran off the paper `backups/checkin-sheet.html`).
Built in two PRs per the DB/UX split (a PR preview runs against the live DB):

- **#880 (schema, `feat/checkin-schema`)** — nullable
  `event_registrations.checked_in_at` + `(event_id, checked_in_at)` index. No
  RLS added (existing org-staff update / org-member select cover it).
- **#881 (frontend, `feat/player-checkin`)** — `lib/checkin.ts` (pure, tested:
  build roster, check-ALL-a-player's-events, `eventCheckInGate`); `CheckInPage`
  at `…/tournaments/:slug/checkin` (autofocus search, Enter to check in top
  match, running count, missing filter, per-player check-in/undo across all
  their events); `CheckInPrintModal` (A–Z printable master sheet mirroring the
  paper stopgap); and a **hard-block gate with organizer override** on Generate
  matches (RoundRobinSection) and Start event (draft/ready→active) that lists
  missing players. Resume/Reopen aren't gated.

Check-in is a PLAYER action (stamps every spot-holding reg they hold in the
tournament at once; undo nulls them). `checked_in_at` lags the generated types,
so it's read via `"*"` + written through an untyped client (repo convention,
cf. `schedule_order`). `tsc -b` clean, 77 tests pass, `vite build` clean.

**Next:** merge #880 → applies to TEST; then merge #881; validate check-in +
the Start gate on TEST; promote `main`→`production` when ready.
## 2026-09-11 — Event console: assigning a Player B to a partner-seeker no longer silently drops (PR #866)

Ron (fix pre-applied uncommitted on the offline laptop, reproduced properly here with review
+ tests): in the event console **Teams** editor, editing a doubles team with no Player B yet
(a solo / partner-seeker — `partner_status='seeking'`, `partner_registration_id` null),
picking a Player B and clicking **Save** silently no-op'd — no request, no error, row refetched
unchanged. Root cause: `saveEdit` only had an UPDATE-existing-partner path; no CREATE path when
none existed. Fix (`web/src/pages/admin/EventConsolePage.tsx`): when the doubles team is
partnerless, CREATE the partner `event_registration` and link both directions, mirroring the
working `addTeam` flow (insert Player B with `partner_registration_id=captainRegId`, then point
the captain reg at the new reg and flip its `partner_status` seeking→confirmed); the existing
swap-`player_id` path is preserved. Branch selection extracted to a pure
`resolvePartnerBAction()` helper (`web/src/lib/teamEdit.ts`) with unit coverage
(`teamEdit.test.ts`, 5 cases) — matches the repo's `src/lib/*.test.ts` convention; the Teams
editor has no component-test harness. Edge cases verified against schema: singles skipped;
seeking→confirmed on the captain update; the paired-roles side trigger
(`check_paired_roles_sides_trigger`) and any constraint error surface via `setError` (both
insert and update errors captured), so a bad pairing isn't silent — mirrors `addTeam`; seed /
pool_index untouched by the writes and preserved by `buildTeams`' coalesce. `npm run typecheck`
clean, full `vitest run` green (61); the 2 EventConsolePage lint errors are pre-existing
`set-state-in-effect` (line 635 on origin/main, untouched). NOT included: the laptop's
`supabase/config.toml` + `seed.sql` offline-dev tweaks (unrelated, left uncommitted there).

**Next:** Ron review + merge PR #866 → TEST, validate assigning a partner to a seeker (Judy
Poulin + Laurie Walmsley was the manual repro), then promote main→production for PROD.
## 2026-09-11 — Offline runtime hardened: fresh machine goes offline with one clean command (epic #732)

Fixed the two blockers hit live tonight setting up Ron's tournament laptop, so
a fresh checkout runs `bash scripts/offline.sh` and comes up clean with **no
manual config edits**:

1. **Missing web deps.** `scripts/offline.sh` now installs `web/node_modules`
   before launching Vite (`ensure_web_deps` → `npm ci`, guarded by a
   lockfile-hash stamp so reruns at the venue are instant and never needlessly
   wipe deps). A checkout predating the self-hosted `@fontsource/*` fonts
   (#735/#843) used to die at Vite import time — no longer.
2. **Inbucket port bug.** `[inbucket] enabled = false` is now committed in
   `supabase/config.toml` (with a comment explaining why). The pinned Supabase
   CLI (v2.105.0) can't publish inbucket's port and aborts the whole
   `supabase start`; this app never uses the local dev inbox, so it's off for
   good — CLI-version-independent, no venue-side edit. (Tonight's live
   workaround was the same toggle, uncommitted, on the shared `main` checkout.)

New verification harness (#735): `scripts/offline-verify.sh` runs the whole
check in one command — bundle grep + clean-checkout `npm ci` + real
`supabase start` via `offline.sh` + **first-paint with the network simulated
down** (new `web/e2e/offline/first-paint.spec.ts`, non-destructive). `--full`
also runs the existing full mock-event `network-audit.spec.ts` (which writes to
the local DB — don't use against a live event). Docs updated: `docs/OFFLINE.md`
(one-time setup now just "run offline.sh once online"; new harness section) and
`DEPLOYMENT.md` ("Does NOT deploy" now lists the offline tooling). `.gitignore`
now covers `supabase/.branches/` and `web/test-results/`.

**Verified:** clean-checkout `npm ci` + `build:offline` (fonts resolve, no
import error); `ensure_web_deps` stamp idempotency (install → instant no-op →
reinstall on drift); `offline-verify.sh` green end-to-end against the running
local stack (bundle grep, npm ci, runtime up on :5174, first-paint offline);
`typecheck` + `eslint` clean. **Not verified against a fully fresh
`supabase start`** — the local stack is a singleton by `project_id` and was up
for tonight's live setup, so I didn't cycle it; the running stack already has
inbucket disabled and came up clean (no `:54324` container), which is the same
committed config. Run `scripts/offline-verify.sh --full` on a clean clone at
the Friday dry-run to close that gap.

**Branch:** `fix/offline-runtime-hardening` (worktree) → PR.
## 2026-09-14 — SYNCED Pickleball Angels results from the offline laptop DB → PROD (+ session recap 09-10→09-14)

**Sync (today).** Sat Sep 12 ran on the offline stack; PROD had 0 matches. Started Docker +
local Supabase, exported both sides, field-diffed, applied ONE transaction via
`supabase db query --linked` (PROD pre-state: backups/prod-pre-sync-20260914T142707.tgz):
99 matches (ids preserved); event statuses (4 complete; Mixed Doubles 3.5 = medal_round — its
**BRONZE match Sarah Thibault v Cristina Omahen has no score: Ron enters it**); 66 pool_index;
event_courts (Mixed 2.75 → 5–8, Womens → 3,6,7); 3 new players (Caryn West, Erin Ma, Beth
Goldenberg) + 8 desk-created regs; 3 desk regs remapped onto PROD seeker rows (Terragni,
Thoresen, Gagnon — payments kept); 7 PROD regs the desk removed set **withdrawn** (Judy Poulin
Womens; Mixed 2.75: DeFranc, Duffy, Cogdill×2, French, Walmsley) — **refund decisions: Ron**.
Skipped the offline paid→pending flip on Nicole Richard. First attempt rolled back on an FK
order issue (insert new regs with partner null, then link). Procedure saved to memory
(offline-to-prod-sync). Local stack left running (`supabase stop` is safe; never --no-backup).
Working tree: Saturday's offline-only edits were **stashed** (superseded by open PRs #865
#866 #880 #881 #884) — `git stash list` → "offline-only tweaks from the Sep 12 PB Angels event".

**Recap of this session's shipped work (its STATUS entries were lost to a working-tree reset).**
All promoted to PROD unless noted: waitlist pay-to-claim + status parity (#758/#761→#766);
pg_net story #785 (Agent Ready); stories #770 #771 (Agent Ready); pair seekers by division
(#787→#790) + emails both players (#792→#793); pending-invites "Last sent" (#803/#805);
event-form pool team info (#814); RR estimator moved into Schedule, tool retired (#816);
schedule reorder + parallel packer by courts needed (#820/#821); inline setup + drag-drop
(#824); plan hold reasons (#827); cross-pool medal seeding (#830/#831); medal-round phase
(#834); schedule lock + cascade (#837/#838); formatted print sheet (#841); reopen on deadline
extend (#861); admin profile RatingPicker (#863). **#784 (pg_cron sweep) still HELD** — 4
Angels pending regs are now moot (event over): merge after Ron reconciles or accepts.

## 2026-09-11 — Builder: offer-waitlist-spot promotes the confirmed partner too (#770), PR #788 open

Built issue #770: offering a waitlist spot to one half of a confirmed doubles
team only promoted/emailed that one player, leaving the partner stranded
waitlisted while their teammate went pay-to-claim — the state that stranded
Tawnya Lopez, PB Angels, 2026-09-10. `supabase/functions/offer-waitlist-spot`
now mirrors `promote_from_waitlist` (DB, #758): when the offered registration
has a confirmed partner still `waitlisted`, the partner is promoted to
`waitlisted_pending_payment` and emailed in the same call; a solo player or a
partner already paid/pending is unaffected. No migration or UX change needed
(existing "pay to claim" UI already reads registration status). Single PR,
`edge-function` label, deploys on merge. Verified via standalone `tsc --strict`
on the function file (Deno import excluded) + `web/` typecheck/build/lint
(unaffected, no web files touched).

**Not verified:** against a live doubles waitlist / Resend from the sandbox —
no edge-function test harness in this repo. The PR's scripted steps are the
real check.

**Next:** Ron review + merge PR #788, validate on TEST (edge functions deploy
on merge, no PR preview for server-only changes).

## 2026-09-09 — Builder: offline field import/export (#736), PR #740 open

Built issue #736 (part of the offline-tournament epic #732): a new "Offline
field" tool on the tournament detail page exports each event's confirmed
teams (players, partner pairing, seed) to a JSON file, and imports that same
file's teams into matching events (matched by name) elsewhere — for taking
the locked Friday-AM registration field to the offline laptop. Also added a
per-event "Export results (CSV)" button on the event console's Standings
tab (standings + medal placements) for bringing Sunday's results back
online. `web/src/lib/fieldFile.ts` documents the JSON file shape in its
header comment. Typecheck/tests(32/32)/lint(no new vs main)/build all green.

**Not verified:** against an actual offline/local-Postgres target — #733's
local-runtime PR (#738) hadn't merged yet, so validation was against the
normal hosted Supabase preview. Import assumes the tournament + its events
already exist on the target DB (matches by event name); it does not create
tournaments/events from the file.

**Next:** Ron review + merge PR #740; once #738 (local Postgres runtime)
lands, do a real offline dry run importing a field file end-to-end.

## 2026-09-11 — Invites after close, UX half: event card keeps a registrant's actions when closed

PublicTournamentPage.EventCard.renderAction: the `if (!registrationOpen) return null` moved
from the top of the function to just before the Register / Join-waitlist branches. So with
registration closed, a player who already holds a registration still sees "You're invited",
"Pay now", "A spot opened — pay to claim", "Leave waitlist", "Cancel Registration" and
"Manage"; someone with no registration sees nothing (as before). Pairs with the [FN] guard
change so the checkout those CTAs lead to succeeds on a closed tournament. typecheck/build
green (node_modules reinstalled for #843's font packages), 56 tests pass; the page's one lint
error (line 574) is pre-existing.

## 2026-09-11 — Invites stay acceptable after registration closes — [FN] first, then UX

Ron: "allow people who have been invited to accept the invitation (if it's still valid)
even after tournament registration is closed." Traced the block: the accept page and
accept_partner_invite RPC never checked the window, but (a) `create-payment-intent`
refused any tournament whose status isn't 'published' (409 tournament_not_accepting_
payment), so an invitee could accept and then not pay; and (b) PublicTournamentPage's
EventCard.renderAction returned null for EVERY state once registrationOpen was false, hiding
"You're invited", "Pay now", "pay to claim" and "Leave waitlist" for people who already held
a registration. [FN] (this PR): the guard now allows 'published' OR 'closed' — closed means
no new sign-ups, but an existing pending registration (accepted invite, waitlist promotion,
organizer add) can still be paid; draft/completed/cancelled still refused. UX (next PR):
the registrationOpen gate moves to just the Register / Join-waitlist branches. Invite links
always went straight to the accept page, so acceptance itself was never blocked — payment
and the on-page CTAs were.

## 2026-09-11 — Briefing email copy: no weather bullet, location always shown, "Can't make it?" section

Ron: drop "A layer for the weather…" from What to bring; include the location; add a
section for players who can't make it (tell us early, try to find a replacement).
`send-tournament-briefing`: bullet removed; the "Getting there" block (previously only when
an address existed) is now a "Where" section whenever a location name OR address exists,
with the Google Maps link when there's an address; new "Can't make it?" section: tell us as
soon as you know (by replying, when a reply-to exists), find a replacement of a similar
level and send their name — keeps the partner and bracket whole. Harness 15/15, weather
bullet absent, new sections present. [FN] change → merges alone, then promote.

## 2026-09-11 — Public start times: /t/:org/:slug/start-times page + header button + time on each event card

Ron: "very clear and easy to see link on the tournament home page for start times; a page
that lists those times; start times on each event." New public `pages/public/StartTimesPage`
(route `/t/:orgSlug/:tournamentSlug/start-times`, works under the custom domain too):
events grouped by local day, ordered by time, "Time to be announced" group for unscheduled,
header band with dates/venue and "arrive 30 minutes before your first start time", note that
times are the device's zone. PublicTournamentPage: a solid ink/yellow pill button "🕘 Start
times" in the header action row (44px tap target) ahead of "Contact organizers", and each
EventCard shows "🕘 Sat, Sep 19 · 9:00 AM" (or "Start time to be announced") under its title.
Reads `events.scheduled_start_at` set on the admin Schedule page; public RLS already allows
it. typecheck/build green; the one lint error in PublicTournamentPage (line 574, setState in
effect) is pre-existing. Not browser-rendered — layout mirrors TournamentContactPage.

## 2026-09-11 — Pairing board: no "Pair with…" without a valid partner (mixed = one man + one woman)

Ron (screenshot): Mixed 2.75-3.25 offered Pair with… for two men. AttendeesPage seekers
section now filters candidates with `canFormTeam(event, a, b)` — mixed requires M+F, an
unknown gender can fill either side, other divisions unchanged — and the disabled reason
says "Needs a woman — none looking" / "Needs a man — none looking" (or the existing "No one
else is looking"). The PairSeekersModal receives only compatible candidates. typecheck/
lint/build green.

## 2026-09-11 — Merge events preview: teams not players; "unpaired players move too" spelled out

Ron (screenshot, mid-merge on PROD): cards read "11 registered · cap 12" — registrations
against a TEAM cap; real state was 6 teams (+1 forming) and 1 team (+1 forming). Fix is
client-only (no migration): MergeEventsPage now also calls the `event_roster` RPC for both
events and computes teams the same way the public page / Teams tab do (confirmed pairs ÷ 2 +
pending inviters + seekers nobody has spoken for), which after the other session's parity
migration includes promoted-but-unpaid waitlisters. Cards: "N teams (+M forming) · P players
· limit L teams" (singles: players). A sentence under the cards says everything moves —
complete teams, unpaired players, pending invites, waitlist — and partners stay paired; the
ConfirmModal counts teams/forming/players and says "Unpaired players move too". The SQL
already moved every non-deleted registration; this is presentation. typecheck/lint/build
green. Note: Ron is actively merging Womens 3.5-4.0+ → 2.75-3.25 on PROD (PROD backup taken
03:41Z, artifact db-backup-PROD-20260911-034148Z).

## 2026-09-11 — Pending partner invites: resolution detection, duplicate matching, remove

Ron (with screenshots): the panel listed invites that were done (inviter withdrawn, partner
paid), couldn't see that Cole Stephan registered under a different email than he was invited
at, and had no way to remove invites. `lib/partnerInvites.fetchPendingPartnerInvites` now
loads every live reg in the affected events (with player email) and stamps each invite with a
`resolution`: **open** (nothing happened), **registered** (invitee found among the event's
registrants — same player, else email match against the invite email / invitee record, else
normalized name match — with `alreadyPaired` if they have a confirmed partner), or **settled**
(inviter withdrawn/cancelled/refunded/no reg, inviter+invitee already paired, or inviter paired
with someone else). New helpers `deletePartnerInvites` (RLS: org members may delete) and
`pairInviteWithRegistration` (pairAndResolveInvites + delete the invite, which may point at
the duplicate player id). Panel: "What's happened" column with pills, rows ordered
open → registered → done, **Pair & clear**, per-row **Remove/Clear** (ConfirmModal),
**Clear N done**, **Remove selected**; Resend only for open rows with email. AttendeesPage
passes onChanged so the list refreshes after pairing. Todd Shaver: he IS in the panel in the
screenshot (row 5); the roster's "invited — not registered yet" and the panel read the same
pending invites, so removing the invite clears both. typecheck/lint green, 32 tests pass
(roster export fixture gained the new fields). Not browser-rendered (Attendees needs many
stubs) — table keeps its overflow-x scroll on phones as before.

## 2026-09-11 — Admin change emails UX: registration editor now notifies players (#777 FN merged)

`lib/registrations.notifyRegistrationChange` (invokes notify-registration-change with the
browser tz) + `RegistrationEditorModal.notifyThenDone`: after **Move to another event**
(change=moved, fromEventId, previousPartnerRegId), **Pair with** / **Assign partner**
(partner_assigned) and **Remove partner** (partner_removed, previousPartnerRegId). Best-
effort by design: the change is saved and the list refreshed BEFORE the email; if the
function errors or someone has no email, the modal stays open with "Saved, but…" naming
who wasn't reached; otherwise it closes as before. Settle / Reassign / Withdraw are
unchanged (out of scope). typecheck/lint/build green. Not exercised against Resend — Ron:
move a test registration on TEST and check the inbox.

## 2026-09-11 — BUILDING: email players on admin division / partner changes — [FN] first

Ron: "when an admin updates someone to have a new partner or a new division they should
receive an email." Today the registration editor's Move / Assign partner / Remove partner
are silent. **New [FN] `notify-registration-change`** (this PR): body { registrationId,
change: moved | partner_assigned | partner_removed, fromEventId?, previousPartnerRegId?,
timeZone? }. Read-only — the editor does the change, then invokes this to email who's
affected: moved → the player (old → new division, start time if set, partner situation)
+ the partner they were split from (needs a new partner); partner_assigned → both players;
partner_removed → both. Players without email are reported as skipped, never an error.
Org-staff only. Harness (esbuild + stubbed client): all three changes render, recipients
right, 400 on unknown change, 404 on unknown reg. NEXT: UX PR — hook the three editor
actions (best-effort: change saves regardless; editor reports if an email didn't go out).

## 2026-09-11 — PROD DATABASE BACKUP taken before any event merge (#773)

Ron: "make a backup of the database as it stands right now in case the merge goes
haywire." No DB access from the sandbox, so added `.github/workflows/db-backup.yml`
(workflow_dispatch: target test|prod, retention days) — Supabase CLI `db dump` ×3 (roles,
schema, data as COPY) with the same secrets migrations.yml uses, gzipped into one artifact.
GitHub only registers workflows from the default branch, so it merged to main first
(#773), then ran against PROD: **run 34559402145, artifact `db-backup-PROD-20260911-034148Z`**
(data.sql 773 KB, schema.sql 225 KB, roles.sql; 200 KB gzipped; expires 2026-10-11).
Restore notes are in the workflow header — load data.sql with
`session_replication_role = replica` because event_registrations self-references for
partners. Also noted: a concurrent session shipped #758/#761/#766 (waitlist pay-to-claim)
during this one; #766 carried the merge_events migration to PROD, so #769 only shipped the
page. Merge events (#767/#768) + waitlist view (#757/#759) + briefing (#752/#753) are all
live on PROD.

## 2026-09-11 — Merge events UX: `/admin/:org/tournaments/:slug/events/merge` (+ "Merge" link)

[DB] #767 merged → TEST migrate run green (`merge_events` + `merge_events_preview` live on
TEST). Verified the SQL on a **local Postgres 16** with all 91 migrations applied (auth/
storage schemas stubbed) — every rule exercised: staff preview OK / staff merge forbidden,
format_mismatch, real merge (pairs intact, waitlist appended, duplicate waitlist cancelled,
invite + courts handled, rename, source soft-deleted), player_conflict named,
bracket_already_drawn, same_event, anon forbidden. This UX PR adds
`pages/admin/MergeEventsPage.tsx`: pick "Merge away" + "Keep" (targets of another format
disabled), preview cards (registered / waitlisted / cap / drawn), blockers panel (format,
drawn bracket, players in both → link to Attendees), warnings for fee / gender differences
(fees are NOT re-priced — same rule as moving one registration), "Name of the kept event"
prefilled with the target's name, ConfirmModal, success panel with links. RPCs called via
the untyped client (types not regenerated). Route + a "Merge" link beside "Edit all" on
TournamentDetailPage when ≥2 events. VERIFIED at 390px under Playwright (stubbed RPCs):
selection → preview → rename → confirm → result, and the conflict path disables the button.
typecheck/lint/build green. Not run against TEST data — Ron: try it on two throwaway events.

## 2026-09-11 — Waitlist view PROMOTED → PROD (#760); BUILDING merge events — [DB] first

#757 + #759 promoted via #760 (merge `f725b54`), PROD edge-functions green.
Ron: "merge two events — move all teams into the same event — and rename it."
**[DB] `20260911040000_merge_events.sql`** (this PR, schema first per MIGRATIONS.md):
`merge_events_preview(src, tgt)` (org staff; counts, format/gender/fee match flags, players
ACTIVE in both = blockers) and `merge_events(src, tgt, new_name)` (org admin; one
transaction: locks both events, refuses same/different-tournament/format-mismatch/any
matches/player conflicts; cancels source waitlist rows for players already live in the
target; appends the rest of the source queue after the target's; moves every non-deleted
source reg as-is so pairs + payment records stay intact; partner invites follow; source
event_courts dropped; optional rename; source soft-deleted; returns counts). Both
SECURITY DEFINER with has_org_role checks, granted to authenticated. Could not run SQL
locally (no Postgres in the sandbox) — the migrate workflow on merge is the first real run.
NEXT: UX PR — `/events/merge?source=` page (pick keep/merge-away, preview, blockers,
rename, ConfirmModal → rpc via the untyped client since types aren't regenerated).

## 2026-09-11 — Waitlist view UX: `/admin/:org/tournaments/:slug/waitlist` (+ Waitlisted stat)

[FN] offer-waitlist-spot merged (#757). This UX PR adds `pages/admin/TournamentWaitlistPage.tsx`:
one section per event — capacity ("8 of 8 teams · full", doubles = ceil(active/2)) and the
queue in order (offered spots ★ first, then #position), each row: name, email · phone, joined
date, "needs a partner", status pill (Waiting / Spot offered · unpaid), **Offer spot** /
**Resend offer** (invokes offer-waitlist-spot → success notice names the emailed address, or
says no email went out), **Remove** (ConfirmModal → status cancelled). **+ Add player** per
event: PlayerPicker (existing, or new via createOrgContact so they also land on the contact
list) → inserts a `waitlisted` reg at max position + 1, blocked if already registered/
waitlisted. Search box filters rows. TournamentDetailPage gains a **Waitlisted** stat tile
(distinct waitlisted players, from the same regs fetch — `status` added to its select) linking
here. VERIFIED at 390px under Playwright (stubbed Supabase): no overflow, long names/emails
wrap, offer → notice, add panel, remove modal. typecheck/build green; the page lints clean.
NOT exercised against a live DB/Resend — Ron: try Offer spot on TEST with a test player.
Answering "is Tawnya on the waitlist?" is now the Waitlist page + search.

## 2026-09-11 — Player briefing PROMOTED → PROD (#754); waitlist view [FN] next

#752 (function) + #753 (page) promoted via #754 (merge `7b42aad`); PROD edge-functions run
green. Ron: Schedule page → set start times → Player briefing → "Send me a test" → send.
**Finding while scoping the waitlist view:** nothing ever emails a player promoted off the
waitlist — `promote_from_waitlist` (called by `withdraw_self`) flips status to
`waitlisted_pending_payment` and the only signal is a "pay to claim" line on the public
page if they visit. **New [FN] `offer-waitlist-spot`**: organizer offers a spot to a
waitlisted reg (flip + email with a "Claim my spot" CTA to the tournament page), and
re-sends the email for an already-offered unpaid reg. Org-staff only. Ships first; the
Waitlist page (per-event queue, add player, offer spot, remove) is the UX PR after it.

## 2026-09-11 — Player briefing UX: `/admin/:org/tournaments/:slug/briefing` (+ link on detail page)

[FN] #752 merged → TEST (edge-functions run green). This UX PR adds
`pages/admin/TournamentBriefingPage.tsx`: "Who gets it" (recipient count, registrants
without email, events missing a start time → link to Schedule), settings (subject, waiver
link, arrive-early / first-game / per-match warm-up minutes, organizer notes, reply-to),
a live debounced preview (sandboxed iframe of the function's `preview` render, named for
the sample player), "Send me a test" (function `test` mode → organizer's inbox), and
"Send to N players" behind a consent checkbox + ConfirmModal (the modal repeats how many
events still lack a start time). Success panel links to Email → History. Route in App.tsx;
"Player briefing" link beside Schedule on TournamentDetailPage. Time zone = the
organizer's browser zone, named on the page and in the email.
VERIFIED at 390px under Playwright against a stubbed Supabase (auth session in
localStorage + route intercepts): no horizontal overflow, preview renders, test-send and
confirm flow work. typecheck/lint/build green, 32 tests pass. NOT exercised against Resend
— Ron: open the page on TEST, hit "Send me a test", check the inbox, then send for real on
PROD once promoted. Waitlist view is next.

## 2026-09-11 — BUILDING: player briefing email (start times + know-before-you-go) — [FN] first

Ron: set start times per bracket and email every attendee their start times plus
instructions (waiver, arrive 30 min early, 10-min first-game / 3-min match warm-ups, bring
water). **Start times already exist**: `events.scheduled_start_at`, set per event on the
tournament's **Schedule** page (datetime per row, auto-build, clear) — no migration needed.
**New edge function `send-tournament-briefing`** (this [FN] PR, ships before the UX per
FUNCTIONS.md): one email per registered player of ONE tournament listing *their* events
with day + start time (or "to be announced"), partner name, waitlist position, pending-
payment nudge; "be checked in by {first start − 30 min}"; waiver (link if given, else at
check-in); check-in; warm-up rules; stay near your court; what to bring; organizer notes;
Google Maps link; CTA to the public page. Modes: `preview` (returns HTML for the first
player), `test` (sends the sample to the signed-in organizer), `send` (Resend batch, logged
to contact_broadcasts/recipients so it shows on Email → History). Service email: goes to
every active registrant incl. waitlisted and unsubscribed, no unsubscribe link. Times are
formatted in the IANA zone the caller passes (no tz on record) and the email names it.
Verified with a Node harness (esbuild bundle + stubbed supabase client): 15/15 content
checks, 400 without consent, tz fallback, 404 unknown tournament; screenshot at 390px.
NEXT: UX PR — `/admin/:org/tournaments/:slug/briefing` page (preview iframe, test-send,
send with ConfirmModal, "events missing a start time" warning) + link on the detail page.
Then the waitlist view (issue to file).

## 2026-09-11 — HOTFIX 2: closed-registration tournaments vanished from the homepage

Ron: "The tournament should still show even if registration is closed." The homepage grid
(`pages/public/HomePage.tsx`) listed only `status = 'published'`, so the moment a
tournament was set to Closed it dropped off bertanderne.com — while its own page, the
contact page and RLS all already allow `closed`. Now lists `published` + `closed` (still
not ended, not draft/cancelled/completed), and the card pill uses the shared
`deriveRegistrationStatus` rule (same as the tournament page) instead of the active tier
label — so a closed one reads "Registration Closed" (muted), a not-yet-open one
"Registration Opens Soon", and open ones name their phase. Side effect worth knowing: a
*published* tournament past its `registration_closes_at` used to show "Registration open"
on the card; it now correctly says closed. `pricing_pattern` added to the select so the
phase label resolves. typecheck/build green, 32 tests pass; the 2 HomePage lint errors are
the pre-existing `{false && (` blocks. Not browser-checked at 390px (no DB from the
sandbox) — pill text/colour only, layout untouched. Merged + promoted per Ron's ASAP.

## 2026-09-11 — HOTFIX: Email recipients list short (PB Angels saw 40) — fixed, promoting to PROD

Ron: "email RECIPIENTS for the 5th annual pb angels only shows 40 people." Couldn't
query PROD from the sandbox (no DB access), so diagnosed from code. The org contact
list's registrant side (`lib/orgContacts.fetchRegistrantPlayerIds` + the same builder in
`send-contact-broadcast`) had four ways to come up short, all fixed in one change:
- **Silent failure.** The tournaments/events/registrations queries ignored `error`; any
  failure returned `[]`, so every registrant vanished and only imported/manual contacts
  remained (the 40).
- **Every event id in the request URL.** `.in("event_id", [...all org events])` — a big
  tournament's event list can blow the URL limit (→ the silent failure above). Now one
  org-scoped query through `events!inner(tournament_id)` — the Attendees page's shape,
  which works on the same data.
- **Waitlisted excluded.** Only paid/pending_payment counted. Now anyone whose
  registration isn't over (cancelled/refunded/withdrawn) — matches the roster export.
- **1000-row cap.** Every list query now pages with `.range()`; the edge function also
  chunks the `players` lookup (300 ids).
Compose tab now shows "Not included: N with no email address, M unsubscribed" so a short
list is explainable. Client + edge function kept in lockstep. typecheck/lint/build green,
32 tests pass. Ron asked for merge + PROD promotion ASAP → merged to main, promoted via
main→production PR (main == production before this, so the promotion is only this fix).
**Verify on PROD:** /admin/pickleball-angels/email → recipient count should match the
tournament's attendee list (minus no-email/unsubscribed, now itemized under the count).

## 2026-09-08 — Nightly regression GREEN again; merged + promoted (#728/#729/#730)

Merged #729 → main (squash `3675099`), promoted via #730 (merge `bac05c0`). **main == production
(delta 0).** #728 closed + Done.

**The promotion shipped NO app change** — `git diff origin/production origin/main` was empty for
both `web/src/` and `supabase/`. The only code was under `web/e2e/`, which never reaches a
browser. Pure branch hygiene.

**Nightly, measured across three runs of identical code:**

| run | result |
|---|---|
| before fix (main) | 11 failed / 41 passed / 9.7m |
| fix branch `34294105851` | 58 passed / 0 failed / 2.4m |
| after merge, main `34295453308` | 57 passed / **1 failed** / 3.4m |
| re-run, main `34295941478` | **58 passed / 0 failed / 2.5m** |

**The tab-locator regression is fully fixed** (11 → 0). The single failure in the middle run
was something else, and is now **#731**.

### #731 — the flake that was hiding behind the tab break

`registration › register for a singles event` intermittently fails at the Save button. Playwright's
error-context showed the page was **`/profile`** — `RequireProfile` had ejected the user — while
the profile was **complete** (Sid / Singles / e2e-sid@wmpc.test all present). That is exactly the
auth-transition race `RequireProfile.tsx` documents in its own comment and that **#546** closed:
the profile probe can run before the session token attaches and return **zero rows via RLS with no
error**. The 6-attempt retry narrowed the window without closing it. Filed **#731**, cross-linked
from #546, on the board.

**Why it deserves attention:** it is the worst-shaped failure — it names an unrelated feature
("register for a singles event"), so triage starts by investigating registration code that is
working fine. It only surfaced now because the tab break was failing that spec *earlier* in the
flow.

**LESSON (unchanged, still the takeaway):** `web/e2e/` is not covered by a `web/src` grep. When
changing user-visible copy, grep the E2E suite too — or anchor shared navigation helpers on stable
ids and assert copy once, on purpose.

🔜 NEXT
- **#731** — close the RequireProfile race properly; it's the top remaining red-nightly source.
- Unchanged, still unproven in prod: click an event badge on Attendees; press **Download list**
  once; **exercise comp + offline payment**; regenerate `web/src/types/supabase.ts`; repoint
  `web/.env` away from PROD.

## 2026-09-08 — (superseded — merged + promoted, see the entry above) nightly regression triage

**Green, awaiting your merge.** Branch `fix/e2e-tab-locator-regression` (`33510fd`).
**Test-only — no production code touched, so there is nothing to promote.** Merging to
`main` is what turns the nightly (and its twice-daily Discord alert) green.

**Cause — self-inflicted, from #725 in this same session.** Renaming the public tab
"Register" → "Events" broke `gotoRegister()` in `web/e2e/fixtures.ts`, which reached event
cards via `getByRole("tab", { name: /register/i })`. **11 specs** across
`registration.spec.ts`, `issue-09-confirm-cancel.spec.ts` and `mobile/audit.spec.ts` all
died on that one line. Each burned the 20s `actionTimeout` — that's the run-time blowout.

| | |
|---|---|
| Last green | 2026-09-04 19:36 (3m58s) |
| #726 merged | 2026-09-05 00:00 |
| First red | 2026-09-05 12:40 → every run since, ~11m |

**The expensive part was the misdirection**: failures were named "register with an existing
partner", "mobile audit — Register CTA usable" etc. Nothing had regressed; the app was fine.
The suite pointed at registration and mobile layout when the change was one word of copy.

**Fix:** `gotoRegister()` now targets `#tournament-tab-register` — SectionTabs'
`idPrefix` + `key`, the same hook the tab's `aria-controls` already uses. The key stayed
`register` through the rename; only the label moved. Because an id-anchored locator would
*hide* a copy regression, the wording is now asserted **deliberately in one place**
(`discovery.spec.ts`), plus a test that the tab actually reveals its panel. A future rename
fails **there, once**, in a test that is about the copy.

**Verified with the REAL suite**, not a local approximation: `gh workflow run regression.yml
--ref <branch>` (run 34294105851, same secrets + deployed target as the nightly) →
**58 passed / 4 skipped / 0 failed in 2.4m**, vs 11 failed / 41 passed / 9.7m on main.

**LESSON — worth remembering.** `web/e2e/` is not covered by a `web/src` grep. When changing
user-visible copy that tests might locate by, grep **`web/e2e/` too**. Better: reach for a
stable id in shared navigation helpers and assert copy once, on purpose.

🔜 NEXT
- Merge #729 to stop the nightly alerting. No promotion needed.
- Unchanged and still unproven in prod: click an event badge on Attendees; press
  **Download list** once; **exercise comp + offline payment**; regenerate
  `web/src/types/supabase.ts`; repoint `web/.env` away from PROD.

## 2026-08-28 — PROMOTED TEST → PROD: move a registration between events, one-click manage, "Events" tab

Live on bertanderne.com. Merged → main (squash `33630ed`, PR **#726**), promoted via
**#727** (merge `463b389`). Stories **#724** + **#725** closed. Frontend only — no
migration, no edge function, no new dependency.

Verified in the **deployed PROD bundle** (`index-BaEteFk1.js`): "Move to another event",
"Move to this event", "click an event to manage that entry", "a team can't span two
events", "Moving them anyway is your call" all present; `label:"Events"` present and
`label:"Register"` **gone**. Tabs confirmed rendering **Details | EVENTS** (court red) at
390px on both test.bertanderne.com and bertanderne.com.

⚠️ **This one writes to the DB**, unlike the last two promotions. `moveRegistrationToEvent`
updates `event_id` / `partner_status` / `partner_registration_id` on `event_registrations`
and unpairs a partner first. Ordinary org-staff RLS write, no new privileges; the
active-unique index is the backstop. **A move already made can't be rolled back by a Pages
rollback** — reverse it by moving the player back.

⚠️ **Badge → editor click path still unproven.** Typechecked and in the live bundle, but the
attendees page needs an org login (this machine's `web/.env` points at PROD), so the first
real click will be a user's.

Design decisions behind the move are in the superseded entry below — **read them before
changing it**, especially "money is NOT re-priced" and "full/ineligible are flagged, not
hidden".

🔜 NEXT — the pile of unproven-in-prod items is growing; worth one pass through the admin UI:
- Click an event badge on the Attendees page (this change).
- Press **Download list** once on a real tournament.
- **Exercise comp + offline payment** — still unproven since the 2026-08-24 promotion.
- Regenerate `web/src/types/supabase.ts`; repoint `web/.env` away from PROD.

## 2026-08-28 — (superseded — promoted, see the entry above) move a registration between events + one-click manage

**Green, awaiting your merge.** Branch `feat/move-registration-between-events`.

Ron: managing a registration "brings me to the player profile and then I have to manage the
registration… it doesn't allow me to move them to another event", plus rename the red
Register tab.

**Reachability (#724a):** from **By Player**, *Manage* navigated to the player profile just
to reach the editor **By Event** already opens inline. Each **event badge on a player's row
is now a button** opening that registration's editor directly; the subtitle says so, since
nobody discovers a clickable badge by accident. *Manage* still goes to the profile (right
place for the whole person). No extra query — partner names resolve from the tournament-wide
fetch the page already does.

**Move to another event (#724b)** — new editor section. Previously this meant withdraw +
re-register, throwing away the payment record. Now the same row is kept and only `event_id`
changes. New helpers in `lib/registrations.ts`: `fetchMoveTargets`, `moveRegistrationToEvent`.

Decisions baked in — **read these before changing it**:
- **Money is NOT re-priced.** Re-stamping the target's fee onto a paid reg would silently
  create an over/under-payment. The fee travels with the row; any difference is surfaced with
  a pointer to Payment / Issue refund (both already in the modal).
- **Full + ineligible events are shown and FLAGGED, not hidden** — organizers override both
  routinely, and hiding an expected option reads as a bug. Only an event where they already
  hold an *active* reg is disabled (the active-unique index would reject it anyway).
- **A confirmed partner is unpaired first and named** — a team can't span two events; the
  partner returns to `seeking` in the original event rather than being dragged along.
- **Targets derive from the reg's own `eventId`**, so the section works identically from all
  three hosts (AttendeesPage / PlayerRegistrationsModal / PlayerDetailPage) with no
  tournament id plumbed through.

**Tab rename (#725):** public tabs now read **Details | Events** (was "Register"). Chose
*Events* over *Brackets* to match the domain model + `events` table; still the court-red CTA
while inactive. One-word change if Ron prefers Brackets.

**Verified at 390px against LIVE data** (real event + real player, so `fetchMoveTargets`
actually ran): 5 sibling events listed with the current one excluded; "Mixed 2.75 - 3.25 —
full" flagged from the real `is_event_full` RPC; eligibility warning fired correctly
("women's event") from real `checkEligibility`; fee-delta and partner warnings correct.
19 tests pass; typecheck + build green; lint unchanged at 27 pre-existing errors.
**No migration, no edge function, no new dependency.**

⚠️ **Not verified:** the badge → editor *click path* (attendees page needs an org login and
this machine's `web/.env` points at PROD). Typechecked only — click it on the PR preview.

🔜 NEXT
- Merge #726 → TEST, click a badge, then promote.
- Still outstanding: **exercise comp + offline payment in prod**; press **Download list**
  once on a real tournament; regenerate `web/src/types/supabase.ts`; repoint `web/.env`
  away from PROD.

## 2026-08-27 — STATUS.md cleaned up + docs promoted; TEST == PROD in sync

Ron: "clean up status -- merge and promote." Archived the 190 pre-2026-08-15 entries to
[`STATUS-ARCHIVE.md`](./STATUS-ARCHIVE.md) (STATUS.md 4,201 → ~540 lines; nothing lost) and
fixed the duplicate attendee-download header. Merged to TEST (#722) + promoted main →
production (#723); both admin-merged past the issue-ref `check` gate (docs chore, not a
feature). **production is now level with main (delta 0).** Docs-only — no code/schema/deploy.

Still pending (interactive, not yet built): the **in-app signature feature** — an admin
signature pad → stored in the DB → auto-rendered in `quotes/ContractPage`'s signer block on
every generated contract. Ron drew a signature this session but the raw image can't be held
reliably in text, so one-off contracts were handled as sign-in-page artifacts instead; the
app feature is the durable "store once, auto-apply" answer. NEXT if resumed: migration for a
platform/WMPC contract signature + a settings-page pad + ContractPage render.

## 2026-08-27 — PROMOTED TEST → PROD: download / print the attendee list (#719/#720/#721)

Live on bertanderne.com. Merged `feat/attendee-roster-download` → main (squash `e2ecfe4`,
PR **#720**), promoted main → production via **#721** (merge `16ae8a1`). Story **#719**
closed. Frontend only — **no migration, no edge function, no schema change, no new
dependency**; nothing in this promotion writes to the database.

Verified in the **deployed bundles**, not just locally: the roster strings
("Download the attendee list", "Still needs a partner", "Waiting to hear back",
"Needs a partner in", `roster-document`) are present in both the TEST bundle
(`index-C6S3dhKv.js`) and the PROD bundle (`index-D12XsVgK.js`). 19 tests pass;
typecheck + build green; lint unchanged at the 27 pre-existing errors.

Design notes and the judgment calls behind it are in the design-notes entry below —
worth keeping, especially the **print-isolation difference** (body portal + `display`
rather than `quotes/ContractPage`'s `visibility` trick, which prints blank pages ahead
of anything longer than one page). Copy that approach for the next long printable.

⚠️ **First real click will be a user's.** The modal was driven in a browser harness and
the strings are confirmed in the live bundle, but the button on the attendees page was
never click-tested in a logged-in session (it needs an org login, and this machine's
`web/.env` points at PROD). Open a tournament's Attendees page and press **Download
list** once to confirm the wiring.

🔜 NEXT — unchanged, all still outstanding:
- Press **Download list** once on a real tournament (above).
- **Exercise comp + offline payment in prod** — both money paths from the earlier
  promotion remain unproven there.
- Regenerate `web/src/types/supabase.ts`; drop the untyped-client shim in `lib/adminRegister.ts`.
- Repoint `web/.env` away from PROD.

## 2026-08-27 — Design notes + judgment calls: attendee list download / print (shipped, #719/#720)

**Green and awaiting your merge** — I stopped at the PR rather than merging, since
merging `In Review` is your gate. Branch `feat/attendee-roster-download` (`51b0282`).

Ron's ask: a download for attendees "so people who are technologically illiterate can
see who has signed up (with contact info) and who is waiting for a partner and who is
asking to be paired with a partner."

**Read of the ask that drove the design:** the people who most need this are the least
likely to want to work from a laptop, so **paper is the primary output**, not a file.
One **Download list** button in the attendees header opens the finished document *on
screen first* — what you see is exactly what prints — then offers Print / Save as PDF
first and a spreadsheet second.

Three sections, matching the three questions asked at the desk:
- **Still needs a partner** — `partner_status='seeking'` (doubles, nobody lined up).
- **Waiting to hear back** — `partner_status='pending'`, and the invitee is **named**,
  joined from `partner_invites` via `fetchPendingPartnerInvites`.
- **Everyone signed up** — alphabetical, contact details, team-mates, payment state.

New files: `web/src/lib/rosterExport.ts` (pure grouping + CSV, no React),
`web/src/lib/rosterExport.test.ts`, `web/src/components/RosterExportModal.tsx`.

**Decisions worth knowing:**
- Cancelled / refunded / withdrawn are **dropped** from the export (they aren't coming),
  mirroring `INACTIVE_STATUSES`. The page itself still shows them — only the export filters.
- Payment wording is plain English ("Not paid yet"), never enum names — volunteers read this.
- CSV is **one row per person** (a contact list first); its first six headers match
  `lib/parseContactsFile` so it re-imports through **Import contacts** with no remapping.
- CSV is RFC 4180 quoted, leading `=/+/-/@` neutralised against Excel formula injection,
  UTF-8 BOM for accented names (verified on the real blob: `EF BB BF`).
- **Print isolation deliberately differs from `quotes/ContractPage`.** That page hides
  siblings with `visibility`, which leaves them occupying space — fine for a one-page
  contract, but it prints **blank pages ahead of** a multi-page roster. This modal
  portals to `<body>` and hides siblings with `display` instead. Worth copying that
  approach if we ever print another long list.

**Verified:** 19 tests pass (13 new); rendered at 390px and letter width; print layout
confirmed starting at y=0 with no leading blank space; download exercised end to end
(real blob, correct filename, rows, columns). typecheck + build green, lint unchanged at
the 27 pre-existing errors. No schema change, no edge function, no new dependency.

⚠️ **Not click-tested on the real page.** Only the modal was driven in a browser harness —
the attendees page needs an org login and this machine's `web/.env` points at PROD. The
button wiring (header placement, passing `eventGroups`) is typechecked but unproven.
**Check it on the PR preview**, which has its own env-var scope.

🔜 NEXT
- You merge #720 → TEST, try the button on the real page, then say the word to promote.
- Still outstanding from before: **exercise comp + offline payment in prod** (both money
  paths remain unproven there); regenerate `web/src/types/supabase.ts`; repoint
  `web/.env` away from PROD.

## 2026-08-24 — HOTFIX promoted: tab switching no longer strands the reader (#716/#717/#718)

Ron: "Clicking Register sends the user to the middle of the page." Fixed, merged,
promoted, verified live — all within the session.

- **Cause:** switching tabs swaps the whole panel below the control, but the browser
  keeps the scroll offset. Scroll down through Details, tap Register, and you stay at
  that pixel depth — partway into the events list with the tab bar off-screen above.
- **Fix** (`SectionTabs`): re-anchor to the control on switch. Only ever scrolls **up**,
  so tapping from the top doesn't yank the reader down. Jumps rather than smooth-scrolls
  (distance can be most of the page; also sidesteps `prefers-reduced-motion`). Lives in a
  shared `select()` so **click and keyboard** both get it, while *programmatic* `setTab`
  (the reset on tournament change) deliberately does not scroll.
- Story **#716** → PR **#717** (squash `c0274f6` on main) → promotion **#718**
  (merge `c3a18f1`). Frontend only — no migration, no edge function, no schema.

**Verified on live bertanderne.com at 390px** (not just locally):

| case | result |
|---|---|
| scrolled down (1308), tab bar 578px off-screen, tap Register | scrolled to 718, tab bar 12px from top, fully visible |
| at top of page, tap Register | stayed at 0 — no scroll |

🔜 NEXT — unchanged from the entry below, and all still outstanding:
- Ron: exercise comp + offline payment once in prod (**both money paths remain unproven
  in production**).
- Regenerate `web/src/types/supabase.ts`; drop the untyped-client shim in `lib/adminRegister.ts`.
- Repoint `web/.env` away from PROD (it currently points at the live project).

## 2026-08-24 — PROMOTED TEST → PROD (#712 · #715). Live on bertanderne.com

Shipped and verified in production. Payment editor + segmented tabs merged to `main`
(#712, squash `34eda10`), promoted `main`→`production` via **#715** (merge `f424905`).

- Stories **#713** (change the price on a registration) and **#714** (Details/Register
  prominence) created, added to the WMPC Roadmap board, closed by the PR, set to **Done**.
- New edge function **`admin-set-registration-payment`** deployed to TEST **and PROD**.
  Smoke-verified on both: `401` unauthenticated, `405` on GET, `200` CORS preflight.
- Migration **`20260815170000_reg_refunded_cents.sql`** applied to PROD by the `migrate`
  job (it rode along — it was queued in `main`, not part of this feature). Confirmed:
  `select refunded_cents` returns 200 on the prod project.
- Promotion also carried **organizer-initiated refunds (#704/#707/#709)**, which had been
  sitting in `main` unpromoted. Ron chose "promote everything" knowing that.
- Segmented tabs confirmed live at 390px on both test.bertanderne.com and bertanderne.com
  with the right tokens (ink `#14181f` active / court-red `#d8341c` CTA) and aria wiring.

⚠️ **STILL UNEXERCISED IN PROD:** neither money path — organizer refunds nor
comp/offline payment recording — has been run end to end by a signed-in organizer against
a real registration. Structure is verified (deploy, auth guard, render); the actual write
is not. **Ron agreed to be the first to record a comp/offline payment on a registration he
controls and watch it.** Until that happens, treat both as unproven in prod.

⚠️ **`web/.env` POINTS AT PRODUCTION.** The local dev env var is
`wducsjqyoksmluwfgjxc.supabase.co` — the **PROD** project (TEST is `mvkhdsauaqqjehxdnbuf`).
So `npm run dev` locally reads and writes the **live** database; browsing localhost showed
real Pickleball Angels data (47 players). This is now materially riskier, since the feature
just shipped writes payment records. **Worth fixing:** point `web/.env` (or `.env.local`)
at the TEST project. Not touched this session — it's Ron's file and pre-existing.

Also of note: `gh pr create` hit the **GraphQL rate limit** (5000/hr exhausted) mid-session
while REST was untouched — PRs were created via `gh api ... /pulls` instead. Useful fallback.

🔜 NEXT
- Ron: exercise comp + offline payment once in prod; confirm the reg flips to Paid and the
  read-only "how they paid" line renders.
- Regenerate `web/src/types/supabase.ts` (still stale — `manual_payments`,
  `admin_invoiced_at`, `refunded_cents`, `organization_contacts`, `tournament_setups`),
  then drop the untyped-client shim in `lib/adminRegister.ts`.
- Repoint `web/.env` away from PROD.
- Optional follow-up story: `price_override_cents` + teach `compute_checkout_total` to
  honour it, which is what real post-hoc re-pricing (and correcting a manual payment) needs.

## 2026-08-24 (later) — Tab variant CHOSEN + shipped: segmented control, Register as CTA

Ron picked **variant 2** (segmented + red Register). Implemented for real; mockup
scaffolding deleted.

- New `web/src/components/SectionTabs.tsx` — generic segmented-control tab bar built
  from publicTheme tokens. `ctaKey` prop = the tab that stays **court-red while
  inactive** and drops to the normal ink fill once active (so red is left only on the
  per-event Register buttons — verified no colour competition).
- Accessibility, per shadcn/Radix horizontal-tabs model (the old tabs had **none** of
  this): roving tabindex, ArrowLeft/Right move *and* activate, Home/End to the ends,
  and real `aria-controls` ↔ `aria-labelledby` wiring. The two panels in
  `PublicTournamentPage.tsx` were fragments (`<>`); they're now
  `<div role="tabpanel" id="tournament-panel-…">`.
- Desktop width capped at **440px** (uncapped it stretched to ~1016px at 1280 and read
  as slack). Cap is below mobile width so no media query is needed.
- Verified in a real preview: 390px + 1280px, keyboard nav confirmed (ArrowRight moved
  focus → activated Register → swapped panel). typecheck + build green; repo lint still
  **27 errors, all pre-existing** (identical to baseline).
- Deleted `web/src/components/__TabsMockup.tsx`; restored a clean `PublicTournamentPage`
  (net −52 lines there). No mockup/preview scaffolding left in the tree (grep-verified).

**Supersedes the "Ron to pick a tab variant" NEXT in the entry below.** Everything else
in that entry still stands — still on `feat/registration-payment-editor`, still
**uncommitted**.

🔜 NEXT — commit + PR the branch (payment editor + tabs); regenerate the stale
`web/src/types/supabase.ts`.

## 2026-08-24 — Registration price editing (built, uncommitted) + Details/Register tab mockup

Branch **`feat/registration-payment-editor`** — NOT committed, NOT pushed. Two threads:

**1. Change the price on a registered player** (Ron's ask: expose the admin-register
settings in the Manage Registration modal). Scope decided by Ron via AskUserQuestion:
**no-migration subset** + **paid regs read-only**.
- New **Payment** section at the top of `web/src/components/RegistrationEditorModal.tsx`.
  Unpaid reg → radio: *Record offline payment* (amount + cash/check/venmo/other + note)
  or *Comp* ($0). Both mark paid, both confirm first. Paid reg → read-only summary of
  HOW they paid (reads `manual_payments`), pointing at Issue refund.
- New edge function `supabase/functions/admin-set-registration-payment/index.ts` —
  org-staff only, authorizes against the reg's OWN org, refuses already-paid rows,
  optimistic status guard against double-recording. Writes `manual_payments`
  (server-only table, no client write policy).
- `web/src/lib/adminRegister.ts` — added `settleRegistrationPayment` /
  `fetchManualPayments` (+ error-code → copy map). `manual_payments` isn't in the
  generated types yet, so that read uses the untyped-client pattern from `lib/orgContacts`.
- Partner: "Signed up with:" line now always renders in the Partner section (name when
  paired; "nobody yet — they're looking for a partner" / "an invite is out" when not).
  Ron OK'd keeping it lower in the modal rather than in the header.
- Verified: typecheck + build green, 0 new lint errors (repo's 27 are pre-existing —
  confirmed identical with changes stashed), rendered at **390px** in a real preview.

**KEY FINDING — `event_registrations.event_fee_cents` is a SNAPSHOT, not the price.**
`compute_checkout_total` (`20260815130000_pricing_events_included.sql`) prices from
`events.event_fee_cents` + the tournament pricing tier and NEVER reads the registration's
own fee. So editing that column would silently not change what a player is charged. This
is why post-hoc "invoice at $X" is out of scope — it needs a real
`price_override_cents` column + a change to that function.

**KNOWN GAP (accepted, flagged to Ron):** a *manually* paid reg (comp/offline) can't be
corrected — Issue refund can't help it either, since there's no Stripe charge behind cash.
Correction = withdraw + re-register. The UI copy says so explicitly.

**2. Details/Register tabs "not prominent enough"** — mockup only, live on the real page
(`/t/pickleball-angels/seacoast`, dev server on **:5199** — 5173 was occupied by another
project). Temporary scaffolding: `web/src/components/__TabsMockup.tsx` + a swapped-out
tablist block in `PublicTournamentPage.tsx`. Four switchable variants: 0 Current,
1 Segmented, 2 Segmented + red Register (**my recommendation**), 3 Tabs + full-width CTA.

🔜 NEXT
- **Ron to pick a tab variant.** Then implement it properly (add roving-tabindex keyboard
  nav per Radix — today's tabs have none), cap the segmented control ~420px on desktop
  (it stretches to ~1016px at 1280), and **delete the `__TabsMockup.tsx` scaffolding +
  restore the real tablist block**. Do NOT commit the mockup.
- Commit + PR the payment work (branch already exists, nothing staged).
- Regenerate `web/src/types/supabase.ts` — it's stale (missing `manual_payments`,
  `admin_invoiced_at`, `refunded_cents`, `organization_contacts`, `tournament_setups`).
- Open question if the gap bites: add `event_registrations.price_override_cents` +
  teach `compute_checkout_total` to honour it, which unlocks real post-hoc re-pricing.

## 2026-08-21 — Signature for contracts: approach PIVOTED to in-document signing

Ron wants his signature created once, stored, auto-applied to contracts. Decisions
(AskUserQuestion): scope = **Both** (app ContractPage + one-off drafts); capture = draw on a pad.

**KEY LESSON / pivot:** I (Claude) canNOT reliably store/echo the signature PNG data URL —
it's ~7KB of base64 and I truncated it when re-typing into a file (decoded to a corrupt
1478-byte image). So "Claude holds the image and stamps it" does NOT work. **New approach:
bake signing into the document** — the signature goes hand→page, never through me as text.
- Delivered: NHBA contract as a self-signing **artifact** (built-in canvas pad → "Apply to
  contract" stamps the sig onto Ron's line + fills date → Print/Save PDF; sig cached in
  localStorage so same-browser contracts auto-sign). URL:
  https://claude.ai/code/artifact/97bf82f5-58e3-458f-ae2f-133bf89f4cee (open in Safari to print).
- Also published a standalone signature-pad artifact earlier (c86665c8-…) — now superseded by
  the in-contract pad.

NEXT — the durable **APP FEATURE** (still to build, real "always apply"): in-app signature pad
on an admin/settings page → store the signature PRIVATELY in the DB (admin-gated, NOT a
committed asset / public bundle) → ContractPage renders it in the "Ron West · WMPC" block
(fallback to blank line). PR to TEST as usual. This is the version that works cross-device +
for app-generated contracts, with no per-contract re-do. For future one-off email contracts:
generate them in-app once the feature lands, or keep shipping self-signing artifact pages.

Done this session (scratchpad, not in repo): built an interactive signature-pad HTML
(`scratchpad/signature-pad.html`) — canvas draw, auto-crop to ink bounds, exports a trimmed
transparent PNG data URL + copy button; sent to Ron to sign on his phone and paste the
`data:image/png;base64,…` back. Also drafted the NHBA contract (`scratchpad/nhba-contract.html`,
styled to match ContractPage — for Sandy Tracy / NH Bankers Assoc, Sep 15 2026, $650; later
edits: removed travel term, payment "15 days after event concludes", added no-rain-date clause).

NEXT (once Ron pastes the signature data URL): (1) store it in the **memory dir** (persists
across sessions) so one-off contracts I draft always get it; (2) stamp it on the NHBA contract
+ re-send; (3) **APP FEATURE** — render the stored signature in ContractPage's "Ron West · WMPC"
signature block (fallback to blank line), + a small admin control to set it. Storage decision:
keep it PRIVATE — DB (admin-gated), NOT a committed asset / public JS bundle (a signature is
sensitive). Build as a PR to TEST like usual. Open UX Q for the NHBA contract: 2:30 vs 2:00 start
(Sandy wants done by 5pm).

## 2026-08-17 — RESOLVED: www.pickleballangels.com fixed (redirect → apex, verified live)

Ron fixed it in Cloudflare (guided): proxied CNAME `www` → tournament-manager.pages.dev
+ a Redirect Rule `www.pickleballangels.com/*` → `https://pickleballangels.com/` (301,
static). **Verified live:** www now resolves (Cloudflare IPs), returns 301 → apex → 200
tournament page, valid TLS (Universal SSL `*.pickleballangels.com` now covers www). Both
apex and www work. Superseded the "Ron to fix" note below.

Still open (optional): the MISSPELLING `pickleballangles.com` (a-n-g-l-e-s) is a
third-party Squarespace domain Ron doesn't own → dead end if that spelling was distributed.
Offered to grep flyer/broadcast assets for the `angles` typo; not yet done.

## 2026-08-17 — Prod finding: www.pickleballangels.com dead (apex is fine) — Ron to fix DNS

Ron: "pickleballangels.com not working." Diagnosed (read-only, no repo change):
- **Apex `pickleballangels.com` is HEALTHY** — loads the 5th Annual Pickleball Angels
  tournament (registration open, 6 events, $75/2-events pricing, 41 players), no console/
  network errors. DNS on Cloudflare (darl/ingrid.ns.cloudflare.com), 200.
- **ROOT CAUSE: `www.pickleballangels.com` is unconfigured** — no DNS record ("could not
  resolve host"), TLS cert covers only the bare apex, and the `custom_domains` seed
  (20260622090000) maps only the apex. Anyone using the `www.` form gets "site can't be
  reached." **Fix (Ron, Cloudflare dashboard — I can't touch DNS):** add proxied CNAME
  `www`→`pickleballangels.com` + a Redirect Rule `www.../*` → `https://pickleballangels.com/$1`
  (301). No app/DB change needed with the redirect approach.
- **Secondary:** the misspelling **pickleball*angles*.com** (a-n-g-l-e-s) is a DIFFERENT,
  third-party Squarespace domain that redirects to pickleballindex.com — dead end if that
  spelling was ever distributed. OFFERED to grep flyer/broadcast assets for the `angles`
  misspelling + bare `www.` links; awaiting Ron's go-ahead. NEXT: Ron fixes www DNS; optional
  misspelling-audit sweep.

## 2026-08-15 — Regression triage + E2E coverage sweep (#708 → #709)

Ron: "why did regression fail today + sweep changes into E2E." **Failure diagnosis:**
today's two nightly runs (09:37, 17:35) both PASSED. The last red run was **2026-08-14
18:07** — flaky partner-picker timeouts in registration.spec.ts (1 fail + 2 flaky, 47
passed; all three ~20s `locator` timeouts) that cleared on the next two runs with no code
change. **Environmental (free-tier DB/app cold-start), not a code regression.**

**Coverage sweep (#709, merged):** added 2 deterministic specs for organizer-initiated
refund (#704) to manage-registration.spec.ts — (1) comp'd paid reg → "Issue refund" +
remove → withdrawn (no Stripe, since refund_compute returns $0 for a no-payment reg); (2)
Issue-refund absent on a pending reg. Seeded Rita (paid) + Gary (pending). **Validated via
a dispatched regression run on the branch: 52 passed, 0 flaky** (both new tests green).
Swept COVERAGE.md: refund → ✅ no-money slice; added ❌ rows w/ blockers for pricing
N-events (#697), date-only (#701), Setup (#691/#693/#695), opportunity/quote pipeline
(#684/#686).

**Still uncovered (tracked in COVERAGE.md):** the real money refund + all checkout/pricing
math (💳 gated on Stripe-test #255); the entire organizer/admin surface incl. date-only
create/edit + Setup admin (needs the first organizer-auth spec). Cheapest next non-Stripe
wins noted there: pricing "N included" in the register basket, and the customer /setup/:token
+ /q/:token token pages (seed a token like invite-accept).

## 2026-08-15 — Organizer-initiated refunds → TEST (#704: #706 DB + #707 edge/UI)

Ron: "We should be able to initiate the refund without the customer asking." Built the
admin refund path (today refunds only fired from a player's withdrawal request via
stripe-refund `resolve`). Ron's design calls (AskUserQuestion): **amount defaults to the
tournament's cancellation policy, overridable** (partial ok); **"let me choose each time"**
whether to also remove the player from the event.

- **DB (#706, applied to TEST):** `event_registrations.refunded_cents int not null default 0`
  — running total refunded so partial refunds cap correctly + a keep-registered partial stays
  consistent with a later withdrawal. Written only by the edge fn.
- **Edge fn (#707, deployed to TEST):** stripe-refund new **`admin_refund`** mode —
  admin-authorized (has_org_role) on a **paid** reg; default = refund_compute policy amount,
  override via amountCents, capped at net-paid − already-refunded; **removeFromEvent** (default
  true → withdraw+unpair → refunded/withdrawn; false → keep paid, refund tracked in
  refunded_cents). Idempotency keyed on reg + running total (repeat partials safe, double-submit
  no-ops). Also **clamped the existing self/resolve paths by refunded_cents** + keep the total
  accurate so a prior keep-registered refund can't be double-issued (Stripe is the hard backstop).
- **UI (#707):** RegistrationEditorModal (Attendees/Contacts/person page → Manage) gets an
  **"Issue refund"** section on paid regs — dry-run preview (policy default + max), amount input,
  remove checkbox, note, partner-unpair warning, ConfirmModal → execute. New client lib
  `web/src/lib/refunds.ts`. Withdraw copy updated (no longer "queue only").

typecheck+build+lint clean. **NOT verified live** — no web/.env.local + needs a real Stripe-test
paid registration. **Ron: verify on TEST** — on a paid reg: (1) full refund + remove, (2) partial
refund + keep registered, then confirm a 2nd refund caps at the remainder and a later withdrawal
doesn't double-refund. Then promote to PROD when satisfied. (Two other refund paths — the
player-facing self-withdraw and the request queue — were touched defensively; regression-worth a
glance too.)

## 2026-08-15 — PROMOTED TEST → PROD (#703): pricing-N, date-only, Setup, quote redesign, opportunities

Ron: "Push to production." Promoted `main` → `production` via PR #703 (`--merge --admin`;
the `check` issue-reference gate is a feature-PR guardrail that doesn't apply to promotions —
`unique-versions` migration gate PASSED). 29 commits.

**Migrations auto-applied to PROD** (workflow 31892377080, success 22s) — both additive,
backward-compatible, previously clean on TEST:
- `20260813120000_tournament_setups.sql` (#691) — new table + token RPCs.
- `20260815130000_pricing_events_included.sql` (#698) — `first_events_included` col (default
  1 = prior behavior) + `create or replace` on replace_pricing_tiers / compute_checkout_total.

No edge-function changes (that workflow correctly didn't run). Cloudflare auto-builds the
`production` branch for the frontend.

**Shipped to PROD:** pricing "entry fee includes first N events" (#697/#698/#699/#700) ·
date-only tournament start/end (#701/#702) · Setup flow end-to-end (#691/#693/#695) ·
quote-editor workflow redesign (#686/#689) · opportunities pipeline on Home (#684) · host
guide (#680) · E2E manage-reg fix (#682).

NEXT: eyeball on PROD once Cloudflare finishes — a tier with N>1 (public headline + checkout)
and a fresh tournament's date pickers (neither browser-verified locally this session, no
web/.env.local). TEST and PROD are now level.

## 2026-08-15 — Tournament dates = date-only (#701/#702) + pricing copy reflects N (#700)

Two small frontend-only changes, both merged to TEST:

**Date-only tournament start/end (#701 → #702).** Ron: "creating tournaments we don't
need start time — just start date and end date; events handle their own times." Switched
the create **wizard** (`TournamentWizardPage`) + edit **form** (`TournamentFormPage`) from
`datetime-local` → `type="date"`, relabeled "Start date"/"End date". Registration
opens/closes KEEP date+time (real deadlines). New helpers `dateToIso`/`isoToDate` in both
(store picked day as local-midnight ISO, read back same local day — no TZ drift); `toIso`/
`isoToLocal` stay for the reg-window fields. Wizard `fmtDay` pins date-only values to local.
No schema change (`starts_at`/`ends_at` already timestamptz; we just stop collecting time).

**Pricing copy reflects N (#700, follow-up to #699).** Ron flagged the public headline still
said "includes 1 event". Updated customer-facing labels (display only — charge math
untouched): PublicTournamentPage headline "includes N events" + per-event register cost line
is now 3-way (first=entry / included="$0 · included in your entry" / additional="+$Y"), driven
by active-reg-count vs N; CheckoutPage summary first→"registration" + new "included in
registration"; RegisterPage basket counts included ("N included") + shows "$0 (included in
entry)" per row instead of hiding it.

typecheck+build clean both; lint only the pre-existing set-state-in-effect errors (verified
unchanged on main). COULDN'T browser-verify locally (no web/.env.local → Supabase unreachable;
create form is auth-gated, pricing display is data-gated) — flagged in both PRs to eyeball on
the Cloudflare PR preview (own Supabase scope). NEXT: Ron confirms on TEST; the big TEST→prod
promotion batch (now includes pricing-N + date-only) still pending.

## 2026-08-15 — Pricing: entry fee includes first N events — SHIPPED to TEST (#697, both halves)

Ron: "select the number of events the entrance includes — currently defaults to 1."
Confirmed model: **entry fee covers the first N events** (top pick = `first`/entry;
picks 2..N = **`included` $0**; picks beyond N = additional-event fee). **N=1 = today's
behavior exactly → existing tournaments untouched.**

- **DB half (#698, merged, migration APPLIED to TEST):** `tournament_pricing_tiers.first_events_included`
  `int not null default 1 check (>=1)`; `replace_pricing_tiers` carries it; `compute_checkout_total`
  (authoritative Stripe charge) classifies `rn<=N` → `included`/$0.
- **Client half (#699, merged):** mirrored the exact math in `lib/pricing.ts` (new `included`
  tier, `i<included` 0-based == RPC `rn<=N` 1-based); carried the field through
  `pricingTiers.ts` (TierDraft/TierInsert/mappers/validate); added per-tier **"Events included
  in the entry fee"** input in `PricingTiersEditor` (label + preview math reflect N); wired the
  4 `computeLineItems` callers (checkout, register, org-contacts manual reg, pending-payments bar).
  `select("*")` fetches carry the column automatically; PendingPaymentsContext's explicit list got it.
  `first_events_included` is OPTIONAL on the local `PricingTier` extension (generated types lag) —
  every consumer falls back to 1.

Client preview and `compute_checkout_total` kept identical (they MUST match). typecheck+build clean;
lint has only the 3 pre-existing react-hooks/react-refresh errors (unchanged on main). NEXT: verify
on TEST with a >N-event registration once Ron sets N>1 on a tournament; the big TEST→prod promotion
batch is still pending.

## 2026-08-15 — Setup design decision: per-setup question SELECTION (like the quote picker)

Ron (reviewing the mockup via an interactive Artifact — he can't reach the PR preview
because the magic link redirects to TEST; note the /mockups routes are actually PUBLIC,
separate login issue): Setup should let us SELECT which questions get sent to each
organizer — "similar to how we build the quote" (check/uncheck from the catalog);
based on the contract, some questions may not apply. Updated the Artifact mockup
(https://claude.ai/code/artifact/d5cf216e-997f-4b1c-b5c0-131c91207ab5, re-published
same URL) to add a "Questions for this organizer" picker: grouped checklist of catalog
questions, pre-selected from the contract, uncheck to drop, live count → Send.

REAL-BUILD MODEL (locked concept): a master **setup_questions** catalog (like
service_catalog; establish+grow) + per-setup a **selected subset** (a selection join,
like quote line items pick from the catalog) → drives a DYNAMIC customer /setup form
showing only the selected questions. Supersedes the hardcoded intake (3c). NOTE: the
in-repo React mockup (#696 /mockups/setup) does NOT yet have the picker — only the
Artifact does; sync it when building for real. NEXT: Ron finalizes the mockup → build:
setup_questions catalog + admin manager + per-setup selection UI on the Setup surface +
dynamic customer form generated from the selected questions.

## 2026-08-15 — Setup rethink MOCKUP: separate process UI + questions manager (#696)

Ron: Setup should be a SEPARATE process + separate UI (integrated w/ the opportunity,
not buried in the quote editor), and he needs a place to MANAGE the setup questions
(establish + grow them, like a catalog → the customer form is built from them, not
hardcoded). Built a clickable mockup web/src/pages/public/SetupProcessMockup.tsx, route
/mockups/setup, PR #696 (NOT for merge). Two tabs: (1) 'This setup' — standalone Setup
surface w/ its own progress stepper (Sent→Opened→Submitted→In review→Complete),
organizer link, grouped answers, '← from the signed opportunity' link; (2) 'Setup
questions' — catalog manager: sections + questions, each w/ editable label + type
(short/long/yes-no/select/multi/number) + Required + add/remove/reorder. BROWSER-VERIFIED
both tabs render + interactive. NEXT: Ron reacts to the mockup → build the real thing:
a setup_questions catalog table (like service_catalog) driving a DYNAMIC customer form
(replaces the hardcoded intake), + Setup as its own admin surface (own route, linked
from the opportunity). This supersedes/reworks the just-shipped hardcoded Setup 3c form.

## 2026-08-15 — SETUP flow COMPLETE end-to-end (3a+3b+3c) → TEST

Full funnel Stage 3 shipped: Signed quote → Start setup → copy link → customer fills
/setup/:token → answers reviewed on the quote. All merged to TEST, no open PRs.
- 3a #691: tournament_setups migration (APPLIED green on TEST) + token RPCs.
- 3b #693: admin Start-setup (creates the setup, lights up Setup stepper stage) +
  copyable customer link + read-only answers review panel on QuoteEditorPage.
- 3c #695: customer /setup/:token intake (the 5-step wizard w/ DUPR/levels/MoneyBall)
  wired to get_setup_by_token (load/prefill) + save_setup_by_token (submit + save-
  later). BROWSER-VERIFIED the load + invalid-link path against TEST. Caught+fixed a
  lost-`this` crash (supabase.rpc must be bound) that typecheck/build/lint all MISSED —
  reminder: browser-verify public pages.
Client uses untyped supabase cast (tournament_setups + RPCs not in generated types;
regenerate types someday to drop the casts). Current quote fits: move to Signed →
Start setup. NOT verified: admin Start-setup + the happy-path form load (both need a
platform-admin session / real token — Ron click-through on TEST). REMAINING funnel:
customer-side Accept/Decline on the quote page (token RPC); feed submitted setup
answers → tournament creation (future). Whole session's TEST pile (quote editor
redesign #689, opportunities pipeline #684, Setup #691/#693/#695, etc.) is unpromoted
— a PROD batch is due when Ron's verified.

## 2026-08-15 — Building SETUP (funnel Stage 3). Ron: "build the Setup" + current quote fit

Ron approved: copy-link (no auto-email) + full flow. Building in 3 parts:
- **3a DONE (#691) → TEST, migration APPLIED green**: tournament_setups table (one per
  quote, jsonb answers, token, status sent→in_progress→submitted→complete), platform-
  admin RLS, SECURITY DEFINER token RPCs get_setup_by_token / save_setup_by_token
  (anon), mirroring quote share-token pattern. (Couldn't test SQL locally; migrate
  workflow confirmed success on TEST.) NOTE: types NOT regenerated — client uses the
  `untyped` cast (supabase as unknown as SupabaseClient, per orgContacts) + .rpc().
- **3b NEXT (admin)**: QuoteEditorPage — 'Start setup' on Signed quotes creates the
  tournament_setups row (select-or-insert under platform-admin RLS), shows a copyable
  customer link (${origin}/setup/${token}) + a review panel of submitted answers;
  activate the 'Setup' stepper stage (currently disabled). Current quote fits: works on
  any Signed quote.
- **3c NEXT (customer form)**: /setup/:token = the real intake (reuse the mockup form
  Ron liked from closed #681 branch mockup/tournament-setup-intake:
  web/src/pages/public/TournamentSetupIntakePage.tsx — has DUPR/levels/MoneyBall) wired
  to get_setup_by_token (load) + save_setup_by_token (save/submit).
Intake fields defined in docs/tournament-host-guide.md (on main).

## ⏳ In flight / pending

- **Auth providers not configured in the Supabase dashboard** — magic link +
  Google OAuth won't deliver until the manual config in [`CLAUDE.md`](./CLAUDE.md)
  ("Manual Supabase dashboard config") is done. Email/password works.

## 🔜 Next

- Living roadmap is the **WMPC Roadmap board** (Project #1, owner
  `notronwest`) — this repo's `story` issues. See the **Backlog** section
  in [`CLAUDE.md`](./CLAUDE.md). Spirit: smallest end-to-end loop first.

## Deeper references

- [`CLAUDE.md`](./CLAUDE.md) — six locked decisions, schema, routes, deploy.
- [`docs/DESIGN_PREFERENCES.md`](./docs/DESIGN_PREFERENCES.md). Backlog →
  the WMPC Roadmap board (see the Backlog section in `CLAUDE.md`).
- [`../wmpc-meta/strategy.md`](../wmpc-meta/strategy.md).

## 2026-09-11 — Briefing email + start-times page: venue was blank for saved-location tournaments

Ron: "I don't see location in the briefing email." Wizard-made tournaments (PB Angels
included) keep their venue in the saved org location (`tournaments.location_id` →
`locations`); `send-tournament-briefing` and the public `StartTimesPage` read only the
legacy free-text `location_name` / `location_address`, which are null there. Both now
select `locations(name, address, address_line2, city, state, postal_code)`, prefer it, and
compose the address the way the public tournament page does (`composeLocationAddress`);
the legacy columns stay as the fallback. Briefing harness (stubbed client) confirms the
intro "at <venue>" line, the "Where" block and the Maps link with the composed address.
web typecheck + lint + FN tsc clean. Ships as one PR (function + page are independent).

## 2026-09-11 — Pool distribution/reassignment locked once games exist (data-integrity guard)

Redistributing pools rewrites each team's `pool_index`, but generated matches already
reference those teams and their pool assignment — so re-pooling (or moving one team's pool)
*after* games are created corrupts the bracket/standings. In `EventConsolePage.tsx`
`TeamsSection`: `distributePools` now early-returns with an error when `hasMatches` and routes
its writes through a new pure `planPoolDistribution()` (in `poolDistribution.ts`) that returns an
empty plan whenever games exist; both pool buttons get `|| hasMatches` on `disabled` + a
"Locked — reset all matches first" title. Applied the **same guard to the per-team Pool
dropdown** (`onSetPool`) — same corruption vector — blocking the handler and disabling the
`<select>`. Seed drag-reorder left unguarded on purpose (matches key off registration ids, not
seeds; reseeding is reversible/cosmetic). Extracted `snakePoolIndex`+planner and added
`poolDistribution.test.ts` (7 cases, headline = no-op when matches exist). typecheck clean,
vitest 7/7; no CI runs eslint/tsc/vitest on web (Pages builds `vite build` only). Productized
just this guard out of a larger mixed local diff on the offline laptop — partner-B add / playoff
preview / H2H tiebreak already have their own branches. Shipped in PR #875 (Closes #876),
squash-merged to `main` → **TEST**. **Next:** validate on test.bertanderne.com, then promote to
PROD via a `main`→`production` PR.

## 2026-09-13 — End-of-tournament summary report (client-facing wrap-up)

Ron: "build an end-of-tournament summary report I send to the client — every bracket +
its winners, plus fun stats (players, teams, points, how long it lasted)." New admin page
`/admin/:orgSlug/tournaments/:slug/summary` ("Summary report" button on the tournament
home, next to Player briefing). Loads the tournament + its events, spot-holding regs,
players and matches (paged past the 1000-row cap) and renders a printable sheet:
masthead (dates/venue), optional note to the client (page-local, not saved), "By the
numbers" tiles (players, teams, brackets, matches, points, medals, days/hours of play,
courts used), every bracket with its Gold/Silver/Bronze podium, a Highlights grid
(highest-scoring match, closest finish, nail-biters, most lopsided, shutouts, most
dominant pool run, undefeated teams, most matches played, multi-event players, busiest
court, longest day) and a day-by-day table. Print / Save as PDF (visibility-based print
CSS in the component, Letter + ½in margins) and Copy-as-text for pasting into email.
On-screen warning when matches are unscored / podiums undecided.
- **Data honesty:** matches have no started_at/completed_at, so "how long it lasted" is
  first score → last score per day (a completed match's `updated_at` = when its score was
  recorded). Per-match durations would need two timestamp columns + a status trigger on
  `matches` — flagged as a follow-up migration, not done here.
- **Refactor:** `buildTeams` / `computeStandings` / medal derivation moved out of
  `EventConsolePage` into `lib/bracketTeams.ts` (page re-exports the types) so the report
  decides winners exactly as the console does. Round-robin-only events podium from
  standings (labelled as such); medal events from the final-round matches.
- Pure summary math in `lib/tournamentSummary.ts` + 11 vitest cases (74 total pass).
  typecheck + build clean; lint clean on all touched/new files (27 pre-existing hook-rule
  errors elsewhere unchanged). Browser-verified via a throwaway fixture harness at 390px
  (no overflow; day table stacks to cards) and 1100px, plus print-media render.
- NOT verified against a real tournament on TEST — Ron: open a completed tournament's
  Summary report on the PR preview and eyeball the podiums vs the event consoles.
