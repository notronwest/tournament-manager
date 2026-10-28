---
verdict: PASS
ui-diff: 03b72cedcecf36dc
base: 21ad4b7413cdfbc06a5d5bc90f385006ab3cc132
tip: a964a2b3643b62ccd30f4c6a07049e5f8215d7ce
branch: ux/guardian-registrations
date: 2026-10-27
rendered: yes
critic: fresh-context subagent (D-0065)
---
## Findings

None. Nothing on the screens this change touches ties to a checklist number as a
defect that is this change's doing.

## Previous finding (verdict `ec7e8aeac47d3b87`) — re-checked here, not taken on trust

- **1 (the "I need a partner" explainer fused two sentences) — fixed, measured on both
  arms.** `web/src/pages/public/PublicTournamentPage.tsx:3290–3296` now puts an explicit
  `{" "}` between the ternary and the following text node. Read off the DOM at **390×844**
  on Open Doubles with the signed-in player as registrant: *"We'll register you for this
  event without a partner. Other registrants will be able to find you in the partner
  search…"* — `/partner\.Other/` no longer matches, `/partner\. Other/` does. Switched the
  chooser to **Maya Harper** and read it again: *"We'll register Maya for this event
  without a partner. Other registrants will be able to find them…"* — also correct. Visible
  on screen both times inside the info panel, with the sentence break falling mid-line
  rather than at a wrap, so it is the space and not a line break doing the work.

## Notes (non-blocking)

- **A guardian who is already entered in an event has no route to enter their child in
  that same event, and the card says nothing about it.** Rendered: with the signed-in
  player holding a `pending_payment` entry in Open Doubles (and the child eligible there —
  no age limit — and not registered), the card at 390 shows only "Pending payment /
  You're looking for a partner / Change partner / Cancel registration". `renderAction`
  returns on the `myStatus` branches at `PublicTournamentPage.tsx:2449–2560` long before
  the Register branch that carries the "Registering for" chooser, so the chooser is the
  feature's only entry point and it disappears. The juniors case works precisely because
  the parent can never be in that bracket; the open/mixed case — the next most common
  family shape — is silent. **Not graded as a finding:** the card in that state renders
  identically at base, since this change adds nothing to it and removes nothing from it,
  and the screen is not offering a control that fails. It is the one gap the change's own
  "Known limits, deliberate" list in `STATUS.md` does not name, and it is worth a card.
- **Measured 4.46:1 on the new refusal line, against a pairing that is already in the
  product.** "You can't enter: needs age 18 or under" is `#6b7280` on the amber card wash
  `#fef6d6` = **4.46:1** at 12px, just under #14's 4.5. The same token pairing sits two
  lines above it on the same card in "Start time to be announced" (`#6b7280` on `#fef6d6`,
  **4.46:1**), which is base code on a card that already turned amber for the player's own
  pending entry — so the shortfall belongs to `inkMuted`, not to this change, and fixing it
  at the call site would split the token. Everything else on that card clears comfortably:
  the "Maya — pending payment" pill **11.81:1**, "Maya Harper is registered" **16.63:1**.
- **The new select's resting border is 1.35:1 against the card.** `registeringForSelectStyle`
  spreads the shared `inputStyle` (`publicTheme.ts:289–298`, untouched by this diff), whose
  `1px solid ${rule}` is `#e3dec8` on white. #14 wants ≥3:1 for the boundary of a control.
  Every input in the app has had this since before the change, and reusing the token is the
  right call under D-0049 — the floor belongs to `inputStyle`. Same story for the 39–41px
  input heights against #7's 44 (the new date-of-birth and add-a-child fields inherit them).
- **"Ask the organizer to change this" still names who but gives no way to reach them.**
  `/my-tournaments` at 390 on the child's row. The route exists two taps away ("View
  tournament →" then "Contact organizers →") and neither is named here. #15 is met in the
  letter; linking it would meet it in the spirit. Carried unchanged from the previous pass.
- **Second-person copy applied to a child.** Checkout's dependent card reads "Looking for a
  partner — we'll help **you** match" above "Registering **Maya Harper**". Carried from
  earlier passes.
- **Three filled dark buttons live on `/profile` at once** — "Save profile", "Add a child",
  "Update password". Each sits in its own section with its own form, which is the usual
  settings-page reading of #2 (one primary per *card*), and the new one is the only primary
  in its panel. Worth a glance, not a block.
