# Tournament lifecycle scenarios

A tournament has three distinct contexts for its organizer:

1. **Creation** — building it from nothing to something publishable
2. **Editing** — published, registration open or closed, players in the system; changes have blast radius
3. **Running** — tournament is happening; the focus shifts from "configure" to "execute"

Each phase has its own admin surface (or should), its own primary actions, and its own anxiety. The scenarios below are seeds — concrete narratives we'll use to drive the design of the three HTML mockups. Refine them; the mockups will follow whatever shape we agree on here.

> **Format:** each scenario is one paragraph naming the protagonist, the situation, the path, and the open question we should answer in the mockup. Keep them concrete enough that a reader knows *exactly* what the screen needs to do, but abstract enough that we're describing intent rather than UI.

---

## Phase 1: Creation

The protagonist is an **Organizer** going from a blank slate to a published tournament that real players can register for. Tone: confidence-building. Surface should make defaults obvious, hide rarely-needed knobs, and give the organizer a clear "you're done" moment.

### C1. Returning organizer running this year's club tournament
**Ron** is the WMPC tournament director. He ran the same tournament last year and is setting it up for this year. He doesn't want to think about pricing model, division structure, or court allocation — those are settled. He wants to **clone last year's tournament**, change the date, and publish. Most of his time should be spent confirming details, not entering them. **Open question:** does "clone" copy events, fees, descriptions, sponsors, *and* draft status? Or just the structural bits? What does he see immediately after clicking Clone?

### C2. First-time organizer setting up their first WMPC tournament
**Sarah** is a new tournament director at a partner club. She's never used the platform. She has a venue, dates, and a rough idea of what events she wants. She doesn't know what an "additional event fee" means, or whether she needs to set up Stripe before publishing, or what happens if she publishes with no events. The flow should walk her through the bare minimum (name, dates, location, one event, pricing) and DEFER everything else (sponsors, FAQs, payment connection) to "you can come back to this." **Open question:** is this a wizard with explicit steps, or a single long form with progressive disclosure? PickleballBrackets uses a wizard with 11 steps; that felt heavy when we looked at it.

### C3. Multi-day tournament with 12 events across two skill brackets
**Dave** is running a 3-day weekend tournament: Friday is mixed doubles, Saturday is men's/women's brackets across 2.5–4.5, Sunday is medal play. 12 events total, two venues. He needs to enter dates per event, capacity per event, and figure out which venue each event runs at. **Open question:** is there a bulk-event-add tool? An "add 8 events from a skill grid" shortcut? Or is each event a separate form fill?

### C4. Test-tournament setup for development
**Ron** (wearing his platform-admin hat) wants to spin up a throwaway tournament to test something — registration flows, court manager UI, scoring. He needs the fastest possible "good enough" tournament: name, today's dates, one event, no fees, no sponsors. **Open question:** is there a "Quick test tournament" button somewhere in dev/admin tools? Or do we expect him to slog through the normal create form?

---

## Phase 2: Editing

The protagonist is the same **Organizer** but the tournament now exists, is published, and probably has registrations. Every change has a blast radius. Tone: cautious. Surface should flag what's safe to change vs what affects players, and protect against accidental destruction.

### E1. Two weeks out: add a sponsor logo
**Sarah** got a last-minute sponsorship deal. She wants to upload a logo and have it appear on the public tournament page. Zero blast radius — no player is affected. **Open question:** what's the friction profile here? Does she need to leave the edit form to come back to a "branding" page, or is logo upload right there in the tournament settings?

### E2. Day before registration closes: add a last-minute event
**Dave** realized he forgot to add a "Beginner 3.0" event. Registration is still open, no one's registered for the missing event obviously, and other events have plenty of bandwidth left. He wants to add it without disrupting anything else. **Open question:** does adding a new event require any kind of confirmation? Probably not — but the surface should make clear "this is a new event with 0 registrants, you're fine."

### E3. Mid-registration: change an event's pricing
**Sarah** set the wrong fee on Mixed 3.5 ($60 when it should be $40). Three players have already registered and paid. What's the right thing to do? Show what they paid vs what new registrants will pay? Offer to refund the difference? Refuse the change and recommend a separate communication? **Open question:** this is the hardest editing scenario. The mockup should propose a clear policy — even if the policy is "you can change pricing but it doesn't affect existing registrations, and we'll show you the gap."

