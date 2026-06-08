# Status — tournament-manager

Append-only session handoff log. **Read this first; append a dated entry
before you wrap.** Newest on top; new entries supersede old — don't rewrite.

Current state: **V5 brand wired — brush wordmark in navbar, homepage
rebuilt to mockup 01 on shared publicTheme tokens. Foundation
(schema + auth + organizer-side tournament create/list/view) still
in place underneath.**
Last updated: **2026-06-07**

## 2026-06-07 — Backlog grooming + status check (after a big parallel merge)

A lot merged to `main` in parallel (Builder/daemon) while this session was
grooming the backlog: **#81 pricing bug fixed (#82)**, roster view #21
(#83), drop Overview #25 (#85), pricing reframe #26 (#86), content
sections #39 (#96), additive schema migrations for #39/#18/#36/#38 (#92),
event_roster types (#87), and **CI gates requiring every PR to reference a
board issue / use a closing keyword**. **My drift-reconcile PR #77
merged** — the `event_roster` migration is on `main`.

Backlog issues filed this session (all on the WMPC Roadmap board):
- **#98** register-focus overlay — **Agent Ready** (mockup PR #99). Scrim
  stacking-context bug fixed; selected card now sits above the dim.
- **#100** login V5 rebrand + 3-step "Get started" storyboard (mockup PR
  #101). Next up.
- **#102** (bug, Next up) seeker blocked at checkout — `CheckoutPage`
  `blockingError` doesn't exempt `partner_status='seeking'`.
- **#103** (Next up) "My Tournaments" player page.
- **#104** (Soon) admin tournament list: clickable name / archive /
  delete / Current+Archived views (needs `archived_at` migration).
- **#106** (Later) rich-text WYSIWYG editor for tournament long-text
  sections; must sanitize (XSS).

Open PRs needing attention:
- **#78** (#56 eligibility server trigger) — clean/mergeable; its
  migration is not yet on `main`.
- **#75** (#55 client guard) — **rebased onto `main`, conflict resolved,
  now MERGEABLE** (import-only conflict in `PublicTournamentPage`; guards
  intact; typecheck + build green; 0 new lint vs main). PR gate passes
  (`Closes #55`); only the Cloudflare Pages preview is still building.
  Epic **#13** closes when #55 + #56 land.
- **#76** (drift guardrails) — clean; needs the 4 CI secrets first.
- **#99 / #101** (mockups) — set to **"Part of"** (not Closes) so they
  don't close the impl tickets; showing **UNSTABLE** — the new PR gate may
  want a *closing* keyword, which fights the "mockup shouldn't close impl
  ticket" intent. **Decide:** give each mockup its own closeable sub-issue,
  or relax the gate for mockup PRs.
- **#20** confirmed NOT done (real Stripe charging is still a placeholder
  status-flip; no PaymentIntent / `stripe-webhook`).

**Blocked-queue drain (Ron's loop):** worked the board's Blocked column
(was #13/#22/#30/#38/#66) →
- **#38** split — admin Contacts CRUD carved out as **#117 (Agent Ready,
  Next up)** since the `tournament_contacts` schema is already live (#92,
  frontend-only). #38 stays Blocked, now scoped to the *public* contact
  form + Resend edge fn (Ron-owned).
- **#22** (withdraw/refund) + **#30** (coupons) → **Backlog** — both
  fundamentally depend on real payments (#20) + Ron's DB/Stripe design;
  not actionable now.
- **#13** stays — auto-closes when #75 + #78 merge. **#66** already
  handled per Ron (test-DB decision made elsewhere).
- Blocked queue now: **#13, #38, #66**.

(Earlier session STATUS notes are stranded on
`fix/reconcile-event-roster-drift` after #77 merged early; this entry is
the current `main` handoff.)

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
  New issues #79/#80 may still need adding to the WMPC Roadmap board
  (project write-scope wasn't granted this session). Temp recovery token
  has been revoked by Ron.

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
