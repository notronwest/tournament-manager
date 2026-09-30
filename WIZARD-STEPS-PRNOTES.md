# Bracket Setup wizard — Courts + Start-time steps

Two new steps in the Event Console's **Set up & start** wizard, inserted
right after **Confirm settings** and before **Build the bracket**:

1. **Courts** — recommends which courts this event should use, accounting for
   the other Bert & Erne events already scheduled the same day (their courts,
   times and player rosters). The director accepts or toggles; changes persist
   to `event_courts`.
2. **Start time** — recommends when the event should start, shows the day's
   events with this one's proposed slot and projected end time, and lets the
   director accept or adjust. Persists to `events.scheduled_start_at`.

"What's already scheduled that day" = other events **in this tournament on the
same day** (no Court Reserve integration — none exists in this repo).

## What changed

New files:

- `web/src/lib/eventPlacement.ts` — the shared **event → schedule mapping**
  (durations, court needs, pack-item and fixed-placement shapes). This is the
  D-0049 extract (see below).
- `web/src/lib/eventPlacement.test.ts` — unit tests for the above.
- `web/src/lib/scheduleTime.ts` — the datetime-local round-trip + time-label
  helpers, extracted so there is one copy (previously inline in SchedulePage).
- `web/src/hooks/useEventScheduling.ts` — shared data + recommendation engine
  for both steps: fetches the venue court count, the same-day sibling events,
  their `event_courts` and rosters, and exposes `recommend()` /`factsFor()`
  that run the ONE scheduling engine (`packSchedule`) with this event movable
  and the siblings fixed.
- `web/src/pages/admin/CourtAssignmentStep.tsx` — the Courts step UI.
- `web/src/pages/admin/EventStartTimeStep.tsx` — the Start-time step UI.

Changed files:

- `web/src/lib/bracketWizard.ts` — added `"court"` and `"starttime"` to the
  step-id union, two `BRACKET_WIZARD_STEPS` entries (after `settings`, before
  `build`), two `bracketWizardStepGate` cases, and two `BracketWizardContext`
  fields (`courtsAssignedCount`, `hasStartTime`).
- `web/src/lib/bracketWizard.test.ts` — updated the fixtures for the new ctx
  fields and added gate + ordering coverage for the two steps.
- `web/src/pages/admin/EventConsolePage.tsx` — fetches this event's assigned
  court count in `reload`, extends `wizardCtx`, and wraps the two new step
  components as `wizardSteps` entries in the right position. Reloads on save so
  the gates clear.
- `web/src/pages/admin/SchedulePage.tsx` — **refactored** to use
  `eventPlacement.ts` and `scheduleTime.ts` (see below).

## Reuse decisions (D-0049)

- **The event→schedule mapping was extracted and shared.** The logic that was
  inline in `SchedulePage.tsx` (the `rows` useMemo building
  segments/`courtsNeeded`/`medalCourtsNeeded` via `estimateEvent`, and
  `placementFor` building a fixed `Placement`) now lives once in
  `web/src/lib/eventPlacement.ts` as `eventPlacementFacts`, `toPackItem` and
  `toFixedPlacement`. **SchedulePage was refactored to consume the helper** —
  its `rows`, `plan`, `placementFor` and the manual-start cascade all call the
  shared functions, so there is a single implementation. The wizard steps use
  the same helper via `useEventScheduling`.
- **Scheduling engine reused, not reimplemented:** `packSchedule`,
  `poolCourtsNeeded`, `medalCourtsNeeded`, `doubleElimCourtsNeeded` (through
  `eventPlacement`), and `estimateEvent` / `fmtDuration` from `estimator.ts`.
  No packing or duration math was rewritten.
- **`NoCourtCountNotice`** is reused for the "no venue court count" empty state
  in both steps.
- **Datetime helpers** (`toLocalInput`/`fromLocalInput`/`fmtTime`) were pulled
  into `scheduleTime.ts` and SchedulePage now imports them, rather than a
  second copy being made for the new steps.
- Court count comes from the **venue** (`locations.court_count`), same source
  as SchedulePage — not `tournaments.court_count`.

## How to validate on the preview (no code needed)

1. Open a tournament that has a **venue with a court count** set, and at least
   two bracket events.
2. Give one or two of those events a start time first (Schedule page →
   Auto-schedule, or set a start on an event) so there's "something else
   scheduled that day" for the recommendation to work around.
3. Open a different bracket event → **Event Console**.
4. Click **Set up & start** to open the wizard.
5. Step through: Mark ready → Confirm teams → **Confirm settings**. Click
   Next.
6. You now land on **Courts**. Confirm it shows a court grid with the
   recommended courts already selected (blue), any courts another event is
   using today marked "taken" (amber), and a one-line "why". Toggle a court on
   or off and confirm the selection sticks. Click **Next**.
7. You now land on **Start time**. Confirm a recommended start is pre-filled,
   the "Today's events" list shows the day's other events with **this event
   highlighted** and its **projected end time**, and a one-line "why"
   (e.g. earliest clear slot / what's in the way). Change the start and
   confirm it saves; use the "Use recommended" button to snap back. Click
   **Next**.
8. Continue to **Build the bracket** → **Review & start** as before.
9. Cross-check: go to the tournament's **Schedule** page and confirm the
   event's courts and start time match what you set in the wizard.
10. Empty-state check: open the wizard on an event whose tournament has **no
    venue / no court count** — both new steps should show the "No court count"
    notice with a link to fix it.

Do all of this on **TEST** (or name the environment when handing over) — a PR
preview has its own env-var scope.

## Verification I ran (worktree)

- `npm run typecheck` — passes (no output / exit 0).
- `npm test` (vitest) — **24 files, 273 tests passed** (includes the new
  `eventPlacement.test.ts` and the expanded `bracketWizard.test.ts`).
- `npm run build` — succeeds (the only output is the pre-existing
  "chunk > 500 kB" size advisory, not an error).

## Left for the owner

- **Visual/mobile check at 390px.** The court grid and the day timeline are
  built mobile-first (wrapping flex tiles, single-column list, 44px+ touch
  targets, no fixed widths that overflow), but I could not render the app in a
  browser from here — please eyeball both steps on a phone-width viewport.
- **Lint:** this repo's `eslint` is **not** clean on the base branch (32
  pre-existing errors, 25 of them `react-hooks/set-state-in-effect`). The new
  `useEventScheduling` hook's load effect follows the same established
  `useEffect(() => void load(), [load])` pattern used throughout the codebase
  (e.g. EventConsolePage's `reload`), so it adds one more instance of that
  existing pattern. All new files are otherwise lint-clean, and SchedulePage
  stays lint-clean after the refactor. Typecheck, tests and build are the
  green gates.
