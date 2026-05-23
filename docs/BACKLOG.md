# Backlog

Living list of what's next, organized by how soon we're likely to pull it. Update as we go — move items between sections, drop them under "Recently shipped" when they land, prune that section when it gets long.

Last updated: **2026-05-23**

---

## Next up

Things actively queued — the next handful of commits.

### D. First-event + additional-event pricing
Tournaments usually price the first event at one rate ($50) and each additional event cheaper ($25). Schema migration adds `tournaments.additional_event_fee_cents`; we treat existing `entry_fee_cents` as the first-event fee. Per-event `event_fee_cents` becomes an optional override for special cases. Admin form exposes both; public tournament page + register page show per-event prices and a running total at the bottom of the events list.

**Touches:** migration, types, `TournamentFormPage`, `PublicTournamentPage`, `RegisterPage`.

### F1. "I need a partner" registration option (doubles)
For doubles events, a third option alongside "Pick a partner" / partner search: **"Sign me up — I need a partner."** Registers solo with a new `partner_status='seeking'` enum value. No matching UI yet; that's F2.

**Touches:** migration (enum value), `RegisterPage` event row, validation.

### F2. Admin view of partner seekers
Add a "Seekers" section to the event admin / attendees view showing players who registered as seekers, with contact info, so organizers can match people up offline.

**Touches:** `AttendeesPage` (or `EventConsolePage`), filter on `partner_status='seeking'`.

---

## Soon

Known work that's not next-next but is on the radar.

### Stripe Connect onboarding (organizer side)
`/admin/:org/settings/stripe` page with a "Connect Stripe" button → Stripe-hosted onboarding → webhook updates `organizations.stripe_account_status`. Edge function: `supabase/functions/stripe-webhook/`. This unblocks paid registration; right now registrations all save with `status='paid'` as a placeholder.

### Real payment flow on registration
Stripe `PaymentIntent` created at submit with `application_fee_amount` for our platform cut and `transfer_data.destination` = organizer's connected account. Replace the current "always paid" placeholder. Needs Stripe Connect (above) to land first.

### Roster view for organizers
The admin equivalent of the partner-seekers list, but for confirmed teams: see who registered for each event, contact info, partner pairings, payment status. Probably an expansion of `AttendeesPage`.

### Withdraw / refund flow once payments are real
Withdraw currently soft-deletes the registration with no payment side effect. Once Stripe is wired, withdrawing within the refund window should issue a refund via the Stripe API; outside the window should require organizer approval.

### Pending invite count on the homepage
Tournament page surfaces invites for *that tournament*. The site homepage (`/`) should also show a chip / banner if the signed-in user has any pending invites anywhere, so they don't have to find the right tournament first.

### Partner-change UX polish
Right now changing a partner means clear the chip + search for someone else. Two improvements worth doing:
- Inline "Find a new partner" button on the partnered chip (vs. only the × clear).
- "Undo this change" affordance in the diff summary banner so a misclick is recoverable without leaving the page.

---

## Later

Bigger themes, not committed to. Listed so we don't forget them, not in any particular order.

### Bracket / scoring improvements
Round-robin generator exists; single/double-elim work continues. Bigger items:
- Seeded brackets from ratings on registration
- Tiebreak rules surfaced in admin (head-to-head, point differential)
- Live standings page for spectators

### Communications
Reminder emails (registration confirmed, schedule posted, your match is up). Probably a small Edge Function + a `communications` table for an audit trail.

### Waitlists
When an event hits `max_teams`, additional registrants land on a waitlist instead of a hard fail. Auto-promote on a withdraw.

### Player profiles
Public `/players/:id` page with tournament history, rating progression. Cross-tournament value once we have a few orgs running.

### Multi-org admin UX
The admin sidebar currently scopes to one org at a time and switches via `/admin`. For users who staff several orgs, an org-switcher in the sidebar header would be cleaner than going through the org picker.

### Public homepage filtering
The homepage shows all upcoming tournaments and a single search box. As volumes grow, useful filters: by location radius, by organizer, by date range, by skill level.

### Mobile polish
Layouts are responsive-ish (flex/wrap) but no real mobile design pass yet. Sidebar collapses on small screens? Bottom-sheet partner picker?

### Test-account expansion
The current 20 seeded test players cover registration testing. For load / bracket testing, a "seed N teams into this event" tool (which already exists at `tools/seed-event`) plus a way to drive automated matches would let us stress-test schedule generation without manual clicking.

---

## Recently shipped

Trailing log of what landed, so the doc stays grounded. Prune entries older than ~4 weeks.

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
- **Each item gets a one-paragraph description** plus a "Touches" line if helpful — enough that someone returning to it next month can pick it up cold.
- **When an item ships,** move it to "Recently shipped" with a date + PR link if there is one. Keep that section trimmed — long-tail history belongs in `git log`, not here.
- **Don't track tasks here that are already in flight.** Use the harness's task tools for sub-day work. This doc is for the *next* thing.
