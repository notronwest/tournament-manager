# Status — tournament-manager

Append-only session handoff log. **Read this first; append a dated entry
before you wrap.** Newest on top; new entries supersede old — don't rewrite.

Current state: **V5 brand wired — brush wordmark in navbar, homepage
rebuilt to mockup 01 on shared publicTheme tokens. Foundation
(schema + auth + organizer-side tournament create/list/view) still
in place underneath.**
Last updated: **2026-06-07**

## 2026-06-07 — Backlog additions: pricing bug #81 + register-focus mockup #98

Two new backlog items captured (both on the WMPC Roadmap board, Priority
**"Next up"** = the board's high-urgency bucket; project write-scope now
granted):

- **#81 (bug) — returning-player overcharge.** Already detailed in the
  06-06 entry below. Board: Backlog · Next up.
- **#98 (story) — "register focus mode."** Clicking Register dims every
  *other* event behind a scrim and lifts the chosen card into focus.
  Built the mockup `mockups/event-focus-overlay.html` (self-contained,
  on-brand, interactive — Esc/scrim/× exits; JS + tag balance validated)
  shipped as **PR #99** (Closes #98). Issue carries the implementation
  spec + a11y notes (focus trap, `inert` siblings, reduced-motion).
  Touches `PublicTournamentPage` `EventCard` only; no schema/pricing.
  Board: Backlog · Next up.
  - **Fix:** event cards were JS-injected, so no-JS previewers (macOS
    Quick Look / sandboxed panes) showed a blank page. Rewrote them as
    **static HTML** (JS now only drives the focus interaction). Pushed to
    PR #99.
- **#100 (story) — rebrand the login screen on the V5 brand.** `LoginPage`
  is still the old "Tournament Manager" card + `#2563eb` blue; never got
  the V5 treatment. Built mockup `mockups/login-screen.html` (split ink
  brand-panel + cream/ink form, segmented mode control, static-first)
  shipped as **PR #101** (Closes #100). Touches `web/src/auth/LoginPage.tsx`
  → `publicTheme` tokens; presentation only. Board: Backlog · Next up.

Board write-access is now set, so future board updates need no re-auth.
All mockups are static-HTML-first so they render in any previewer.

## 2026-06-06 — Drift reconciled (event_roster) + eligibility enforcement (#56) validated

