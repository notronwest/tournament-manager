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

### Clarify partner-search rating label (richer format)
- **As a Player** picking a partner, I want their rating to render as something like **"3.0 Men · Doubles (self-rated)"** or **"3.5 Women · Mixed (DUPR)"** — decimal forced, player's gender included, rating source called out — **so that** "3 doubles" doesn't read as "3 doubles events" and so I can tell at a glance whether the rating I'm trusting came from DUPR or the player's self-report.

**Touches:** `formatPlayerMeta` in `web/src/components/PartnerSearch.tsx`. The PR-#4 fix added `.toFixed(1)` (covers the decimal part); this item completes the format by also surfacing gender + rating source. Source comes from `player_ratings.rating_source` once we wire DUPR (separate item below); for now we have `self_rating_*` so the source is always "self-rated."

### Allow players to connect their DUPR ID
- **As a Player**, I want to enter my DUPR ID on my profile and have my DUPR ratings pulled in automatically, **so that** organizers and partners can trust the number, and so my rating updates over time without me re-entering it.
- **As an Organizer** running a competitive division, I want to require a DUPR-verified rating for some events (see the "Play up / Require DUPR" item), **so that** the bracket isn't gameable.

**Touches:** Schema — `players.dupr_id text` (validated format) + maybe `players.dupr_last_synced_at`. `player_ratings` already has a `rating_source` enum with `'dupr'` as one option, so per-source rating history is already modeled. New Edge Function `sync-dupr-ratings` polls DUPR's API on a schedule (per player or batched) and inserts fresh `player_ratings` rows. Profile form gets a "Connect DUPR" field. Display layer (`formatPlayerMeta`, event cards) prefers DUPR over self-rated when present.

**Open question:** does DUPR offer a public/free API or do we need an organizer-side API key? Affects whether the sync is per-player auth or one-shop key.

### Always show DUPR rating when a player has connected
- **As a Player** browsing partners or viewing my own profile, I want a DUPR-connected player's rating to always display as their DUPR rating (with the source labeled), **so that** the verified number is the one I see and decisions are made on consistent data.

**Touches:** `formatPlayerMeta` + any other place we render ratings (event eligibility chips, attendees lists, future player profile pages). Single source-of-truth precedence rule: DUPR rating from `player_ratings` table wins over `self_rating_*` on the player row when both exist. Document this rule somewhere durable so we don't accidentally re-introduce the override.

**Depends on:** "Allow players to connect DUPR ID" landing first.

### Cancelling a registration with a picked partner needs a confirm step
- **As a Player** about to cancel a pending registration that has a partner picked, I want a clear "are you sure?" confirmation step **so that** a misclick doesn't quietly drop my partner pick along with my registration. ABSOLUTELY NOT a `window.confirm` dialog — use the existing `ConfirmModal` component.

**Touches:** EventCard's pending-state Cancel handler in `PublicTournamentPage.tsx` and the equivalent on the `/checkout` and `/register` pages. Wrap each in a `ConfirmModal` ("Cancel registration and drop Jane Davis as your partner?"). For seeker-state regs (no partner picked) the confirm is optional — the action is less consequential.

### "Partner won't be notified until checkout" copy on the register form
- **As a Player** registering with a partner picked, I want a clear note on the register form that **my partner will not be emailed until I check out**, **so that** I don't assume they got pinged the moment I clicked Register and wonder why they haven't responded.

**Touches:** The EventCard expanded register form already has copy reading "We won't email them until you check out." That copy is too quiet — bump to a more visible callout. Same callout should appear on the bottom of the success/done view after the inline register lands, so the user knows the partner is still in the dark until they hit Pay.

### Partner accepting an invite enters their own checkout flow
- **As a Player** accepting a partner invite for an event, I want my registration to start in `pending_payment` and go through MY OWN checkout, **so that** each player on the team pays their own registration fee — that's how PickleballBrackets works and matches what tournament directors expect.
- **As an Organizer**, I want both players on a doubles team to pay their own way, **so that** I'm not chasing one player to collect for two.

