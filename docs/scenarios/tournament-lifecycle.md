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
**Ron** is the WMPC tournament director. He ran the same tournament last year and is setting it up for this year. He doesn't want to think about pricing model, division structure, or court allocation — those are settled. He wants to **clone last year's tournament**, change the date, and publish. Most of his time should be spent confirming details, not entering them. **Decision:** **Clone copies everything** — events (with their formats, ratings, capacities, fees), tournament description, sponsors, FAQs, branding. The new tournament lands in `draft` status so Ron can review + adjust dates before publishing. Open sub-questions for the mockup: where's the Clone button live (tournament detail page? new-tournament form?), and what's the post-clone landing — the edit form for the new tournament, with everything pre-filled?

### C2. First-time organizer setting up their first WMPC tournament
**Sarah** is a new tournament director at a partner club. She's never used the platform. She has a venue, dates, and a rough idea of what events she wants. She doesn't know what an "additional event fee" means, or whether she needs to set up Stripe before publishing, or what happens if she publishes with no events. The flow should walk her through the bare minimum (name, dates, location, one event, pricing) and DEFER everything else (sponsors, FAQs, payment connection) to "you can come back to this." **Decision: wizard with friendly off-ramps.** A multi-step wizard so each decision feels small, but every step has an explicit "Skip / I'll do this later" affordance and inline "Not sure? Here's what this means" expandable hints for unfamiliar terms ("Additional event fee," "Stripe Connect," "Bracket type"). The hard requirement is a minimal core: name, dates, location, one event, pricing model. Everything else is deferable. A completion meter or "you can publish anytime" cue keeps her from feeling trapped in the wizard.

### C3. Multi-day tournament with 12 events across two skill brackets
**Dave** is running a 3-day weekend tournament: Friday is mixed doubles, Saturday is men's/women's brackets across 2.5–4.5, Sunday is medal play. 12 events total, two venues. He needs to enter dates per event, capacity per event, and figure out which venue each event runs at. **Decision: default event-template + bulk-adjust.** The wizard's Events step comes pre-populated with a sensible default set of events (typical club-tournament structure: Mens 3.0 / 3.5 / 4.0 / 4.5, Womens same, Mixed same — a standard ~12-event grid). Dave's experience is "remove what you don't need, tweak capacity / format, add the one custom division I want" rather than entering 12 from scratch. Most clubs use the same bracket structure year over year, so the default is right for the common case and the bulk-adjust covers the exceptions.

### C4. Test-tournament setup for development
**Ron** (wearing his platform-admin hat) wants to spin up a throwaway tournament to test something — registration flows, court manager UI, scoring. He needs the fastest possible "good enough" tournament: name, today's dates, one event, no fees, no sponsors. **Decision: defer.** If the C2 wizard is genuinely fast-and-skippable, a barebones test tournament falls out as "name + dates + one event + Skip the rest + Publish." A dedicated "Quick test" button isn't needed at v1 — revisit if the wizard ends up taking more than ~30 seconds for the minimum path.

### C5. Setting a Cancellation Policy during creation
**Sarah** is on the Cancellation Policy step of the creation wizard. She's never run a tournament and has no idea what's "fair" or "standard" — she doesn't want to invent a policy from scratch. The wizard step shows three preset policies with plain-English descriptions ("Generous: full refund up to 7 days before tournament," "Standard: half refund within 30 days, none within 7," "Strict: no refunds after registration") and a Custom option for people who want full control. She picks Standard, sees a one-paragraph plain-English summary that'll appear on the public tournament page so players know the rules, and moves on. **Decision intent:** the policy is then enforced automatically by both the player-side withdraw flow (refund window math runs against the policy) AND the admin-side tournament-cancellation flow (E6 reads the policy to drive bulk refunds). The policy is visible on the public page so player expectations are set before they pay. **Implies a `tournaments.cancellation_policy` column** (jsonb or a few discrete fields) + the preset definitions stored client-side.

---

## Phase 2: Editing

The protagonist is the same **Organizer** but the tournament now exists, is published, and probably has registrations. Every change has a blast radius. Tone: cautious. Surface should flag what's safe to change vs what affects players, and protect against accidental destruction.

