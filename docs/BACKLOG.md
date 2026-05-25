# Backlog

Living list of what's next, organized by how soon we're likely to pull it. Each item is one or more **user stories** in the canonical *"As a X, I want Y, so that Z"* form. Items with multiple stakeholders carry multiple stories.

Update as we go — move items between sections, drop them under "Recently shipped" when they land, prune that section when it gets long.

Last updated: **2026-05-25**

> **In flight:** Register-then-Checkout flow (the mockup at `mockups/register-then-checkout-flow.html` is being implemented).

### Personas
- **Player** — registers and competes
- **Organizer** — runs a tournament, owns or admins an org
- **Visitor** — unauthenticated browser, may or may not become a player
- **Spectator** — watches a tournament without registering
- **Developer** — internal QA / load-testing role

---

## Next up

Things actively queued — the next handful of commits.

### F1. "I need a partner" registration option
- **As a Player** who wants to play a doubles event but doesn't have a partner yet, I want to register as "seeking a partner," **so that** I can lock in my spot before someone else fills it and find a partner later.

**Touches:** enum migration (add `'seeking'` to `partner_status`), `RegisterPage` event row, validation.

### F2. Admin view of partner seekers
- **As an Organizer**, I want a list of players who registered as seekers for each event with their contact info, **so that** I can match them up offline or follow up with the ones still unpaired close to event start.

**Touches:** `AttendeesPage` (or `EventConsolePage`), filter on `partner_status='seeking'`.

### F3. Hide already-registered players from partner search
- **As a Player**, I want the partner search to exclude anyone who's already registered for the same event (whether confirmed or pending), **so that** I don't waste a click on someone who can't accept anyway and so the invitee doesn't get a confusing "you've been invited" banner when they're already in.