**Touches:** `PartnerAcceptPage`'s onAccept handler currently inserts the invitee's reg with `status='paid'` (legacy from before register-then-checkout). Change to `status='pending_payment'`, then the global `PendingPaymentsBar` will surface it for the new player and walk them through checkout. The `accept_partner_invite` RPC already tolerates any reg status when linking, so the change is purely on the client side of the accept page.

**Open question:** when the invitee declines, should the inviter be notified? Currently no — the invite just goes 'declined'. Probably worth surfacing on the inviter's tournament page so they can pick someone else.

### Pricing model misconfiguration is easy to make (clarify in admin form)
- **As an Organizer** setting up tournament + event fees, I want the admin form to make clear that `events.event_fee_cents` is a **per-event flat OVERRIDE**, not a per-event surcharge added on top of the tournament's entry fee, **so that** I don't accidentally set up "Tournament $60, each event $20" expecting 1 event = $80 when it actually means 1 event = $20.

**Touches:** `EventFormPage` event-fee field needs an explicit "Leave at 0 to use the tournament's first/additional pricing. Set a value to override with a flat fee that ignores the tournament tiers." hint. Maybe a "Preview math: 1 event = $X, 2 events = $Y" widget at the bottom of the tournament form showing the expected total at common counts so the organizer can spot misconfiguration before publishing.

**Background:** Reported as a "bug" but the math is doing what D specifies. The confusion is the model itself reads two ways. The "Pricing copy refinement" item in Soon addresses the player-facing labels; this item is the organizer-facing equivalent.

### Enforce event eligibility (rating + gender) at registration
- **As an Organizer**, I want a player to be blocked from registering for an event whose rating / gender requirements they don't meet, **so that** my brackets don't show up race-day with the wrong people in them.
- **As a Player** trying to register for an event I'm not eligible for, I want a clear "you're not eligible for this event" message that names the specific gate I'm missing (rating range / gender), **so that** I understand why and can pick a different event or update my profile if it's outdated.

**Touches:** Today we render `eligibilityChips` as a *display* signal but don't actually enforce eligibility at insert time — a determined player could submit anyway. Add a check in the inline-register submit handler on `PublicTournamentPage` AND in the legacy `RegisterPage` submit. The right server-side enforcement is a SECURITY DEFINER RPC or an `event_registrations` BEFORE INSERT trigger that compares the player's `gender` + `self_rating_*` against the event's `min_rating` / `max_rating` / `gender`; the client check is for UX, the server check is for trust.

**Open question:** which rating field counts toward the gate — doubles, mixed, or singles? Probably matches the event format (doubles event → `self_rating_doubles`). Document the rule explicitly in the touches when we build.

### "Play up" + "Require DUPR" event flags
- **As an Organizer**, I want to optionally let players register *above* their rating ("play up" allowed: a 3.5 can play in the 4.0 division), **so that** my brackets aren't stuck with empty slots when players want a harder match.
- **As an Organizer**, I want to optionally require a verified DUPR rating (vs. self-reported) for some events, **so that** competitive divisions are gated on something more reliable than the honor system.

**Touches:**
- Schema: `events.allow_play_up boolean default false`, `events.require_dupr boolean default false` (or `events.required_rating_source` enum that includes 'dupr'). Migration + types regen.
- Admin: `EventFormPage` exposes both toggles with hover-hints.
- Eligibility logic: when `allow_play_up` is true, the `min_rating` check still applies but the `max_rating` is treated as a target rather than a hard cap. When `require_dupr` is true, only DUPR-source `player_ratings` count toward the gate — `self_rating_*` is ignored.
- Display: the event card shows "Play-up welcome" / "DUPR required" badges so players know before clicking Register.

**Depends on:** the eligibility-enforcement item above lands first — these are configuration knobs on a check that doesn't exist yet.