### E1. Two weeks out: add a sponsor logo
**Sarah** got a last-minute sponsorship deal. She wants to upload a logo and have it appear on the public tournament page. Zero blast radius — no player is affected. **Decision: Common Tasks dashboard for editing.** The edit surface for a published tournament leads with a "Common Tasks" panel — quick-access tiles for the things organizers actually do mid-registration (Add sponsor, Add FAQ, Edit description, Email registrants, Adjust capacity). Each is a focused mini-form, NOT a re-walk of the creation wizard. Anything with downstream impact (touches registrations, pricing, dates, events) carries a clear "this will affect N registered players" warning before save; safe changes (sponsors, FAQs, copy) save silently. The full creation wizard is still reachable but framed as "Edit all settings" — secondary to the common-tasks shortcuts.

### E2. Day before registration closes: add a last-minute event
**Dave** realized he forgot to add a "Beginner 3.0" event. Registration is still open, no one's registered for the missing event obviously, and other events have plenty of bandwidth left. He wants to add it without disrupting anything else. **Decision: confirmation step that scales with how close we are to the tournament.** Adding an event always confirms (it's a structural change that risks downstream effects), and the copy gets sharper as the date approaches. T-30 days: light "Add Beginner 3.0 to this tournament?" T-2 days: a stronger "This is unusual — the tournament is in 2 days. Existing registered players won't know about this event unless you tell them. Add anyway?" Aimed at people who don't intuitively know what running a tournament means.

### E3. Mid-registration: change an event's pricing
**Sarah** set the wrong fee on Mixed 3.5 ($60 when it should be $40). Three players have already registered and paid. What's the right thing to do? Show what they paid vs what new registrants will pay? Offer to refund the difference? Refuse the change and recommend a separate communication? **Decision: prevent price changes once anyone is registered. Period.** Tournament + event pricing fields lock the moment the first paid registration lands. The UI shows the fields as read-only with a clear explanation ("Pricing is locked — 3 players have already registered. To fix a price, cancel + refund affected players via the attendees view, then unlock."). The refund-and-re-register path is explicit and admin-driven; pricing is never a casual edit.

### E4. After registration closes: shift a court assignment
**Dave** needs to move Mens 3.5-3.99 from Courts 5-6 to Courts 1-2 because of a venue change. Players are paid, brackets aren't generated yet. **Decision: court assignment is NOT an Editing concern.** Through registration close, court details don't matter — what matters is the registrant count per event. Court assignment is a *finalization* phase that sits between Editing and Running (see R1 below for finalization mechanics). What we DO surface in Editing is a "Schedule estimator" tool — takes the current registrant counts + tournament court count + per-event format, returns an estimated time-and-court plan and an auto-suggested per-event court count. Organizer accepts/adjusts; the estimator's output is advisory until finalization locks it in.

### E5. Player wants to switch divisions after paying
**Sarah** gets an email from a player who registered for Mixed 3.5 but realized she's actually a 4.0 and wants to switch. This is a registration mutation: cancel-and-re-register? Refund the gap if any? Move the existing registration row? **Decision: admin-driven via a player Request queue.** The player can flag a change request from their own registration view ("Need to switch divisions?" → form: which division you want, brief reason). The admin sees the request in a queue alongside other change-requests for that tournament, reviews it, and makes the actual change (with refund/charge differences handled if applicable). NOT a self-serve action — division changes touch capacity + bracket structure too much to let players do directly. The path is: clear way for players to ask, clear admin queue to process.

### E6. Cancel a tournament that has registrations
**Dave** decides to cancel the whole tournament — venue fell through. Money's been collected. The mockup should show what happens: bulk refund flow, mass-email notification, status flip to "cancelled," whether the public page stays up with a "cancelled" banner or disappears. **Decision: admin-protected, behind a strong confirmation modal — and driven by the tournament's pre-set Cancellation Policy.** The Cancellation Policy is set during creation as part of the wizard: a mini-wizard with presets (e.g. "Full refund within 7 days of registration, half refund within 30 days of tournament, no refund within 7 days of tournament") plus a Custom option. Cancellation in Edit consults that policy to drive the refund flow automatically — the organizer doesn't have to figure it out under pressure. The policy itself is visible to players on the public tournament page so expectations are set up front. New creation sub-scenario implied: **C5 (Cancellation Policy preset during creation)** — see additions at the bottom of this section.