- **Pre-existing, confirmed at base, not graded here:** the fixed pending-payments bar
  (118px, top at y=726) covers the bottom of every long page at 390 and nothing reserves
  space for it — on the attendees page at max scroll the stacked card's 44px **Manage**
  button sits at y 767–811 and `elementFromPoint` returns the bar. Forcing the base table
  layout at 390 (load at 1280 so the module constant keeps the table, then resize) buries
  the same button at y=735 **and** renders it only 25px tall, so the new stacked card
  improves the target and inherits the overlap rather than causing it. The floating "Need
  help?" chip overlaps the checkout CTA at 390. Checkout still prints a raw environment
  variable name at the user ("Payments aren't configured yet (missing
  VITE_STRIPE_PUBLISHABLE_KEY)", `CheckoutPage.tsx:1293` at base) — #6, and local-only, but
  it is the string a member would see if the key were ever missing in production.
  `isNarrowViewport` remains a module constant, so a rotation across 699px needs a reload;
  it matches the three siblings already in the codebase.
- **Verified clean:** `document.scrollWidth` equals the viewport, with **0** elements past
  the right edge, on the tournament page, profile, my-tournaments, checkout and attendees at
  both widths. The "Registering for" select is **44px** tall, capped at 320px on desktop,
  with a real `<label for>` (**8.04:1**) — and it appears only when there is a second name,
  so an adult with no dependents sees the form unchanged. The refusal panel is **6.76:1**
  (`#9c2412` on `#fdeae6`) and suppresses the price line, the partner tiles and the
  "pick a partner" hint beneath it, so no contradiction stacks under it; Save is genuinely
  `disabled` in that state. The family row's remove control is **44×44** with an
  `aria-label`, its glyph **4.54:1**; `ConfirmModal` opens with a 44px `--danger` confirm
  (**4.83:1**) beside a 44px text Cancel, says what is lost *and* that it is reversible, and
  Escape dismisses it. The add-a-child fields are labelled with required marks and an inline
  reason for the date of birth. The chooser defaults correctly both ways: on the juniors
  bracket with the child's entry cleared it opens on "Maya Harper" with "$45 entry · Maya's
  first event here", and switching to the parent produces the refusal rather than a dead end.
  Checkout, the sticky bar and My Tournaments all agree at **$45.00** and all three name
  Maya.

## Screens checked

- `/t/wmpc/loon-race-team-test?tab=register` (390, 1280) — seeded state (the child's amber
  Kids card and its "MAYA — PENDING PAYMENT" pill, the "Maya Harper is registered" /
  "You can't enter" pair, the 50+ refusal); Open Doubles' register form with "I need a
  partner" on **both** arms of the chooser; the Kids card with the child's entry cleared
  (chooser defaults to the child, then switched to the parent for the refusal panel and the
  disabled Save); and the parent-already-entered state on Open Doubles.
- `/t/wmpc/loon-race-team-test/checkout` (390, 1280) — the dependent's basket, the
  "Registering Maya Harper" line and the named order-summary row.
- `/my-tournaments` (390, 1280) — the child's row, its pending pill and the organizer line
  with Withdraw correctly withheld.
- `/profile` and `/profile#my-family` (390, 1280) — the "On this page" jump line, the new
  date-of-birth field, the populated family list, the add-a-child form and the remove
  confirmation opened and escaped.
- `/admin/wmpc/tournaments/loon-race-team-test/attendees` (390, 1280) — By Player as stacked
  cards at 390 ("Maya Harper → 11 years old → Registered by Dana Harper") and as the table at
  1280, plus the base-equivalent table forced at 390 for the bar-overlap comparison.
- Screenshots saved to `.design/shots/03b72cedcecf36dc/` (gitignored); nothing committed.

## Data altered to reach a state, and restored

Two changes, both reversed. Maya's seeded Kids `pending_payment` row was soft-deleted
(`deleted_at = now()`) to render the parent-aged-out / child-eligible card and the refusal
panel, then restored (`deleted_at = null`). A `pending_payment` row was inserted for Dana in
Open Doubles to render the parent-already-entered card in the first note, then hard deleted.
No payment was attempted (Stripe is unconfigured locally) and the one open registration form
was closed with "Not now". Final state verified against the seed as found:
`event_registrations` **15 live / 15 total**, `partner_invites` **0**, one live
`player_guardians` link, and Maya's Kids `pending_payment` row live with
`registered_by_player_id` = Dana (`11111111-…`).