### Replace mode-toggle buttons with a real segmented control
- **As a Player** seeing the "Pick a partner / I need a partner" toggle on the inline register form, I want it to look like a selection control (pill / radio / tab style), **so that** I don't read it as "two actions I might take" — it's currently styled as two buttons that confusingly toggle hidden UI when clicked.

**Touches:** The toggle in `PublicTournamentPage.tsx`'s EventCard expanded form (built with `partnerModeBtnStyle`) — semantically it's already `role="radio"` inside a `role="radiogroup"`, but the visuals say "button." Replace with a real segmented control or a radio-list pattern (visible radio dots + label rows). Same fix anywhere else we have buttons that toggle hidden UI rather than performing an action — audit and replace.

**Principle being established:** buttons are for actions. Selections that drive what's visible should look like selections (radios, segments, tabs). Worth a one-time pattern pass + a small note in `docs/DESIGN_PREFERENCES.md` so the rule lives somewhere durable.

### Lock pricing once anyone is registered
- **As an Organizer**, I want tournament + event pricing fields to lock the moment the first paid (or pending_payment) registration lands, **so that** I can't accidentally change what a player has already committed to and create a refund mess.

**Touches:** `TournamentFormPage` + `EventFormPage` render pricing fields read-only when active regs exist, with explanatory copy ("3 players registered — pricing is locked. Cancel + refund affected players from the attendees view first."). Server-side guard via RPC or trigger so a stale browser tab can't sneak through. Small / defensive. See scenario E3 in `docs/scenarios/tournament-lifecycle.md`.

### Clone a tournament from a prior year
- **As an Organizer** running the same tournament I ran last year, I want a "Clone tournament" action that copies everything (events with their formats / ratings / capacities / fees, description, sponsors, FAQs, branding) into a fresh draft tournament, **so that** I'm reviewing-and-adjusting instead of entering it all over again.

**Touches:** Button on `TournamentDetailPage` (and / or `TournamentsListPage`). Server-side: an RPC that deep-copies the tournament row + its events + sponsor / FAQ rows into a new tournament with `status='draft'` and dates left blank. After clone, route the user into the new tournament's edit form (or the upcoming creation wizard's review step) with everything pre-filled. See scenario C1 in `docs/scenarios/tournament-lifecycle.md`.

### Org-level default venue (and other org settings)
- **As an Organizer** running multiple tournaments at the same venue, I want my organization to have a saved default venue / location that pre-fills on every new tournament I create, **so that** I'm not re-typing "WMPC Indoor Courts" for the tenth time and can change it per-tournament when needed.

**Touches:** New columns on `organizations` (`default_venue_name text`, `default_venue_address text` — keep it flat for v1; a multi-venue `venues` table is a follow-up if/when clubs need it). New "Organization settings" admin page (or section on a future Org Overview). Wizard's Basics step pre-fills the location field from these and offers a "Save this as my org's default for future tournaments" checkbox so a first-time tournament writes the default back. Same hook is useful for org-wide settings down the line (default event template, default cancellation policy preset).

### Creation wizard: friendly off-ramps + default event template
- **As a first-time Organizer**, I want tournament creation to be a multi-step wizard with explicit "Skip / I'll do this later" affordances and inline "what does this mean?" hints, **so that** I can build a publishable tournament without needing to understand every term up front.
- **As an experienced Organizer**, I want the wizard's Events step to come pre-populated with a sensible default set of divisions (typical club bracket: Mens / Womens / Mixed across 3.0 / 3.5 / 4.0 / 4.5) with **checkboxes** to include/exclude each one, **so that** I'm un-checking and adjusting instead of entering twelve events from scratch.