**Touches:** `PartnerSearch` — accept an `eventId` prop and filter results by a subquery joined to `event_registrations`. Easiest path: have the parent compute the registered-player-ids for the event and pass them in via the existing `excludePlayerIds` array (we already use it to keep the user from picking themselves). Applies to BOTH the existing `/register` page AND the new inline-expand register on the tournament page (PR #3) — both should plumb the same filter.

### Clarify partner-search rating label
- **As a Player** picking a partner, I want their rating to render as "3.0 doubles" (or similar) instead of "3 doubles", **so that** I can't misread it as "registered for 3 doubles events" — the current format is genuinely ambiguous.

**Touches:** `formatPlayerMeta` in `web/src/components/PartnerSearch.tsx` (line ~343). One-line fix: format the numeric rating with `.toFixed(1)` so it always shows a decimal, OR change the separator (e.g. "Doubles 3.0" or "3.0 ★ doubles"). Cheap win — should ship in a small commit on its own.

---

## Soon

Known work that's not next-next but is on the radar.

### Stripe Connect onboarding (organizer side)
- **As an Organizer**, I want to connect my Stripe account through a guided onboarding flow, **so that** registration fees flow directly into my account minus the platform's cut, with no manual reconciliation.

**Touches:** `/admin/:org/settings/stripe` page, Stripe-hosted onboarding redirect, `supabase/functions/stripe-webhook/` Edge Function, `organizations.stripe_account_status` updates. Blocks paid registration; registrations currently save with `status='paid'` as a placeholder.

### Real payment flow on registration
- **As a Player**, I want to pay for my registrations with a credit card at the point of signup, **so that** my spot is locked in immediately and the organizer doesn't have to chase me for money.

**Touches:** `RegisterPage` submit, Stripe `PaymentIntent` with `application_fee_amount` (platform cut) + `transfer_data.destination` (organizer's connected account). Depends on Stripe Connect onboarding landing first.

### Roster view for organizers
- **As an Organizer**, I want a complete roster per event showing all confirmed teams with contact info, partner pairings, and payment status, **so that** I can run the tournament without flipping between admin pages.

**Touches:** expansion of `AttendeesPage` — likely a per-event filter + grouped layout.

### Withdraw / refund flow once payments are real
- **As a Player**, I want to withdraw from an event and automatically receive a refund if I'm within the refund window, **so that** I'm not punished for schedule changes I made in good faith.
- **As an Organizer**, I want late withdrawals (outside the refund window) to require my approval, **so that** I can handle hardship cases without auto-refunding everyone who flakes the night before.

**Touches:** Withdraw currently soft-deletes the registration with no payment side effect. After Stripe lands, hook into the Stripe Refunds API; add a `refund_requested` state for the out-of-window path.

### Pending invite count on the homepage
- **As a Player**, I want to see at a glance from the site homepage if I have any pending partner invites anywhere, **so that** I don't have to remember which tournament to visit to find them.

**Touches:** `HomePage` — chip or banner driven by the same query the tournament page already uses, scoped to invitee_player_id = me.

### Partner-change UX polish
- **As a Player** changing my doubles partner, I want a clear "Find a new partner" button on my current partner's chip and an undo affordance after I clear them, **so that** swapping is one obvious gesture and I can recover from a misclick without leaving the page.

**Touches:** `PartnerSearch` chip render (add inline button next to ×), `ChangeSummary` banner (per-row undo).

### Pricing copy refinement: "entry fee includes one event"
- **As an Organizer**, I want the pricing form to be framed as "tournament entry fee (includes one event) + each additional event" instead of "first-event fee + additional-event fee," **so that** the model matches how I describe it to players ("$60 to enter, $20 each extra event").
- **As a Player**, I want the running total breakdown to read "Entry + 2 extra events" rather than "1 first + 2 additional," **so that** the line items match how I think about what I'm paying for.

**Touches:** Copy changes only in `TournamentFormPage`, `PublicTournamentPage`, `RegisterPage`. The underlying math (D) already produces the right numbers — this is reframing labels so the model maps cleanly to PickleballBrackets-style "entry + additional" mental models. Verify with side-by-side examples before shipping.

### Shopping-cart registration model (mockup first)
- **As a Player** picking multiple events across one or more visits, I want to add events to a cart and confirm payment at a single checkout step, **so that** my picks aren't half-saved if I bail out partway and so I can review the full bill before committing money.
- **As an Organizer**, I want abandoned-cart visibility, **so that** I can see which players started registering but didn't finish and follow up if I want.

**Touches:** Significant rethink of the current "click Confirm → everything writes atomically" flow. **First step is an HTML mockup** to land on shape before touching code. Open questions: do existing event_registrations rows exist while in the cart (with `status='cart'`?) or only after checkout? How does the cart survive a sign-out / session expiry? Does Stripe Connect onboarding sequencing change? Worth a design pass before any code.

### Tournament lifecycle statuses + early-bird / late pricing windows
- **As an Organizer**, I want my tournament's status to walk through the real lifecycle — *Scheduled* (announced but registration not open) → *Early Bird Registration Open* → *Registration Open* → *Late Registration Open* → *Registration Closed* → *Running* → *Completed* — **so that** pricing tiers, public visibility, and admin controls shift automatically at each stage instead of me flipping flags manually.
- **As a Player**, I want to see at a glance which registration window is currently active and when the next deadline hits ("Early bird ends in 4 days," "Late registration opens Friday"), **so that** I know whether to sign up now, wait, or hurry.

**Touches:** `tournament_status` enum gets new values (currently `draft / published / closed / completed`); existing `published` likely splits into the three open-registration variants. Schema probably also gains `early_bird_ends_at`, `late_starts_at`, plus optional pricing modifiers (early-bird discount or late-fee surcharge as offsets on top of the base entry / additional fees). Public tournament page + admin status controls need to render the broader state machine. Probably also a scheduled job (or RLS-side computed status) to auto-advance based on the date columns so the admin doesn't have to click through stages.

**Open question:** are the new statuses a true enum (organizer manages explicitly) or are they DERIVED from date columns + a smaller status enum? Derived is less error-prone but harder to override for one-off cases ("registration closed early because we sold out"). Worth a design pass before the migration.

### Social-proof / momentum signals on the public pages
- **As a Player** browsing tournaments, I want quiet, honest signals that an event has momentum ("14 players registered this week" / "3 spots left in Womens 3.5"), **so that** I know when to register now vs. wait without being manipulated by fake "8 people viewing right now" theater.
- **As an Organizer**, I want the momentum signals to reflect REAL data from my tournament's own registration history, **so that** they're trustworthy long-term and don't quietly turn into noise.

**Touches:** Public tournament page header gets a small chip row driven by aggregates over `event_registrations` (last 7 days, capacity %). Per-event "X spots left" badge only when capacity is under ~30% so the signal stays meaningful. No live-presence infrastructure — pure historical counts. Mocked in `mockups/register-then-checkout-flow.html`.

**Threshold rules (no zero-state shouting):**
- "X players registered this week" chip only renders when ≥5 players registered in the last 7 days.
- "Filling fast" chip only renders when the tournament as a whole is ≥30% full.
- Per-event "X spots left" badge only when the event is ≥30% full *and* has fewer than ~5 spots remaining.
- New / sparse tournaments show no chips at all — page looks clean rather than broadcasting low activity.

**RLS hurdle to solve before building.** The public tournament page is anon-readable, but `event_registrations` RLS limits SELECTs to the owning player or org members — anon visitors can't count other people's regs. Resolution: add a SECURITY DEFINER RPC `get_tournament_stats(tournament_id)` that returns aggregate counts (no PII — just totals + per-event counts + spots-left math). Page fetches the stats alongside the tournament + events.

### Register-then-Checkout flow (separate registration from payment)
- **As a Player**, I want to register for an event right when I see it (one click instead of "add to cart" semantics), and pay later when I'm done browsing — **so that** the act of committing to an event feels distinct from the act of paying for it, and my partner gets locked in before anyone else can grab them.
- **As an Organizer**, I want pending-payment registrations to be visible in my admin views (with a "pending" pill), **so that** I can see who's about to commit and plan capacity accordingly.

**Touches:** Significant flow rewrite. New `pending_payment` status on `event_registrations` (probably already in the enum). Capacity counts include pending. Background cleanup job auto-cancels pending regs that have been idle ~30 min. Partner invites fire at checkout, not at register. Persistent bottom bar across the app surfaces pending count + total + Check-out CTA. Mocked in `mockups/register-then-checkout-flow.html`.

**Hold UX is silent.** No countdown timer shown to the user — anxiety belongs to the system, not the player. If a hold gets released, the checkout page explains it in calm language and offers re-register / waitlist recovery.

**Open question:** do we ship this as a replacement for the current "click Confirm → atomic" register flow, or layer it in alongside? Replacement is cleaner code but a meaningful UX shift for existing users.

### Coupon codes at checkout
- **As a Player**, I want to enter a coupon code on the checkout page and see the discount applied before I pay, **so that** I get the price I was promised by the organizer / email / club newsletter.
- **As an Organizer**, I want to create one-off and reusable coupon codes (fixed amount, percentage, or "free entry") with expiry dates and usage caps, **so that** I can run early-bird incentives, club-member discounts, and comp codes without spreadsheet juggling.

**Touches:** New `coupons` table (code, kind, value, expires_at, max_uses, uses_count, organization_id or tournament_id scope). Checkout page gets a "Have a code?" input that calls a `validate_coupon` RPC and shows the discount in the order summary. Stripe `PaymentIntent` adjusted by the discount. Admin gets a coupons CRUD page under the tournament settings. Audit trail per use so organizers can see who redeemed what.

**Open question:** scope — org-level coupons usable across that org's tournaments, or strictly per-tournament? Probably per-tournament for v1; cross-tournament codes can come later if anyone asks. Also: do coupons stack with the additional-event discount (D)? Default no — coupon applies to the *post-tier* total.

### Custom domains for organizations
- **As an Organizer**, I want my tournament pages to live at my own domain (e.g. `tournaments.whitemountainpickleball.com`) instead of `tournament-manager.pages.dev/t/wmpc/...`, **so that** players see my brand consistently and the URL itself builds trust.
- **As a Player** visiting an organizer's custom domain, I want the tournament list / detail / registration pages to work identically to the canonical paths, **so that** the experience is the same no matter how I arrived.

**Touches:** DNS (organizer points a CNAME at our hosting). Multi-tenant routing in the SPA — detect the request host, resolve to an `organizations.custom_domain` row, treat the page as if `:orgSlug` were implicit. Schema adds `organizations.custom_domain` (citext, unique) and probably `organizations.custom_domain_verified_at`. Public routes (`/`, `/t/:org/...`) collapse the org segment from the path when served on a custom domain — `/wmpc-classic/register` instead of `/t/wmpc/wmpc-classic/register`. Admin routes stay on the canonical host (`tournament-manager.pages.dev/admin/...`) so cross-org admins don't get confused.

**Open question:** Cloudflare Pages supports a fixed set of custom domains per project — fine for a handful of orgs, but we'd need to script the per-org domain attach (Cloudflare API) when an organizer onboards. Worth checking the upper limit before promising it. Alternative: Cloudflare for SaaS (custom hostname API), which is purpose-built for this and scales to thousands of tenants. Probably want to evaluate the SaaS path before shipping.

### Add GameID to scorecards + Court Manager search
- **As a Referee or Organizer**, I want a short, unique GameID printed on every scorecard, **so that** I can match a paper card back to the right match when I'm entering scores.
- **As an Organizer**, I want to search the Court Manager by GameID, **so that** when a referee hands me a scorecard I can jump straight to the right match instead of scrolling.

**Touches:** `matches` table probably already has a UUID; we need to add (or derive) a short human-friendly id (e.g. first 6 chars, base32, or a per-tournament sequence). `ScorecardsPage` adds the id to the printed layout; `CourtManagerPage` gets a search input that resolves to a match.

---

## Later

Bigger themes, not committed to. Listed so we don't forget them, not in any particular order.

### Bracket / scoring improvements
- **As an Organizer**, I want brackets seeded automatically from player ratings, **so that** strong teams don't meet in the first round and the bracket is competitive end-to-end.
- **As an Organizer**, I want tiebreak rules (head-to-head, point differential) surfaced in the admin and applied automatically, **so that** rankings are defensible without me doing spreadsheet math.
- **As a Spectator**, I want a live standings page that updates as scores are entered, **so that** I can follow the tournament without being at the venue.

### Communications
- **As a Player**, I want reminder emails for registration confirmation, schedule posted, and "your match is up," **so that** I don't miss anything important.
- **As an Organizer**, I want an audit trail of every message sent on my tournament's behalf, **so that** I can confirm whether a player was actually notified before issuing a refund or DQ.

**Touches:** Edge Function per notification type, `communications` table for the audit log.

### Waitlists
- **As a Player** registering for a full event, I want to join a waitlist instead of being rejected, **so that** I get my spot if a withdrawal opens up.
- **As an Organizer**, I want auto-promotion from the waitlist when a registered player withdraws, **so that** I don't have to manually invite the next person.

**Touches:** `event_registrations` gets a `waitlist_position` column or similar; promotion logic in the withdraw path.

### Player profiles
- **As a Player**, I want a public profile page showing my tournament history and rating progression, **so that** potential partners can see my level and I have a single link to share.

**Touches:** new `/players/:id` route, RLS to expose match results + rating snapshots; cross-tournament value once we have multiple orgs running.

### Multi-org admin UX
- **As an Organizer** who staffs multiple orgs, I want a quick org-switcher in the sidebar header, **so that** I can hop between tournaments without bouncing through the `/admin` picker every time.

**Touches:** `AdminLayout` sidebar header, `useCurrentOrg` to expose all my memberships, a small popover/select.

### Public homepage filtering
- **As a Player** browsing for tournaments, I want filters for location radius, organizer, date range, and skill level, **so that** I find relevant tournaments quickly as volumes grow.

**Touches:** `HomePage` — additional filter inputs + matching client-side or server-side filter logic.

### Mobile polish
- **As a Player using my phone**, I want every screen to be usable on a small viewport with thumb-friendly controls, **so that** I can register, accept invites, and check my schedule on the go without pinch-zooming.

**Touches:** every page; first pass is a sidebar collapse for `AdminLayout`, then a bottom-sheet pattern for the partner picker, then table-to-card transformations on the bulk-edit screens.

### Test-account expansion
- **As a Developer**, I want a tool that seeds N filled teams into an event and can drive automated matches, **so that** I can stress-test schedule generation, bracket logic, and live scoring without hours of manual clicking.

**Touches:** `tools/seed-event` already covers the "fill an event" half; the match-driving half needs a new tool that walks a generated schedule and writes scores via the existing RPC.

---

## To explore

Topics worth a conversation before committing to build, organized in case any of them turn out to be the right next thing.

### PickleballBrackets feature audit (setup + dashboard)
Two reference screenshots from PickleballBrackets — sketches of the setup-wizard steps and the per-tournament admin dashboard. None of these are committed work; the goal is to walk through what they offer, decide which match our model, which are MVP-relevant for WMPC, and which we'd never build.

**Setup wizard steps** (their order):
1. **Tourney Info** — we have (`TournamentFormPage`)
2. **Registration Cost** — we have (D shipped)
3. **Checkout Options** — *don't have.* Cash / check / Stripe per tournament? Deposits vs. full payment?
4. **Logo & Files** — *don't have.* Tournament-level branding / waivers / rule docs
5. **Discount Codes** — *don't have.* Promo codes, early-bird, club-member rates
6. **Sponsors** — *don't have.* Logo/text blocks on the public page
7. **Payment Method** — *partially* via the planned Stripe Connect work
8. **Venues** — *don't have a model for it.* Multi-venue tournaments; per-event venue assignment
9. **Amenities** — *don't have.* "What's at this venue" (showers, parking, food)
10. **Managers** — we have (`organization_members`)
11. **Overview** — we have (`TournamentDetailPage`)

**Dashboard items** (their organization):
- **View Tourney** — public page (we have)
- **Events** — we have
- **User Defined** — custom fields on registration (waivers, t-shirt size). *Don't have.*
- **Sanctioned / Approved & Ratings** — integration with rating bodies (DUPR, USAP, UTPR). *Don't have, but `rating_source` enum is already in place.*
- **Attendees** — we have
- **Attendees in Multiple Events** — filter / report. *Don't have.*
- **Simulator** — RR estimator (we have at `tools/round-robin`)
- **Referees** — assign refs to courts / matches. *Don't have.*
- **Volunteers** — non-playing helpers. *Don't have.*
- **Completed Event Matches** — match history view. *Partial — exists inside `EventConsole`.*
- **Messages** — in-app messaging to registrants. *Don't have.*
- **Edit Scores** — we have (in `EventConsole`)
- **Limit Registration by Territory** — geographic restrictions. *Don't have.*
- **Reports** — exportable summaries (financial, attendance). *Don't have.*
- **FAQs** — tournament-specific Q&A. *Don't have.*
- **Link Tourney** — link to another related tournament. *Don't have.*
- **PT Perks** — vendor / member benefits. *Don't have, probably never.*

Use this section as a checklist when discussing what to promote into Soon / Next up.

---

## Recently shipped

Trailing log of what landed, so the doc stays grounded. Prune entries older than ~4 weeks.

### 2026-05-25 (PR [#2](https://github.com/notronwest/tournament-manager/pull/2) — 3 commits)
- **D. First-event + additional-event pricing** — `tournaments.additional_event_fee_cents` migration, per-event override semantics, shared pricing helper (`web/src/lib/pricing.ts`), admin form gets both fee fields, public tournament page shows tiered prices, register page shows per-event price + running total

### 2026-05-23 (PR [#1](https://github.com/notronwest/tournament-manager/pull/1) — 26 commits)
- Public tournament page (`/t/:org/:slug`) — anon-readable, eligibility chips, per-event Register buttons
- Public homepage (`/`) — upcoming tournaments + search
- Registration flow with auto-pair, partner search, profile-first-fill
- Partner accept page with inviter contact info for verification
- RegisterPage as an edit page — pre-checked existing regs, uncheck-to-withdraw, change partner inline, diff summary, gated Confirm
- Partner-change side effects: cancel old invite, soft-delete dropped partner's reg, email the dropped partner (`send-partner-cancellation` Edge Function)
- Inbound pending invites surfaced on the tournament page as a banner + per-card pill
- Sign-up flow rebuilt around magic link → confirm → profile + optional password → land on register page
- Global `SiteHeader` banner (Sign in / Profile / Admin / Sign out)
- Edit Tournament page (rolled `CreateTournamentPage` into a mode-based `TournamentFormPage`)
- Bulk events edit at `/admin/:org/tournaments/:slug/events/edit` — table view, dirty-tracked per-row saves
- Test players tool — seeds 20 fake auth users via Edge Function, admin "Sign in as" with Switch-back via stashed session
- Cancel buttons on every form
- Fixed "Cannot coerce..." doubles-registration bug (PartnerSearch was zero-initializing drafts)
- Skip email send for obviously-fake addresses with a calm "TEST ACCOUNT" badge

---

## Conventions for this doc

- **Sections are by urgency, not date.** Items move *between* sections as priorities shift.
- **Each item is one or more user stories** in *"As a X, I want Y, so that Z"* form. Multiple stakeholders → multiple stories. The story is the contract; the "Touches:" line is the implementation hint.
- **When an item ships,** move it to "Recently shipped" with a date + PR link if there is one. Keep that section trimmed — long-tail history belongs in `git log`, not here.
- **Don't track tasks here that are already in flight.** Use the harness's task tools for sub-day work. This doc is for the *next* thing.
