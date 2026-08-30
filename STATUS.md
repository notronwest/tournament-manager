# Status — tournament-manager

Append-only session handoff log. **Read this first; append a dated entry
before you wrap.** Newest on top; new entries supersede old — don't rewrite.
Entries before 2026-08-15 were moved to [`STATUS-ARCHIVE.md`](./STATUS-ARCHIVE.md)
on 2026-08-27 to keep this lean; nothing was lost.

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