**Touches:** Big-rock item. Replaces the create-mode of `TournamentFormPage` with a wizard component. **Per-step URLs** (`/admin/:org/tournaments/new/basics` → `/events` → `/pricing` → ...) so refresh and bookmarks work. Tournament lands in `status='draft'` after step 1; Save & exit returns to Tournaments list and re-entering resumes at the next unfinished step. Per-event Edit is inline expand on the row (matches the public-flow register pattern, no modal-soup). See scenarios C2 + C3 + C4 in `docs/scenarios/tournament-lifecycle.md` and the mockup at `mockups/tournament-creation-flow.html`.

**Minimum-to-publish (decided):**
- **Hard-required** (Publish button stays disabled until met): name, start + end date, location, ≥1 event checked, pricing decision made (any value including $0).
- **Soft-required** (Publish allowed but a confirm modal calls out gaps): cancellation policy, Stripe Connect.
- **Optional** (no nag): sponsors / branding, FAQs.

The Review step renders a status banner — "Ready to publish ✓" when hard-required is met, "Set N more things before you can publish" otherwise with a checklist.

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

### Withdraw / refund flow + admin-initiated tournament cancellation
- **As a Player**, I want to withdraw from an event and automatically receive a refund if I'm within the refund window, **so that** I'm not punished for schedule changes I made in good faith.
- **As an Organizer**, I want late withdrawals (outside the refund window) to require my approval, **so that** I can handle hardship cases without auto-refunding everyone who flakes the night before.
- **As an Organizer**, I want a strong-confirmation "Cancel tournament" action that bulk-refunds every registered player according to the tournament's pre-set Cancellation Policy and emails them all what happened, **so that** an emergency cancellation (venue falls through, weather) is one focused workflow instead of a manual day of cleanup.

**Touches:** Withdraw currently soft-deletes the registration with no payment side effect. After Stripe lands, hook into the Stripe Refunds API; both player-side withdraws and admin-side full-tournament cancellation consult the tournament's `cancellation_policy` (see separate item) to drive the refund math. Tournament cancellation lives behind a ConfirmModal with a reason field; status flips to `cancelled`; the public tournament page stays up with a "cancelled" banner so players have context. See scenario E6 in `docs/scenarios/tournament-lifecycle.md`.

### Pending invite count on the homepage
- **As a Player**, I want to see at a glance from the site homepage if I have any pending partner invites anywhere, **so that** I don't have to remember which tournament to visit to find them.

**Touches:** `HomePage` — chip or banner driven by the same query the tournament page already uses, scoped to invitee_player_id = me.

### Partner-change UX polish
- **As a Player** changing my doubles partner, I want a clear "Find a new partner" button on my current partner's chip and an undo affordance after I clear them, **so that** swapping is one obvious gesture and I can recover from a misclick without leaving the page.

**Touches:** `PartnerSearch` chip render (add inline button next to ×), `ChangeSummary` banner (per-row undo).

### Admin: drop or merge the Overview page
- **As an Organizer**, I want the admin sidebar to lead me straight to my Tournaments list instead of stopping at a near-empty "Overview" page, **so that** my landing experience reflects where the actual work lives.

**Touches:** `OrgOverviewPage` is currently the index route under `/admin/:orgSlug`. Two paths:
- **Drop it:** change the index route to render `TournamentsListPage` directly. Sidebar loses the "Overview" link; Tournaments becomes the implicit home.
- **Merge it:** keep the index route but make it Tournaments + a small org-context strip (member count, Stripe status, last-activity) at the top. Becomes a useful overview rather than a placeholder.

Decision rule: build org-wide stats / content first (members count, Stripe Connect status, recent activity across tournaments, payouts summary once Stripe lands). If that content materializes → keep Overview and add it. If we go a quarter without anything legit to put there → drop the page.

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

**Touches:** `matches` table probably already has a UUID; we need to add (or derive) a short human-friendly id (e.g. first 6 chars, base32, or a per-tournament sequence). `ScorecardsPage` adds the id to the printed layout; `CourtManagerPage` gets a search input that resolves to a match. **Also call out from R2 in the scenarios doc:** the Court Manager surfaces currently-running games inline so for most scorecards no search is needed — the GameID search is the fallback for everything else.