### E4. After registration closes: shift a court assignment
**Dave** needs to move Mens 3.5-3.99 from Courts 5-6 to Courts 1-2 because of a venue change. Players are paid, brackets aren't generated yet. **Open question:** is "court assignment" surfaced at this phase, or is it part of Running? Probably here — the bracket needs courts to be assigned before generation. But the UI should make clear "this is a logistics change, not a registration-affecting one."

### E5. Player wants to switch divisions after paying
**Sarah** gets an email from a player who registered for Mixed 3.5 but realized she's actually a 4.0 and wants to switch. This is a registration mutation: cancel-and-re-register? Refund the gap if any? Move the existing registration row? **Open question:** is this an admin action (organizer flips the player's reg) or a player action (player withdraws + re-registers themselves)? The mockup should land on which.

### E6. Cancel a tournament that has registrations
**Dave** decides to cancel the whole tournament — venue fell through. Money's been collected. The mockup should show what happens: bulk refund flow, mass-email notification, status flip to "cancelled," whether the public page stays up with a "cancelled" banner or disappears. **Open question:** is this a button? A protected admin-only command requiring confirmation + reason? Probably a confirmation modal with serious copy.

---

## Phase 3: Running

The protagonist is the **Organizer** during play. Pace is faster — scorecards coming in, calls happening, schedule decisions made in real-time. The admin surface for Running should NOT be the same screen as Creation/Editing. Different layout, different priorities (court status > tournament settings).

### R1. Day 1, 8am: open the day
**Ron** arrives at the venue. He wants the morning's first matches to start on time. He needs to: confirm brackets are locked, see which courts are assigned to which events, print or display the day's schedule, and have the Court Manager open on his laptop. **Open question:** is there a "Start tournament" command that locks brackets and shifts the UI into Running mode? Or does the system infer based on the tournament's date?

### R2. Mid-tournament: scorecard hits Ron's desk
A referee hands Ron a paper scorecard with a GameID. He needs to find that match in the system (search-by-GameID), enter the score, and have the bracket / standings update automatically. Should take 15 seconds. **Open question:** is the score-entry surface optimized for keyboard speed (next-game-id, tab, score, tab, score, enter)? Or is it mouse-driven?

### R3. Player no-show, bracket needs adjustment
A player doesn't show up for their first match. Their opponent should advance. **Sarah** needs to mark the no-show and let the bracket roll forward. **Open question:** is this an explicit "no-show" action that creates a forfeit record, or does she just enter a 0-11 score with a forfeit flag?

### R4. Live standings request from a spectator
A spectator (or a player checking their phone) wants to see the current standings of the event their friend is playing. **Open question:** is this a public read-only view we link from the tournament page? Refreshes automatically?

### R5. End of day 1: prep for day 2
**Dave** wraps up day 1 with 3 events partially complete. He needs to print or share day 2's schedule with players (most of whom got eliminated and don't need to come back; some who advanced do). **Open question:** is there a "tomorrow's schedule" view that distinguishes who plays from who's done? A communication action that emails advancing players?

### R6. Day 2 final: score the championship
**Ron** scores the championship match for an event. The system should mark the event "complete," lock the bracket, and surface the medalists. **Open question:** what's the post-event handoff? Does Ron get a "you've finished this event" celebration screen with a "publish results" action? Or does it just quietly mark complete?

---

## What we'll do with these

1. **You refine** — add scenarios I missed, drop ones that don't apply to WMPC, sharpen the open questions. Edit this file directly; it's the source of truth for the mockup briefs.
2. **Then I mock** — three HTML files (creation, editing, running), each pinned to the scenarios above. Same pattern as `mockups/register-then-checkout-flow.html`.
3. **Then we decide** what's worth coding for real and slot it into the backlog as proper user stories.

A natural cadence: scenarios → mock → review → scope-into-backlog → build. Each phase can run independently — creation mockup can land before editing scenarios are even finalized.

---

## Open meta-questions

- **Wizard vs single form for creation?** PickleballBrackets does 11 steps; we currently have one long form. Mockup should pick one.
- **Same admin surface, three modes — or three separate surfaces?** The current `/admin/:org/tournaments/:slug` is a single page. Running probably wants its own URL (`/admin/:org/tournaments/:slug/run`?) with a different layout.
- **When does Editing → Running transition?** Based on date, based on an explicit "Start tournament" button, or based on event statuses? Bracket-locking is the natural inflection point.
- **Can a tournament be in two phases at once?** E.g. one event is "running" while others haven't started. Probably yes — Running is a per-event mode more than a per-tournament one.
