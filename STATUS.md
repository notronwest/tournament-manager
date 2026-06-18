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

## 2026-06-18 — Bulk-delete events from "Edit all events" (PR #392)

Added a per-row **Delete** checkbox to the bulk events editor; on Save, marked
events are soft-deleted (`deleted_at`) after a ConfirmModal and drop from the table.
**Safeguard:** events with active (paid/pending) registrations are skipped with a
per-row error (uses the `players_registered_for_events` SECURITY-DEFINER RPC so RLS
can't hide a registration) — can't accidentally delete an event people paid into.
Deletions + edits save in one pass (deletion wins for a row both marked + edited).
Build + typecheck + lint clean; admin page so couldn't exercise interactively in
preview. Branch `feat/bulk-delete-events`. Possible follow-up: server-side (trigger)
enforcement of the reg guard. 🔜 Ron: merge #392 + promote if wanted (UI-only).

## 2026-06-18 — Render organizer line breaks (CR/LF → <br/>) — PR #385

Organizer text rendered run-on. New `nl2br()` (splits CR/LF/CRLF, interleaves
`<br/>`, React-escaped/XSS-safe) for the tournament description; `renderSimpleMd`
(content sections) now treats a single in-block newline as a `<br/>` (was a space),
blank lines still split paragraphs, CRLF/CR normalized. Verified live (First
Responder description shows its paragraphs/breaks — 5 `<br/>` where it was one
block; no console errors); typecheck clean. Branch `feat/render-line-breaks`.
🔜 Ron: merge #385 + promote if wanted (UI-only).

## 2026-06-18 — 🚀 Production: tournament-page redesign batch (#379–#383)

Promoted `main` → `production` (PR #384, `649aedf`). **UI-only — no migrations, no
edge-function changes**, so only the Cloudflare prod rebuild ran. Prod now == main
(0 behind). Ships the whole tournament-page redesign live on `bertanderne.com`:
Details/Register tabs (Details first), all details under the Details tab, Edit → the
setup wizard (all steps), and the consolidated header (event dates + registration
window + prominent right-aligned cost). 🔜 Ron: spot-check prod once Cloudflare
finishes (~1–2 min).

## 2026-06-18 — Header cost: prominent + right-aligned (PR #383)

Polish on #382. Header Cost restyled from a small left Meta to a big bold
display-font price pushed right (`marginLeft: auto`, right-aligned) — `$X to
register`, additional fee, tier label, right-aligned "See full pricing schedule" —
matching the old price panel. When/Registration stay left. Verified live; typecheck
clean. Branch `feat/header-cost-prominent`. 🔜 Ron: merge #383 (test only; #379–#383
the tournament-page redesign batch awaiting one prod promotion).

## 2026-06-18 — Header: dates + registration window + cost consolidated (PR #382)

Per Ron: brought event dates (When), the registration window, and cost into the
header hero as an at-a-glance meta row (incl. the multi-tier "See full pricing
schedule" toggle) and **removed the standalone price panel** (its info now lives in
the always-visible header, so cost still shows on both tabs). Venue/format
(Where/Courts/Nets/Surface/Ceiling) + description stay under Details; "When" dropped
from Details (now in header). Removed the now-unused `panelStyle` import. Verified
live (header shows When/Registration/Cost on both tabs; Where Details-only; multi-
tier schedule expands; no console errors); typecheck clean. Branch
`feat/header-dates-registration-cost`. **Merged to main (#382, `73b4c5d`) — NOT
promoted** (test only). 🔜 **Ron:** the tournament-page redesign batch #379–#382
(tabs, details→Details, Edit→wizard, consolidated header) is all on test, prod 12
behind — review on test, then promote the whole batch when ready.

## 2026-06-18 — All tournament details under Details tab; Edit → wizard (PR #381)

Two asks. **(1) Public page:** removed the description + when/where/venue meta from
the header (slim name + status + contact hero now) and moved them to the top of the
**Details** tab. Pricing/window stays the persistent header. **(2) Admin:** the
tournament "Edit" link (+ the "choose a venue" link) now opens the setup **wizard**
(all steps) instead of the basic `TournamentFormPage` `/edit`. Safe for published
tournaments — the wizard resume `payload` has no `status` (won't revert to draft)
and pricing locks on active regs. `/edit` route/`TournamentFormPage` still exists
but is now unlinked (candidate to retire later). Verified live (public: header
slimmed, Details shows description/meta, Register unchanged, no console errors);
typecheck clean. Branch `feat/tournament-details-to-tab-edit-wizard`. **Merged to
main (#381, `6a5afae`) — NOT promoted** (on test only; prod 9 behind — #379/#380/#381
all pending one promotion). 🔜 Ron: review on test, then promote when ready.

## 2026-06-18 — Tournament page: price/window header persistent across tabs (PR #380)

Follow-up to #379. Moved the pricing + registration-window panel out of the Details
tab to a **persistent header above the tab bar** — cost/opening time now shows on
both Details and Register. Details holds the info sections only now (+ a "No
additional details have been posted yet" empty state). Verified live (price on both
tabs, events under Register, no console errors); typecheck clean. Branch
`feat/tournament-tabs-persistent-price`. **Merged to main (#380, `d5d16cf`) — NOT
promoted** (both #379 + #380 on test only; prod 6 behind). 🔜 Ron: review tabs +
persistent header on test, then promote when ready.

## 2026-06-18 — Public tournament page split into Details / Register tabs (PR #379)

`PublicTournamentPage` was one long scroll. Added a tab bar below the header
(Anton caps, red active underline): **Details** (default) = pricing panel + the
info sections (refund/weather/facility/sponsors/FAQs); **Register** = the events
list + inbound-invite banner. Conditional render (not CSS hide), so each tab
mounts/unmounts its content — implemented as two `tab==="details"` blocks with the
register block between, no reorder needed. Resets to Details per tournament via a
`[orgSlug, tournamentSlug]` effect (the component persists across `/t/:slug`
navigations). Extensible: Schedule / Results slot in later. Verified live against
real tournaments (default Details shows pricing/hides events; Register mounts 2
event cards on Linwood; resets on navigation; no console errors). Typecheck clean;
lint error at 514 is the pre-existing `reload` effect. Branch
`feat/tournament-page-tabs`. **Merged to main (#379, `d8c91aa`) — NOT promoted yet**
(on test only; prod is 3 behind). 🔜 Ron: review tabs on test, decide pricing-on-
Details vs Register, then promote when ready.

(This commit also lands the accumulated session front-door entries below — they
were working-tree only until now.)

## 2026-06-18 — Builder blocked #377 (money/Stripe hard rule)

Builder ran against #377 (Charity donations P1). Blocked — three reasons hit the
hard "money / Stripe / secrets" stop rule: (1) new Stripe PaymentIntent infra,
(2) new secrets needed for the edge function that can't be carried in a PR, (3)
webhook routing needs live Stripe coordination. Comment left on #377 with the
three specific questions Ron needs to answer before Builder can draft the
`[DB]`/`[FN]`/`[UX]` split. **Next:** Ron answers the three questions in
[#377's comment](https://github.com/notronwest/tournament-manager/issues/377#issuecomment-4742035074)
and moves the card back to Agent Ready.

## 2026-06-18 — Charity donations epic designed + filed (#377, #378)

Ron wants optional donations for charity tournaments: donate directly from the
public tournament page (no registration) and add funds at checkout. Designed +
decomposed; durable record is the two stories (Backlog, feature).

**Locked decisions (with Ron):**
- **Anonymous donors** — no account; collect name + email + optional message.
- **100% to charity** — donations are a Stripe Connect destination charge to the
  org's account with **NO platform application_fee** (registration fees keep theirs).
- **Per-tournament toggle** (`tournaments.accepts_donations`), not a new type.
- **Checkout = add-on only** — pay ≥ required fees; donation only increases the total.
- Out of scope v1: tax-deductibility / charitable receipts (payment receipt only).

**Stories:** #377 P1 (Next up) — standalone Donate on the tournament page: new
`donations` table (server-only writes, org-member SELECT), `accepts_donations`
toggle, `create-donation-intent` edge fn (destination charge, no app fee),
public Donate flow, webhook marks paid, organizer "total raised" report. #378 P2
(Soon, depends on #377) — add-a-donation at checkout via `create-payment-intent`
(`donation_cents`, fee computed on registration subtotal only).

**Decision:** #377 → **Agent Ready** (Builder drafts `[DB]`/`[FN]`/`[UX]`; Ron gates
each, esp. the money PRs). #378 stays Backlog (depends on #377). 🔜 Builder drains
#377; **Ron:** merge DB first → validate on TEST → then FN/UX. Note: donations need
the org's Stripe Connect **active** — same onboarding gap behind the checkout error.

## 2026-06-17 — Profile: "do I even need a password?" explainer (PR #375)

The "leave blank to keep your current sign-in method" copy confuses users who've
never gone passwordless. Added a **collapsed-by-default** disclosure under the
Change-password label (`ProfilePage` Account section): explains magic-link / Google
sign-in, why it's safe (one-time expiring links, nothing to steal), and that a
password is optional. Pure UI. Typecheck + lint clean; couldn't preview the authed
Account section without creds. Branch `feat/password-optional-explainer`.
**Merged (#375) + promoted to production** (PR #376, `89100f7`).

## 2026-06-17 — Checkout: actionable "message the organizer" link (PR #373)

Follow-on to #371. When `create-payment-intent` returns `org_stripe_not_active`,
the friendly error now shows a **"Message the organizer about this →"** link to the
tournament contact form, **prefilled** with a message naming the tournament + the
problem. `TournamentContactPage` reads `?message=` (and already auto-fills name/email
for signed-in users) → effectively one click to send. `CheckoutPage` tracks the
error code in state to gate the link; clears it on Stripe-element errors/cancel.
Verified live: contact form prefill works end-to-end (textarea matches the param);
typecheck clean (lint error at 337 is the pre-existing `reload` effect). Branch
`feat/checkout-error-contact-link`. **Merged (#373) + promoted to production**
(PR #374, `76a1bf6`). Underlying payment failure (Stripe Connect not onboarded for
the org / missing prod `STRIPE_SECRET_KEY`) still needs resolving at
`/admin/:org/settings/stripe` — UX now handles it gracefully either way.

## 2026-06-17 — Checkout: friendly errors + error-handling plan (PR #371, story #370)

Checkout was showing the raw SDK string "Edge Function returned a non-2xx status
code." Root cause: on a non-2xx, supabase `functions.invoke` leaves `data` null and
stashes the function's real `{ error: code }` in `error.context` — the old code fell
back to `fnErr.message`. Fix (`CheckoutPage`): `readEdgeErrorCode()` reads the code
from the response, `paymentErrorMessage()` maps it to user-safe copy (default covers
the catch-all 500); also stopped leaking the raw DB error on registration load.
Branch `fix/checkout-friendly-errors`.

**Likely real cause of THIS failure:** `create-payment-intent` returns
`org_stripe_not_active` (409) when the org's Stripe Connect isn't onboarded
(`stripe_account_status != 'active'`) — or a catch-all 500 if `STRIPE_SECRET_KEY`
isn't set in prod. Once #371 ships, the screen will say which (the friendly copy is
code-derived). Confirm via Supabase → Edge Functions → create-payment-intent → Logs,
or the org's `/admin/:org/settings/stripe`.

**Error-handling policy (decided).** Don't email-per-error (noise). Primary =
in-app admin error log + Supabase function logs; alerts only for critical (payments)
via the existing Discord webhook. Filed as **story #370** (Backlog · Later · infra):
`error_events` table (server-only writes), platform-admin `/admin/errors` page,
targeted Discord/Resend alerts.

**Merged (#371) + promoted to production** (PR #372, `bc59c98`). 🔜 Ron: retry that
checkout — the friendly message now states the real cause (almost certainly Stripe
Connect onboarding for that org); then resolve the actual payment failure.

## 2026-06-17 — Register: actionable hint when gender unset (PR #368)

Follow-on to the gender policy. A profiled player with **no gender set** saw a
dead-end "Not eligible: women's event" on single-gender brackets. Now the
Register slot shows a **"Set your gender to register →"** link to
`/profile?return=<tournament>` when gender is unset on a men's/women's event. A
*set-but-wrong* gender (e.g. M on a women's event) keeps the plain "Not eligible"
block — that bracket genuinely isn't theirs. Eligibility rules + the DB trust
boundary (`enforce_event_eligibility`) unchanged; this is messaging only.
`PublicTournamentPage` renderAction. Typecheck + lint clean (live path needs an
authed profiled-but-genderless player on a gendered event — not repro'able in
preview). Branch `feat/gender-unset-register-hint`. **Merged (#368) + promoted to
production** (with #367, PR #369, `2178e33`) — UI-only.

## 2026-06-17 — Profile: post-login soft prompt + gender policy (PR #367)

**Flow.** New `ProfileOnboarding` (mounted in `App`, inside Router) listens for a
genuine sign-in and, if the profile is incomplete (missing first/last name or
email), sends the user once to `/profile` — the first-fill "Welcome" screen, whose
escape button is relabeled **"I'll do this later."** Soft prompt, fires once per
signed-in session, never on reload restore, covers all login methods (password /
magic / Google) via one auth listener. Registration stays the **hard gate**
(RequireProfile + the inline Register button, #365). "Complete" = first + last +
email; gender/ratings optional.

**Gender policy (decided — "keep it simple").** Already inclusive in code, now
documented in CLAUDE.md: `player_gender` = `M / F / X` ("Other / prefer not to
say"), **optional**. Eligibility gates men's→M, women's→F, **mixed/open on nobody**
— so X/blank players play everything except single-gender brackets. No schema
change, no hard requirement.

Typecheck + lint clean; app smoke-tested (loads with the listener mounted, no
console errors). The login-prompt path itself needs a real sign-in transition to
exercise (couldn't repro in preview without creds). Branch
`feat/profile-onboarding-prompt`. **Merged (#367) + promoted to production**
(PR #369, `2178e33`). 🔜 Ron: sign in with a
fresh (profileless) account → should land on the Welcome profile screen with an
"I'll do this later" option.

## 2026-06-17 — Fix: Register no longer bounces signed-in users to /login (PR #365)

A signed-in user with no player profile yet (`me === null`) clicked Register on a
public tournament and got sent to `/login` — looked like Register logs you out.
`onNeedsAuth` in `PublicTournamentPage` always went to `/login`; now: authed but
no profile → `/profile?return=<tournament>` (mirrors RequireProfile's
`?return=` convention), anonymous → `/login` as before. Surfaced by the new
signup flows landing users on home without forcing a profile first. Typecheck
clean (lint hits are pre-existing, not mine); couldn't repro live in preview
(needs an authed-no-profile session + a published tournament). Branch
`fix/register-no-profile-bounce`. 🔜 Ron: merge #365 + promote; re-test Register
while signed in without a profile → should land on /profile, then back.

## 2026-06-17 — Fix: non-admins no longer land on /admin (PR #363)

After a password reset (and signup / magic-link — all default to `/admin`), a
signed-in user with **no org membership and not a platform admin** was stranded
on `AdminIndexPage`'s "No organizations" screen. Root fix at that chokepoint:
zero orgs + not platform admin → `navigate("/")` (public home). Catches every
post-auth path to `/admin`, not just reset. Organizers (members / platform
admins) unaffected — they still get the picker / single-org auto-redirect.
Typecheck + lint clean; full E2E needs a real signed-in non-admin (couldn't
repro in preview without creds). **Merged (#363) + promoted to production**
(PR #364, `df1f2ec`). 🔜 Ron: re-test the reset link → should land on home, not
/admin.

## 2026-06-17 — Branded auth-email links (no more supabase.co) — PR #361

Auth email links pointed at `wducsjqyoksmluwfgjxc.supabase.co/auth/v1/verify…`
— a stranger's domain that reads as phishing/spam (Resend SMTP does NOT fix this;
SMTP is delivery, the link is Supabase's). Chose the free branded-route fix
(Option A) over the paid Supabase custom-domain add-on.

- All 3 templates now link to `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=<t>&next={{ .RedirectTo }}`
  (`<t>` = signup / magiclink / recovery).
- New `web/src/pages/public/AuthConfirmPage.tsx` (`/auth/confirm`) runs
  `supabase.auth.verifyOtp({ type, token_hash })` → forwards to `next`
  (same-origin sanitized; recovery → `/reset-password?recovery=1`).
  `ResetPasswordPage` honors that flag alongside the implicit-flow hash.
- `{{ .SiteURL }}` resolves per project, so prod links use `bertanderne.com`,
  test uses `test.bertanderne.com` — **each project's Site URL must be correct.**
- Verified in preview: missing-params + invalid-token error states round-trip
  against Supabase; route wired. Couldn't test a *valid* token locally (needs a
  real email) — **the live test-send is the real check.** Typecheck + lint clean.
  Branch `feat/branded-auth-links`.

**Merged (#361) + promoted to production** (PR #362, `695541f`) — `/auth/confirm`
now live in prod. 🔜 Ron (dashboard): re-paste the 3 updated templates into both
Supabase projects → send a real test of each (signup, magic, reset) and confirm
the link shows bertanderne.com AND the click actually signs you in / resets. If a
click shows "Couldn't confirm this link," suspect a stale token or a wrong project
**Site URL**.

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
Forgot); typecheck + lint clean. **Merged (#359) + promoted to production**
(PR #360, `df07b5c`) — UI-only. The /getting-started → signup flow is now clean
end to end in prod.

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