### Cancellation Policy as a creation-wizard step + enforcement everywhere
- **As a new Organizer**, I want to pick a Cancellation Policy from a few plain-English presets ("Generous: full refund up to 7 days before tournament" / "Standard: half refund within 30 days, none within 7" / "Strict: no refunds after registration") during creation, **so that** I have a defensible policy without having to invent one and so the system can enforce it automatically downstream.
- **As a Player** about to register, I want to see the cancellation policy on the public tournament page before I commit money, **so that** I understand the rules before I pay.

**Touches:** New `tournaments.cancellation_policy` storage (jsonb with `{ kind: 'preset' | 'custom', preset?: 'generous' | 'standard' | 'strict', custom?: { ... } }` or similar). Preset definitions live client-side. Wizard step renders the three presets as cards with their effective text + a Custom option. Public tournament page shows the policy text near the entry fee meta. The Withdraw / refund item above reads from this; the admin tournament-cancel flow same. See scenarios C5 + E6 in `docs/scenarios/tournament-lifecycle.md`.

### Common Tasks dashboard for the Editing surface
- **As an Organizer** mid-registration, I want the tournament edit screen to lead with a Common Tasks panel — quick-access tiles for the things I actually do (add sponsor, add FAQ, edit description, adjust capacity, email registrants) — **so that** I'm not re-walking the creation wizard every time I need to fix one small thing.
- **As an Organizer**, I want any task with downstream impact (touches registrations, pricing, dates, events) to carry a clear "this will affect N registered players" warning before save, **so that** I'm never surprised by what a save just did.

**Touches:** New surface for `/admin/:org/tournaments/:slug` once a tournament is published — leads with a Common Tasks panel above the existing event list. Each task tile opens a focused mini-form (not the full wizard). The full "Edit all settings" path stays reachable but secondary. Safe edits save silently; impactful edits flash a count-based warning first. See scenario E1 in `docs/scenarios/tournament-lifecycle.md`.

### Schedule estimator surface
- **As an Organizer** post-registration-close, I want a tool that takes my registrant counts + per-event format + total court count and proposes a time-and-court plan with auto-suggested court allocations, **so that** I'm not doing the schedule math by hand and so finalization (R1 lifecycle item below) starts from a sensible default.

**Touches:** Expansion of the existing `tools/round-robin` estimator. Inputs: tournament-wide court count, per-event format / registrant count. Output: per-event suggested court allocation + estimated duration, plus a tournament-wide timeline. Organizer accepts / adjusts; the output writes to per-event `court_count` + suggested `scheduled_start_at`. Advisory until finalization (event Lock step) locks it in. See scenario E4 in `docs/scenarios/tournament-lifecycle.md`.

### Player change-request admin queue
- **As a Player** with a registration issue (need to switch divisions, partner-change after the partner accepted, withdraw with a special-circumstance reason), I want to file a request that goes to the organizer instead of trying to self-serve, **so that** an admin handles the refund / bracket consequences correctly.
- **As an Organizer**, I want all incoming change-requests for my tournaments visible in one queue, **so that** I'm not hunting through email and can process them in batches.

**Touches:** New `tournament_change_requests` table (player_id, tournament_id, kind enum, payload jsonb, status enum, organizer_resolution). Player-side surface: a "Request a change" link in the manage-registration UI. Admin surface: a queue under the tournament admin (or org-level), one row per request, with quick-approve / quick-deny actions and a free-text reply. See scenario E5 in `docs/scenarios/tournament-lifecycle.md`.

### Expanded event lifecycle: ready_to_run → locked → planned → running → complete
- **As an Organizer** managing a published tournament with events, I want to manually mark events as "Ready to Run" (signaling registrants look right) and "Locked" (signaling N days out from the event — no more new regs or partner changes), **so that** the running phase begins from an intentional, finalized state.