---

## Phase 3: Running

The protagonist is the **Organizer** during play. Pace is faster — scorecards coming in, calls happening, schedule decisions made in real-time. The admin surface for Running should NOT be the same screen as Creation/Editing. Different layout, different priorities (court status > tournament settings).

### R1. Day 1, 8am: open the day
**Ron** arrives at the venue. He wants the morning's first matches to start on time. He needs to: confirm brackets are locked, see which courts are assigned to which events, print or display the day's schedule, and have the Court Manager open on his laptop. **Decision: explicit two-step finalization, both manual.** Event lifecycle becomes `draft → ready_to_run → locked → planned → running → complete` (extends the current event_status enum). Two manual gates the organizer must pull:
1. **Mark Ready to Run** — registrant counts look right, the bracket structure is settled. Anytime mid-registration onward.
2. **Lock** — finalizes the registrant list for that event; no more new registrations or partner changes. Happens N days before the event date (N configurable per tournament, default ~3-5).
After locking, the organizer uses a planning tool to assign start times + courts, then sends the schedule to players. Running phase opens on the locked-and-planned event when its scheduled start time arrives (or the organizer can manually flip "Start running"). No date-based auto-transition — the organizer is always in the driver's seat.

### R2. Mid-tournament: scorecard hits Ron's desk
A referee hands Ron a paper scorecard with a GameID. He needs to find that match in the system (search-by-GameID), enter the score, and have the bracket / standings update automatically. Should take 15 seconds. **Decision: both — Court Manager surfaces running games inline, search-by-GameID is the fallback.** Currently-running games appear directly on the Court Manager screen — for most scorecards Ron is dealing with games right now, so no search needed. Search-by-GameID exists for the edge cases (scorecard from a game that just ended, an organizer hunting back through completed matches, mistakes). Score entry on running games is a few clicks from the Court Manager view; search is a small input at the top of the screen.

### R3. Player no-show, bracket needs adjustment
A player doesn't show up for their first match. Their opponent should advance. **Sarah** needs to mark the no-show and let the bracket roll forward. **Decision: defer the specifics — process needs more thought.** Strong intuition: we don't blindly hand the opponent the win. There's some investigation step (contact the missing team, see if they're stuck in traffic, etc.) before the forfeit gets applied. The exact mechanics — how long the system waits, whether the admin or referee initiates, what data we capture — get designed once the main Running UX is built and we can see where this action would actually live in the flow. Reminder for the Running mockup: leave space for a no-show / forfeit action on the per-match controls, even if its full design is TBD.

### R4. Live standings request from a spectator
A spectator (or a player checking their phone) wants to see the current standings of the event their friend is playing. **Decision: publicly available, anonymous-readable.** Standings live at a public URL (`/t/:org/:slug/standings` or similar), no auth required. The page covers the running event(s) and updates as scores land. Linked from the public tournament page so a fan tapping through from a share link gets straight to "where's Alice in the bracket right now."

### R5. End of day 1: prep for day 2
**Dave** wraps up day 1 with 3 events partially complete. He needs to print or share day 2's schedule with players (most of whom got eliminated and don't need to come back; some who advanced do). **Decision: defer multi-day for v1.** Don't worry about events carrying over to a second day right now. All events treated as single-day; revisit when we have a real multi-day tournament to design against (and probably tied up with the broader "communications" backlog item — emailing advancing players is a notification design we'll do once).

### R6. Day 2 final: score the championship
**Ron** scores the championship match for an event. The system should mark the event "complete," lock the bracket, and surface the medalists. **Decision: events get marked complete at natural inflection points — round-robin and each playoff round.** Two stages of "complete":
1. **Pool play complete** — when every round-robin pool game in the event has a score recorded. System auto-detects + flips a flag; UI shows "Pool play done — generate playoff bracket." Organizer triggers the playoff bracket generation manually.
2. **Round complete** at every playoff round (quarters, semis, finals) — same auto-detect. The semis-complete state surfaces the final match; the final-complete state marks the entire event `complete` and locks the bracket.

