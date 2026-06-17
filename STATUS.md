# Status — tournament-manager

Append-only session handoff log. **Read this first; append a dated entry
before you wrap.** Newest on top; new entries supersede old — don't rewrite.

Current state: **V5 brand wired — brush wordmark in navbar, homepage
rebuilt to mockup 01 on shared publicTheme tokens. Foundation
(schema + auth + organizer-side tournament create/list/view) still
in place underneath.**
Last updated: **2026-06-15**

> ⚠️ **Continuity gap fixed (2026-06-14):** entries between 06-09 and 06-14
> (login/onboarding batch, Resend SMTP, Quote Studio epic) were written to a
> **stale local checkout** (an abandoned `feature/issue-125` branch ~190 commits
> behind `origin/main`) and never pushed — so `origin/main`'s STATUS.md sat at
> 06-09. This entry resyncs the front door. Durable record of that work lives on
> the **board** (#306–#318) and in merged PRs; the stranded local entries remain
> in that checkout's working tree if finer detail is needed.

## 2026-06-17 — Login: two tabs by intent, magic-first signup (PR #359)

Even after #357 the labels confused — "Get started" (magic) and "Create account"
(password) were **both** new-account paths shown as separate tabs. Reworked
`/login` to **two tabs by intent**: "Create account" (new) and "Sign in"
(returning). The Create account tab leads with the magic link (no password) +
Google, and a "Prefer to set a password?" toggle swaps to the password sub-form
(and back) without leaving the tab. Heading/subtitle now mode-aware; the
`/getting-started` CTA deep-links to the magic-first create-account view
(`{ mode: "magic" }`). Internal modes unchanged (`magic`/`signin`/`signup`/`forgot`)
— only the tab grouping + a method toggle. Verified in preview (CTA → magic-first
Create account; password toggle keeps the tab active; Sign in keeps password +
Forgot); typecheck + lint clean. Branch `feat/login-two-tabs`. 🔜 Ron: merge #359
(then promote — completes the /getting-started signup flow).

## 2026-06-17 — Fix: login signup tab mislabeled (PR #357)

Follow-up to #355: the third `/login` tab read "New password" while that mode's
heading + submit button both say "Create account" — confusing arriving from the
new CTA. Relabeled the tab to "Create account" so all three agree
([LoginPage.tsx](web/src/auth/LoginPage.tsx), branch `fix/login-signup-tab-label`).
Verified in preview. **Merged (#357) + promoted to production** (PR #358, `dee0dda`) —
UI-only. Completes the /getting-started "Create account" flow end to end in prod.

## 2026-06-17 — Getting Started: top "create an account" CTA (PR #355)

`/getting-started` now leads with a prominent **Create your free account** CTA
(branch `feat/getting-started-signup-cta`). Deep-links to `/login` with
`state={ mode: "signup" }` so visitors land directly on the signup form (Google +
email both there) — no duplicated auth UI. `LoginPage` now honors an explicit
initial mode from navigation state (falls back to the public-flow/signin defaults).
Swaps to a "you're signed in → browse tournaments" note when authed. Verified in
preview (renders, deep-link hits signup form, no console errors); typecheck + lint
clean. 🔜 Ron: merge #355.

## 2026-06-17 — 🚀 Prod promotions + branded auth emails (recovered front-door note)

Today's prod work (the STATUS entries were written to an un-pushed local checkout and
didn't reach `origin/main`; durable record is the merged PRs — recapped here):

- **Promoted to production (PR #352, `fd51939`):** paired-roles P1 (#337), Quote
  Studio P4 (#315), org soft-delete (#351) + fixes. Applied 2 migrations to PROD
  (`quote_studio_p4`, `paired_roles_events`) — verified green.
- **Branded auth emails (#303) — chosen path: Resend as Supabase SMTP.** Templates
  (`supabase/email-templates/`) get pasted into Supabase → Auth → Email Templates
  (both projects); Resend is just the SMTP relay (`smtp.resend.com:465`). App emails
  already send via the Resend **API** in 6 edge functions.
- **Email logo now matches the site (PR #353 → prod via PR #354, `2a66e66`).** Dark-band
  brush wordmark; PNG rendered from `bert-and-erne-brush-mark.svg` via
  `scripts/render-email-logo.mjs` → `web/public/email/logo@2x.png`, live at
  `https://bertanderne.com/email/logo@2x.png` (200 image/png).
- 🔜 **Ron (dashboard):** configure Resend SMTP + paste templates in both Supabase
  projects, then send a test. **Open caveat:** Supabase's preview pane shows the logo
  broken (dashboard CSP blocks the remote image in-preview) — verify via a real send,
  not the preview. If the real inbox also shows it broken, the `@` in `logo@2x.png` is
  the cause → rename to `logo.png` + redeploy.

## 2026-06-15 — Feature: delete (soft-delete) an organization

- **What:** platform-admin-only org deletion. New edge function
  `supabase/functions/delete-organization/index.ts` (mirrors
  `create-organization`'s auth shape): verifies caller is in `platform_admins`
  server-side, soft-deletes the org (`deleted_at`), cascades `deleted_at` to its
  tournaments (public pages all filter `deleted_at is null`, so registration/
  detail pages stop serving; children hide transitively), writes an `audit_log`
  row. Soft delete is the only option — `tournaments`/`registrations` FK with
  `on delete restrict`.
- **UI:** new `OrgDangerZonePage` at `/admin/:orgSlug/settings/danger`
  (platform-admin gated; type-the-org-name to enable + final `ConfirmModal`;
  redirects to `/admin` on success). Route in `App.tsx`; "Danger zone" sidebar
  link in `AdminLayout` shown only when `isPlatformAdmin === true`.
- **Decisions (Ron):** platform-admins only · cascade-hide tournaments · danger-
  zone placement. RLS left unchanged — `"orgs update by admins"` still lets an
  org admin set `deleted_at` via raw client UPDATE (pre-existing); our flow is
  platform-admin-only via the function. Tightening it is a separate call.
- **Verified:** build ✓, typecheck ✓, lint ✓.
- 🔜 **Manual per env (Ron):** `supabase functions deploy delete-organization`
  — CI does NOT deploy functions.

## 2026-06-15 — UX: paired-roles reg shows why Save is disabled

- **What:** on a paired-roles doubles event, picking a partner without choosing
  an "I'm registering as" side left Save greyed with no explanation. Added a
  hint next to Save in `PublicTournamentPage` EventCard: *"Registration not
  complete — pick an 'I'm registering as' option above to complete your
  registration."* shown when `is_paired_roles && isDoubles && !registrationSide`.
  Gated the existing "Pick a partner" hint behind `sideChosen` so only one shows
  at a time (no-op for non-paired events, where `sideChosen` is always true).
- **Verified:** typecheck ✓, no new lint (pre-existing errors at lines 509+ are
  unrelated).

## 2026-06-15 — Builder: #338 paired-roles pairing board in review

Builder ran on #338 (First Responder Community Doubles — P2, organizer pairing board).
No migration needed — the board writes `partner_registration_id` + `partner_status` via
the existing RLS org-member UPDATE path (same channel as EventConsolePage's team-add).

- **PR #349** (`feature/issue-338-pairing-board` → `main`): new `PairingBoardPage`
  at `/admin/:orgSlug/tournaments/:tournamentSlug/events/:eventId/pair-teams`.
  Unpaired registrants in two columns (one per side); click Side-A → select; click
  Side-B → pair (links both registrations via `partner_registration_id`). Confirmed
  teams table with invite-vs-organizer label and Undo button (ConfirmModal warns on
  invite-formed pairs). Auto-match button pairs remaining solos in sign-up order.
  Summary bar shows per-side unpaired counts and imbalance chip. "Pair teams" button
  added to EventConsolePage header (only rendered for `is_paired_roles` events).
  Closes #338.

Card #338 → **In Review**.

🔜 **Ron:** review and merge PR #349. Notification is in-app only (partner name
shows on the public registration page once paired); email would need a future [FN] PR.

## 2026-06-15 — Fix: platform admin saw "No organizations" at /admin

- **Bug:** A platform admin with no explicit `organization_members` rows (ron —
  never ran the WMPC ownership-claim SQL) hit "No organizations" at `/admin`
  even though the override list held every org. `AdminIndexPage`'s empty-state
  guard returned early on `orgs.length === 0` alone, before the render that
  shows `overrideOrgs`. Confirmed RLS (`orgs read public`) returns all orgs to
  the anon key, so RLS was never the blocker; ron confirmed he's a platform
  admin (the "+ Create organization" button shows).
- **Fix:** empty-state guard now requires **both** `orgs` and `overrideOrgs`
  empty; effect sets `overrideOrgs` before `orgs` so the guard sees both at once
  (no empty-state flash). UI only. Shipped as PR for #345.
- 🔜 **Next:** ron can now reach WMPC + Pickleball Angels under "platform-admin
  access". Latent follow-up: the `seed_platform_admin_ron` migration is a no-op
  if run before ron's auth row exists — consider an `auth.users` trigger so the
  platform-admin bootstrap self-heals across env rebuilds (not done here).

## 2026-06-15 — Fix: saved-venue selection wrongly tripped the publish gate

- **Bug:** In the tournament create wizard, picking a **saved venue** from the
  Basics dropdown (incl. the org default, which auto-selects on a new
  tournament) left the Review & Publish step blocking on "Add a venue location"
  — so a tournament with a valid venue couldn't publish.
- **Cause:** field mismatch. `saveBasics` stores a saved venue as `location_id`
  and deliberately *nulls* `location_name`; the publish gate at
  `TournamentWizardPage.tsx:585` checked **only** `location_name`. The Review
  card had the same blind spot (hid the venue line whenever `location_name` was
  null).
- **Fix:** publish gate now passes if **either** `location_id` *or*
  `location_name` is set. Review card resolves the saved venue's name via a
  `locations` lookup on `location_id` so it actually shows the venue. UI/
  validation only — no migration, no RLS change. Typecheck clean; no new lint
  errors (pre-existing error at line ~1236 is unrelated).
- Shipped as PR #343 (branch `fix/saved-venue-publish-gate`).
- 🔜 **Next:** consider extending the same either-field check to the standalone
  tournament edit form if it has a parallel venue validation.

## 2026-06-15 — Quote Studio P4 in review (contract generation, #315)

Builder ran on #315. Split into two stacked PRs per the schema/infra rule:

- **PR #335 `[DB]`** (`db/issue-315-contracts-schema` → `main`): migration
  `20260615130000_quote_studio_p4.sql` — `contract_status` enum, `contracts` table
  (id, quote_id, revision_id, terms_version, generated_at, status, document_html,
  created_by, created_at), platform_admin-only RLS, updated TS types. Closes sub-issue #333.
- **PR #336 `[UX]`** (`feature/issue-315-contract-generation` →
  `db/issue-315-contracts-schema`): `ContractPage` (`/admin/quotes/:quoteId/contract/:contractId`),
  "Contracts" section in `QuoteEditorPage` (visible when status=accepted, lists existing
  contracts, Generate contract button), route in `App.tsx`. Closes sub-issue #334.

Card #315 → **In Review**. 🔜 **Ron:** merge DB PR #335 first → CI applies migration →
validate UX PR #336 on preview → merge UX. Then #315 parent closes once both sub-issues close.

## 2026-06-15 — Prod Google OAuth fixed; First Responder paired-doubles design

Two things, both config/design (no repo code changed):

- **Prod Google login was broken** (`Unable to exchange external code`, dumped on
  the Site-URL fallback `bertanderne.com`). Root cause: the Google OAuth client
  secret was rotated for local testing and never updated on prod, so Supabase
  presented a dead secret. Resolved by re-pasting the current secret into
  Supabase → Auth → Providers → Google. Note for next time: one secret at a time —
  any rotation must propagate to every Supabase project; consider separate
  dev/prod OAuth clients. (Redirect URL allow-list confirmed correct; `bertanderne.com`
  is Ron's own domain sharing this Supabase project — Site URL points there.)

- **Design direction settled for a "First Responder Community Doubles" event**
  (charity mixer: every team = 1 first responder + 1 community member; MM/FF/mixed
  all allowed). Chosen approach over Ron's "two singles events then migrate" idea:
  **one open/coed doubles event + a per-registration `role` tag** (`first_responder`
  / `community`), reusing the existing `partner_registration_id` self-FK and
  `partner_invites` flow. Pre-formed pairs lock via invites; solo "match me" signups
  sit unpaired (null partner) and the organizer pairs them on a new pairing board.
  Avoids the payment-line-item orphaning + wrong-format history that row-migration
  would cause. Net-new build: role capture at registration, a "Paired roles" event
  toggle with two side labels, and the organizer pairing board. Mockups produced
  for all three. **Not yet committed to build** — pending Ron's go-ahead to file a
  `story` issue / draft the `role` migration.

## 2026-06-15 — Quote Studio P3 UX typecheck fix + #329 card advanced to In Review

Builder single-item run on #329 (`[UX] Quote Studio P3 — customer share link`).
PR #331 existed from a prior run but had a TypeScript error: `setCatalog` in
`CustomerQuotePage.tsx` was typed as `ServiceRow[]` while the query only fetched
`key, category` — causing a TS2345 error. Fixed by narrowing the state type to
`Pick<ServiceRow, 'key' | 'category'>[]` and dropping the unused `id` from the
select. `typecheck`, `build`, and lint (no new errors) all pass. Fix pushed to
`feature/issue-314-quote-share-link`; card #329 moved **Agent Ready → In Review**.

🔜 **Ron:** merge DB PR #330 first → CI applies migration → validate UX PR #331
on the Cloudflare preview → merge. Then promote P4 (#315, contract generation)
to Agent Ready if ready.

## 2026-06-15 — Board correction: #328 card advanced to In Review

Builder orphan-recovery run: issue #328 `[DB] Quote Studio P3 — share tokens schema + RPCs`
card was stuck in **In Progress** with no open PR visible, but PR #330 (Closes #328) already
existed and was open. Card moved **In Progress → In Review** to match the PR state.
No code changed; purely a board state fix.

## 2026-06-15 — Quote Studio P3 in review (shareable customer link, #314)

Builder ran on #314. Split into two stacked PRs per the schema/infra rule:

- **PR #330 `[DB]`** (`db/issue-314-quote-share-tokens` → `main`): migration
  `20260615120000_quote_studio_p3.sql` — `quote_share_tokens` table, two
  security-definer RPCs (`get_quote_by_token`, `submit_customer_revision`) with
  anon grants, updated TS types. Closes sub-issue #328.
- **PR #331 `[UX]`** (`feature/issue-314-quote-share-link` →
  `db/issue-314-quote-share-tokens`): `CustomerQuotePage` (`/q/:token`),
  share-link section in `QuoteEditorPage` (generate + revoke), "Customer
  updated" badge in `QuotesListPage`. Closes sub-issue #329.

Card #314 → **In Review**. 🔜 **Ron:** merge DB PR first → CI applies migration
→ validate UX PR on preview → merge UX. Then promote **P4 (#315, contract
generation)** to Agent Ready if ready.

## 2026-06-14 — #303 + #304 resolved (auth-email branding + welcome email)

- **#303 — CLOSED.** PR #308 (branded auth email templates under
  `supabase/email-templates/`) merged. 🔜 **Manual (Ron):** paste the 3
  templates into Supabase **Auth → Email Templates** (test, then prod);
  **prod still needs the Resend SMTP config** before prod auth emails send.
- **#304 — CLOSED.** Welcome-email-on-confirmation flow:
  - **#309** (edge fn `send-welcome-email`) merged — split its own tracking
    issue **#317** to satisfy the linked-issue CI gate (`Part of #` isn't
    enough; needs `Closes #`).
  - **#318** (DB trigger on `auth.users`, replaces the orphaned **#310** —
    #310 auto-closed when #309's branch was deleted out from under the stack)
    merged → `migrations.yml` applied the trigger cleanly to **TEST** (target
    correctly resolved to test; the Builder-flagged `pg_net` named-param risk
    did not bite).
  - 🔜 **Manual (Ron), per env:** (1) deploy the fn —
    `supabase functions deploy send-welcome-email --no-verify-jwt` (NO CI
    deploys functions); (2) one-time
    `ALTER DATABASE postgres SET "app.settings.supabase_url" = 'https://<ref>.supabase.co';`
    (else the trigger logs a warning and skips — safe default). Do on **test**
    first, validate, then on **prod** when promoting.
- **False alarm cleared:** suspected `migrations.yml` still pointed at prod —
  it does **not**. #298 (commit `0dc0650`) already made it branch-aware
  (`main`→TEST via `TEST_SUPABASE_PROJECT_REF`, `production`→PROD). The
  confusion came from the stale local checkout. Tracking issue #320 opened then
  closed as invalid.
- 🔜 **Cleanup:** the local checkout at
  `~/data/web/wmpc/projects/tournament-manager` is on a dead
  `feature/issue-125` branch, 190 behind `origin/main`, with stale uncommitted
  refund-era leftovers. Reset it to `origin/main` (or just always work in
  worktrees) so STATUS edits land on main.

## 2026-06-14 — Quote & Proposal Studio scoped onto the board (#312–#316)

Turned the WMPC "Tournament Management — Services & Pricing" Google Doc into a
phased Builder epic for the **platform admin** (services CPQ + contract).
**Epic #316** + four sub-issues: **#312 P1** (service catalog + unit-tested
`quotePricing.ts` engine + public `/estimate` form) → **🟢 Agent Ready**;
**#313 P2** (admin quote builder, price overrides, append-only revisions,
editable catalog), **#314 P3** (customer customization via shareable link),
**#315 P4** (contract PDF/HTML from accepted quote) → Backlog. Only P1 is Agent
Ready; promote the next as each merges. Decisions locked: phased · new
`quote_customers` entity · PDF/HTML contract (no e-sign yet) · admin-editable
catalog. Deferred: e-signature; wiring the $200 deposit to a Stripe charge.

## 2026-06-09 — Issue #150: court count now sourced from the venue

Dropped the tournament-level **Court count** field; court count now comes
from the selected venue (`locations.court_count`, added last night in PRs
#142/#144). Changes:

- **Wizard** (`TournamentWizardPage`) + **edit form** (`TournamentFormPage`):
  removed the "Court count" input, its state, validation, and the
  `court_count` write in the payload.
- **Consumers** now read `tournament.locations?.court_count` via a
  `locations(court_count)` join: `TournamentCourtManagerPage`,
  `SchedulePage`, `TournamentDetailPage`. The detail page's inline
  court-count *editor* is gone — it's now a read-only venue-sourced
  display (with a link to set it on the venue / pick a venue).
- **Graceful degrade** (AC #4): new shared `NoCourtCountNotice` component.
  Court manager + schedule show it (prompt to pick a venue / set court
  count) instead of crashing when no venue court count is resolvable.
- `RoundRobinEstimatorPage` was listed in the story but is a standalone
  tool with its own courts input — it never read `tournament.court_count`,
  so it was left alone.
- Removed an orphaned `court_count` from the HomePage select. DB column
  `tournaments.court_count` left in place (harmless; app no longer reads
  it). Typecheck + build clean; no new lint errors.
- **Scope note:** Ron also wants the venue **address** split into
  line1/line2/city/state/zip — filed as its own story, *not* in this PR.

**Next:** Ron reviews/merges the PR. Then drain the address-structuring
story.

## 2026-06-07 — Regression secrets renamed E2E_*; setup state

- Renamed the regression harness's generic secrets so they can't collide
  with prod: `SUPABASE_URL` → **`E2E_SUPABASE_URL`**, `SUPABASE_SERVICE_ROLE_KEY`
  → **`E2E_SUPABASE_SERVICE_ROLE_KEY`** across `regression.yml`, `seed.ts`,
  e2e `README.md` + `SETUP.md`. `VITE_SUPABASE_URL` (app build var) untouched.
- ⚠️ **Process slip:** this landed as a **direct commit to `main`** (`0f424c2`,
  Closes #118), not a PR — `HEAD` was on `main` at commit time (likely a
  concurrent git op in this shared checkout; didn't re-verify branch before
  committing). Change is correct + YAML valid; `main` history left intact (not
  rewritten — fleet pulls it). Lesson: verify branch in the same step as commit.
- **Test-harness setup state:** test Supabase project + schema done (1,2);
  `tournament-manager-test` Cloudflare Pages deploy in progress (3) →
  `E2E_BASE_URL = https://tournament-manager-test.pages.dev`. Secrets to set:
  `E2E_SUPABASE_URL`, `E2E_SUPABASE_SERVICE_ROLE_KEY`, `E2E_BASE_URL`,
  `E2E_TEST_PASSWORD` (DISCORD_WEBHOOK already set). Then Phase 5 (first green).

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
- **#121** (Next up, epic) apply the V5 brand/UX to *every* page —
  consistency sweep. Audit: HomePage/Checkout/Register/PartnerAccept are
  on `publicTheme`; ProfilePage, PublicTournamentPage, LoginPage (#100),
  and the whole `pages/admin/` area (~37 files) are not. Ship in slices,
  one surface per PR, driven by `publicTheme.ts` tokens. Largest single
  piece = PublicTournamentPage (mockup 02).

Open PRs needing attention:
- **#78** (#56 eligibility server trigger) — clean/mergeable; its
  migration is not yet on `main`.
- **✅ Eligibility shipped — epic #13 CLOSED (Done).** #75 (#55 client
  guard, after my rebase) and #78 (#56 server trigger) both **merged**.
  #55 + #56 closed; #13 epic closed. The #56 migration landed as
  `20260607160000_enforce_event_eligibility.sql` and is **applied on prod**
  (`migration list` confirms) — the `BEFORE INSERT` trigger is live, so
  rating + gender eligibility is enforced in UI *and* at the DB.
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
  frontend-only). The *public* contact form + edge function are now
  **BUILT in PR #119 (Closes #38)**: `supabase/functions/submit-contact-form`
  (salted-IP hash, 3/IP/10min throttle via `contact_form_submissions`,
  service_role insert, Resend fan-out to `receives_form_messages` contacts
  with Reply-To=sender) + a contacts list + form on `PublicTournamentPage`.
  typecheck/build green, 0 new lint. **Ron to ship:** set
  `CONTACT_FORM_IP_SALT` secret + `supabase functions deploy submit-contact-form`,
  then merge #119.
- **#22** (withdraw/refund) + **#30** (coupons) → **Backlog** — both
  fundamentally depend on real payments (#20) + Ron's DB/Stripe design;
  not actionable now.
- **#13** stays — auto-closes when #75 + #78 merge. **#66** already
  handled per Ron (test-DB decision made elsewhere).
- Blocked queue now: **#38, #66** (#13 closed/Done after #75+#78 merged).

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