**Touches:** Migration adds new values to `event_status` enum (`ready_to_run`, `locked`, `planned`). Two new manual-gate actions on the event admin UI. The "Lock" action freezes the registrant list and disables partner picker for that event. After Lock, a planning step assigns start times + courts (uses the Schedule estimator output as the starting draft). Auto-complete behavior at end of pool / each playoff round is its own item (R6, Later). See scenario R1 in `docs/scenarios/tournament-lifecycle.md`.

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

### Public standings page
- **As a Spectator or off-court Player**, I want a public URL I can hit on my phone to see the current standings + bracket state for an event that's running, **so that** I can follow along without needing access to the admin Court Manager.

**Touches:** New route `/t/:org/:slug/standings` (or per-event `/t/:org/:slug/events/:eventId/standings`). Anon-readable. Reads from `matches` + `event_registrations`; renders bracket / standings view. Auto-refresh as scores update. See scenario R4 in `docs/scenarios/tournament-lifecycle.md`.

### Event auto-complete at natural inflection points
- **As an Organizer** scoring matches throughout the day, I want events to auto-complete when their last match in a round (pool play, then each playoff round) is scored, **so that** I'm not hunting for a "mark complete" button on every event after every round.

**Touches:** Server-side detection (likely a trigger on `matches` inserts/updates) that flips event status to `complete` when (a) every pool-play match has a score, or (b) the championship match has a score. Intermediate "round complete" detection (semis done → finals can start) used to surface "next round ready" affordances in Court Manager. See scenario R6 in `docs/scenarios/tournament-lifecycle.md`. Depends on the event-lifecycle expansion item (Soon) landing first.

### No-show / forfeit flow (design pass needed)
- **As an Organizer** with a no-show player, I want a path that doesn't blindly hand the opponent the win — some kind of investigation step before the forfeit gets applied (try to reach the player, wait a grace period, then confirm) — **so that** mistakes aren't permanent and the bracket reflects reality.

**Touches:** Design TBD. Initial intuition: an explicit no-show action on a match starts a "pending forfeit" state with a configurable grace window (5 / 10 / 15 min?). Forfeit applies after grace unless cancelled. Records who marked it + when. Worth a focused design pass once the main Running mockup exists and we can see where this action would live in the flow. See scenario R3 in `docs/scenarios/tournament-lifecycle.md`.

### Multi-day tournament support
- **As an Organizer** running a 2-3 day tournament, I want events distributed across days with day-specific schedules + advancing-player communications, **so that** I'm not relying on people to know "you play Saturday, not Sunday."

**Touches:** Defer for v1 — design pending until we have a real multi-day tournament to design against. Likely overlaps with the "Communications" item: emailing advancing players is a notification design we'll do once and reuse. See scenario R5 in `docs/scenarios/tournament-lifecycle.md`.

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
- **Cross-cutting design decisions** (the *how we'll build everything in this area*) live below, not as backlog items. Items above assume these.

## Architectural directions in play

These came out of the scenario pass (`docs/scenarios/tournament-lifecycle.md`) and shape multiple items above. Logged here so future stories don't relitigate.

- **Three separate admin surfaces for a tournament's lifecycle.** Creation (the wizard), Editing (the Common Tasks dashboard for published-with-registrations), Running (Court-Manager-centric, scoreboard front-and-center). Each has its own URL and its own layout. A tournament's primary admin URL adapts based on phase; the others are reachable but secondary.
- **Per-event lifecycle gating is manual.** The organizer is always in the driver's seat for transitions (Ready to Run → Lock → Plan → Running). No global date-based auto-transition for the tournament. Event auto-complete IS automatic, but only at natural inflection points (end of pool, end of each playoff round).
- **A tournament can have events in different lifecycle states at once.** Running is per-event, not per-tournament. One event scoring its final while another hasn't started is the normal case.
- **Pricing locks the moment money is committed.** Once any active registration exists for a tournament / event, pricing fields are read-only. Refund-and-re-register is the only path to fix a price.