Medalists fall out of the final-complete state; surfacing them is part of the event-complete celebration / handoff (whatever shape that takes — TBD).

---

## What we'll do with these

1. **You refine** — add scenarios I missed, drop ones that don't apply to WMPC, sharpen the open questions. Edit this file directly; it's the source of truth for the mockup briefs.
2. **Then I mock** — three HTML files (creation, editing, running), each pinned to the scenarios above. Same pattern as `mockups/register-then-checkout-flow.html`.
3. **Then we decide** what's worth coding for real and slot it into the backlog as proper user stories.

A natural cadence: scenarios → mock → review → scope-into-backlog → build. Each phase can run independently — creation mockup can land before editing scenarios are even finalized.

---

## What emerged from this pass

Beyond the per-scenario decisions, four cross-cutting patterns came out of this discussion. Each is a real piece of work worth recording in the backlog after the mockups land:

1. **Common Tasks dashboard** for the Editing surface (E1). Not a re-walk of the wizard; a focused panel of quick mini-forms for the things organizers actually do mid-registration. Anything with downstream impact (touches registrations / pricing / dates / events) carries a "this affects N players" warning before save.

2. **Event lifecycle states** beyond what we have today (R1, R6). Proposal: `draft → ready_to_run → locked → planned → running → complete`. Two of those transitions are explicit manual gates the organizer pulls (Ready to Run, Lock). Complete fires at the natural inflection points — end of pool play, end of each playoff round, championship — via auto-detection.

3. **Cancellation Policy as a wizard step in creation** (E6, C5). Preset choices (Generous / Standard / Strict / Custom) with plain-English summaries. The policy is visible on the public page AND drives the math for both player-side withdrawals and admin-side full-tournament cancellation. Lifts the cognitive load off the inexperienced organizer.

4. **Player change-request queue** for admin (E5). Players can flag "I need to switch divisions / withdraw with a reason / change partner" — admin sees a queue, processes each. Not self-serve for things that touch capacity or refunds.

Plus a few smaller pieces:
- Schedule estimator surface in Editing (E4) — uses registrant counts + format + court count to propose times and auto-suggest court allocations per event.
- No-show / forfeit flow needs its own design pass (R3) — leave space in the Running mockup for it.
- Public standings page (R4).
- Score-by-GameID search as a fallback alongside the Court Manager's inline running-games view (R2).

## Decided meta-questions

- **Wizard vs single form for creation?** **Wizard, with explicit "skip / I'll do this later" off-ramps and inline "what does this mean?" hints.** Minimal required core (name / dates / location / one event / pricing), everything else deferable.
- **Same admin surface, three modes — or three separate surfaces?** **Three separate surfaces.** The Editing surface leads with the Common Tasks dashboard (E1); the Running surface is Court-Manager-centric with the scoreboard front-and-center. Creation is the wizard. Each has its own URL and layout.
- **When does Editing → Running transition?** **Per-event manual gating.** Organizer marks `ready_to_run`, then `locked` (N days before event), then planning happens, then Running mode opens on that event when its scheduled start time arrives (or the organizer manually flips it). No global date-based auto-transition.
- **Can a tournament be in two phases at once?** **Yes — Running is per-event, not per-tournament.** One event running while others haven't started is the normal case.

## What's next

1. Confirm this doc reads right. Edit / sharpen / add scenarios I missed.
2. I'll mock **Creation** first — `mockups/tournament-creation-flow.html`, pinned to the scenarios above.
3. Then **Editing** — `mockups/tournament-editing-flow.html`, with the Common Tasks dashboard as the centerpiece.
4. Then **Running** — `mockups/tournament-running-flow.html`, Court-Manager-centric.
5. After each mockup, we slice the real-build work into backlog items so it's ready to pull when we want to start coding.