Working the project board's **Blocked** queue (#72, #18, #56, #13, #66),
starting with the eligibility epic (#13 → #55/#56). Hit — and fixed — a
prod migration-drift blocker along the way.

- **#56 server-side enforcement — written + VALIDATED** on branch
  `feature/issue-56-eligibility-server-enforce`
  (`supabase/migrations/20260606140000_enforce_event_eligibility.sql`).
  A `BEFORE INSERT` trigger on `event_registrations` mirroring the client
  guard (`web/src/lib/eligibility.ts`, PR #75) byte-for-byte — rating
  gate by event format, gender gate, null-rating = ineligible. **Design
  (approved):** trigger not RPC (bypass-proof without rewriting every
  insert path); exempts service_role (`auth.uid()` null) + org staff
  (`has_org_role`) so organizers can hand-place players and seed tools
  keep working. Adds a `format_rating()` helper. **Validated** by running
  the full migration inside a `begin … rollback` txn via the Supabase
  Management API `/database/query` — executes clean against the real prod
  schema, nothing persisted (verified the fn/helper are absent after).

- **Drift root-caused + reconciled.** Two migrations were applied
  directly to prod and were missing locally: `20260606120000`
  (`lock_pricing_with_active_regs`, #16) and `20260606130000`
  (`event_roster_rpc`, #71/#69). Turned out **120000 was already on
  `main`** (merged via PR #63) — so the *only* real remaining orphan was
  **130000 event_roster**. Recovered its exact SQL read-only from the
  prod migration-history table (Management API, token from Ron) and
  committed it under its original name on a clean branch
  **`fix/reconcile-event-roster-drift`** (off `main`). `supabase db push
  --dry-run` now reports "Remote database is up to date" — drift closed.
  This was also the root of **#72**'s Blocked status (roster panel needs
  that RPC).

- **Parallel session (daemon) built the *prevention*: PR #76** —
  CI-applied migrations (`deploy-migrations.yml`), daily drift alarm
  (`migration-drift-check.yml` + `check-migration-drift.sh`), and the
  written rule in CLAUDE.md / `supabase/migrations/README.md`. Kept
  entirely separate from this reconcile work (no migration files in #76).

- **Traceability:** every PR from this work now closes a tracked issue —
  **#78→#56** (eligibility), **#77→#79** (reconcile, new tracking issue),
  **#76→#80** (guardrails, new tracking issue). The guardrails issue
  notes the through-line: a machine-applied, drift-free migration path is
  a prerequisite for trustworthy **automated regression testing (#66)**.
  #79/#80 are on the WMPC Roadmap board, both **In Review** (alongside
  #56). Temp recovery token has been revoked by Ron.

- **New bug filed: #81 (High).** Found while reviewing the #64 fix —
  a returning player who already paid then registers for a new event in a
  **later session** is charged the first-event/entry fee again instead of
  the additional-event fee (seen in the Seacoast / Pickleball Angels
  tournament). Root cause traced: `computeLineItems` in
  `web/src/lib/pricing.ts` only sees the current session's pick-set and
  has no knowledge of already-paid events, so the lone new pick is priced
  as "first." Fix direction in the issue. Labelled `bug`+`story`, on the
  board at **Backlog · Priority "Next up"** (the board's top urgency bucket).

- **🔜 Next / merge order (clean baseline first):**
  1. Merge **`fix/reconcile-event-roster-drift`** → `main` (main now
     matches prod exactly).
  2. Merge **PR #76** (guardrails) → CI enforces from here on. Ron must
     first add repo secrets: `SUPABASE_ACCESS_TOKEN`,
     `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`,
     `MIGRATION_ALERT_WEBHOOK`.
  3. Merge **#55 (PR #75)** + **#56** → **epic #13 closes**; eligibility
     enforced client + server. `140000` deploys via the new CI.
  - Remaining Blocked queue: **#72** (now unblockable — RPC is in the
    repo; frontend-only build, mockup + AC exist), **#18** (locations),
    **#66** (needs the CI service-role secret from Ron).
  - Tooling notes: psql installed via `brew install libpq`; Docker NOT
    available (so `supabase db dump`/`db pull` can't run — used the
    Management API instead). Revoke the temporary Supabase access token
    used for recovery.

## 2026-06-05 — Partner-mode picker shipped to PR #58 (choice tiles)

- PR #58 originally turned the "Pick a partner / I need a partner"
  toggle into a connected segmented control; even with shared borders
  the segments still read as action buttons.
- Wrote `mockups/partner-mode-options.html` — seven UX alternatives.
  Picked option 5 (compact icon + label choice tiles), refined down
  to one-line tiles with the seeker icon swapped to 🙋 (the seeker
  isn't searching, they're raising a hand to be matched).
- **Implemented on `feature/issue-15-segmented-control`**
  (commit `f845cb4`): `partnerModeBtnStyle` → `partnerModeTileStyle`
  in `web/src/pages/public/PublicTournamentPage.tsx` (~L1410 container,
  ~L1610 style fn). Lucide `Handshake` + `HandHelping` icons (no
  `Search` — that user isn't searching). ARIA semantics preserved
  (`role="radiogroup"`/`role="radio"`/`aria-checked`). Typecheck +
  build green; lint footprint clean (26 pre-existing errors on this
  branch unchanged).
- `docs/DESIGN_PREFERENCES.md`: replaced the segmented-control rule
  the PR's first commit added with the choice-tile pattern, including
  the "consider semantic accuracy when picking the icon" guardrail.
- PR title + description updated to reflect the new direction
  (`gh pr edit 58`).
- **Next**: verify the Cloudflare Pages preview on PR #58 renders as
  expected, then merge if it looks right. After merge, the V5
  treatment of `PublicTournamentPage` (mockup 02) is still the
  bigger outstanding public-pages job.

## 2026-06-03 — V5 homepage + publicTheme refactor

- Rebuilt `web/src/pages/public/HomePage.tsx` to mockup 01 from
  `mockups/layouts-v5.html` — cream hero w/ court-yellow radial glow,
  Alfa Slab One headline with court-red accent line, two ink CTAs,
  upcoming-tournament grid with G/Y/R color-cycling stripes. Search +
  loading/error/empty states preserved.
- Added Google Fonts preload (Alfa Slab One, Anton, IBM Plex Mono,
  Inter) to `web/index.html`; `<title>` is now "bert & erne —
  pickleball tournaments".
- Refactored HomePage to consume the shared tokens / primitives from
  `web/src/lib/publicTheme.ts` (the brush-wordmark commit landed it).
  Hero-specific variants (oversized H1, big CTAs, billboard H2)
  built by spreading the shared bases so future palette tweaks
  cascade.
- Boxed V5 outlined logo retired and `git mv`'d to
  `mockups/archive/v5-outlined-boxed/` — runtime brand mark is the
  brush wordmark in SiteHeader. Build output confirms the boxed SVG
  is no longer bundled.
- Reference gallery checked in at `mockups/layouts-v5.html` (5
  surfaces: public homepage, public tournament detail, organizer
  dashboard, printed program, registration email) for when the
  other four get built out.

**Next on the V5 rollout**: apply the mockup 02 treatment to
`PublicTournamentPage`, and decide whether the boxed V5 logo (now in
the archive) should come back as the favicon.

## 2026-06-03 — Design system adopted

- `web/src/tokens.css` added (overrides: primary `#2563eb`, danger `#dc2626`,
  overlay) and `ConfirmModal` migrated onto tokens (value-preserving).
- Lucide (`lucide-react`) adopted.
- `docs/DESIGN_PREFERENCES.md` points at `../wmpc-meta/design-system/`.
- Landed as a merged PR.

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
