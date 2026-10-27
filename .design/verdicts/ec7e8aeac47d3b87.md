---
verdict: FAIL
ui-diff: ec7e8aeac47d3b87
base: 21ad4b7413cdfbc06a5d5bc90f385006ab3cc132
tip: f2b9126d7fd31d07ed9c277d87717614e1760a2d
branch: ux/guardian-registrations
date: 2026-10-27
rendered: yes
critic: fresh-context subagent (D-0065)
---
## Findings

1. **`web/src/pages/public/PublicTournamentPage.tsx:3291–3293` → #6 (Words).** The
   "I need a partner" explainer renders two sentences fused with no space:
   **"We'll register you for this event without a partner.Other registrants will be able
   to find you in the partner search…"** Read off the DOM at **390×844** on the Open
   Doubles card with the signed-in player as the registrant
   (`textContent` = `…without a partner.Other registrants…`, `/partner\.Other/` matches)
   and again with a dependent chosen (`…without a partner.Other registrants will be able
   to find them…`), and visible on screen both times inside the info panel. **This is a
   regression this change introduced, and it is not a guardian-only path** — it is the
   panel every registrant sees the moment they pick "I need a partner". At base
   (`:2956–2958`) the whole paragraph was one JSX text node, so the newline collapsed to a
   space and it read "…without a partner. Other registrants…". The change split the first
   sentence into a `{registeringSomeoneElse ? … : …}` expression to name the dependent;
   JSX drops the whitespace between a closing `}` and a text node that starts on the next
   line, so the space went with it. Both arms of the ternary end in `.` and both lose it.
   Fix: put the trailing space inside the expression (`…without a partner. `) or build the
   whole paragraph as one string, so the sentence break survives.

## Previous findings (verdict `b692b9ae9b5886c3`) — re-checked here, not taken on trust

- **1 (the Register button indented 51px by `alignItems:"flex-end"`) — fixed, measured at
  both widths.** State reproduced live: Maya entered in Open Doubles through the UI, with
  Dana still eligible, so the card renders the dependent line *above* the Register button.
  At **390×844** the card's content column, the "Maya Harper is registered" line and the
  button all sit at **x=37** (title "Open Doubles" x=37, "1 teams · 1 still forming"
  x=37); the button is **w=146.8, h=45**. At **1280×800** the line (`x=984.2, w=146.8`)
  and the button (`x=984.2, w=146.8`) share the action column's right edge **1131**, and
  the card body stays at x=149. Flush at 390, right-aligned at 1280 — correct both ways.
- **2 (My Tournaments read the payer's rows only) — fixed.** With only the child's entry
  in the seed, `/my-tournaments` at **390** now renders the tournament card with the row
  "**Kids 18 & Under Doubles — Maya Harper**", a "Pending payment" pill and "Ask the
  organizer to change this" in place of Withdraw; the empty state is gone, and the page no
  longer contradicts the sticky bar on the same screenful ("1 event waiting for payment …
  $45.00"). With two dependent entries it lists both. At **1280** the three parts line up
  in columns (name x=337, pill x=636, organizer line x=760) across both rows. The withdraw
  and refund buttons are correctly withheld on a row that isn't the payer's — both RPCs
  authorize as the registrant.
- **3 (a dependent's pending entry didn't look pending) — fixed.** The Kids card is amber
  and carries its own pill **"MAYA — PENDING PAYMENT"** (`#f3d111` on `#14181f`, far above
  4.5:1) beside the title, alongside "Maya Harper is registered" / "You can't enter: needs
  age 18 or under". When a second dependent entry was added, the Open Doubles card turned
  amber and grew the same pill. Same object, same treatment as the payer's own pending
  entry, at both widths.

## Notes (non-blocking)

- **The Register button changes width with a sentence that isn't its own.** With the
  dependent line present the button stretches to that line's width (**146.8px** vs
  **95.3px** on the cards without it), because the wrapper column now defaults to
  `align-items: stretch`. Flush and legible at both widths — but the same control renders
  at two sizes on one screen.
- **"Ask the organizer to change this" names who, but offers no way to reach them.** The
  row's only route is "View tournament →" and then "Contact organizers →" on the
  tournament page — two taps, neither named here. #15 is satisfied in the letter (the
  refusal says who supplies it); linking the contact would satisfy it in the spirit.
- **A dependent's *withdrawn* entry says nothing at all.** `isWithdrawable` is
  `paid | pending_payment`, so the organizer line is withheld on a withdrawn row while
  "Request refund" is also withheld (payer-only). The parent who paid sees a "Withdrawn"
  pill and no next move. Narrow, and the payer's own row has an equivalent silent state at
  base, so it is a note — but it is the one terminal state the change leaves unspoken.
- **The client's per-line tier attribution differs from the server's.** On the two-event
  basket the page reads "Kids — Maya Harper (registration) $45.00 / Open — Maya Harper
  (additional event) $15.00"; `compute_checkout_total` returns the same **$60.00** but
  assigns *first* to Open Doubles and *additional* to Kids. Totals agree, per-line labels
  may not match the receipt.
- **"Looking for a partner" doesn't carry the age or the guardian.** The organizer's
  pairing panel shows "Maya Harper / no email no phone" with nothing saying she is 11 or
  that Dana registered her — the facts the By Player view now carries. Same omission the
  code documents for By Event.
- **Second-person copy applied to a child.** Checkout's dependent card reads "Looking for
  a partner — we'll help **you** match", and the explainer in finding 1 mixes "register
  Maya" with the same "you". Carried from earlier passes.
- **Two filled buttons in one screenful on `/profile`.** "SAVE PROFILE" and "ADD A CHILD"
  are both solid dark and visible together at 390. Different sections with their own
  forms, which is the usual settings-page exception to #2; worth a glance, not a block.
- **`isNarrowViewport` is a module constant** (`AttendeesPage.tsx:1410`), so a rotation or
  resize across 699px doesn't swap the layout until reload. It matches the house pattern
  already in `CheckoutPage`, `MyTournamentsPage` and `PublicTournamentPage` (all at base),
  so it is consistent rather than novel — but it is a new instance of a non-reactive
  breakpoint, under a different name and breakpoint (699 vs 767) than its three siblings.
- **Pre-existing, confirmed at base, not graded here:** the fixed pending-payments bar
  (118px) overlays the last of the page and nothing reserves space for it — on the
  attendees page at 390 the final card's event chips and its 44px **Manage** button sit at
  y 766–811 under a bar starting at y 726, with `scrollTop` already at `maxScroll` (271),
  so `elementFromPoint` returns the bar, not the button. **This is not the new stacked-card
  layout's doing:** forcing the base table layout at 390 (load at 1280, resize to 390, so
  the module constant keeps the table) buries "Manage" and the "Open Doubles" chip exactly
  the same way. The floating "Need help?" chip likewise overlaps content, including the
  `$45.00` line in checkout's order summary. Every `/profile` input is 39–41px against
  #7's 44 (the new date-of-birth and add-a-child fields reuse the shared `inputStyle`,
  which is the right call under D-0049 — the floor belongs to the token). The registration
  form renders behind a scrim as `role="dialog"` although it is a form that would fit
  inline (#8); pre-existing and still worth writing down rather than re-judging each pass
  (D-0018).
- **Verified clean:** `document.scrollWidth` equals the viewport on every route checked at
  both widths, with **0** elements past the right edge on the tournament page, profile,
  checkout, my-tournaments and attendees. The new jump links ("my family", "account") are
  13px `#1e6cd6` on `#fafaf7` = **4.85:1** and sit in a line of prose whose destinations
  are reachable by scrolling, which is D-0225's carve-out from the 44px floor rather than
  a breach of it. The family row's remove control is **44×44** with an `aria-label` in a
  fixed 44px slot; `ConfirmModal` opens with a `--danger` confirm beside a text Cancel,
  measures 44px+, and Escape cancels. Add-a-child fields are all labelled with required
  marks and an inline reason for the date of birth. The chooser defaults correctly when
  the signed-in player is refused: with Maya's Kids entry soft-deleted, the Kids card
  offers Register and the form opens on "Maya Harper" with "Extra event: **+$15** (added
  to Maya's registration)" — no dead end. Checkout's total (**$60.00**) matched
  `compute_checkout_total` (**6000**) exactly.

## Screens checked

- `/t/wmpc/loon-race-team-test?tab=register` (390, 1280) — seeded state; the dependent's
  amber card and pill; a dependent registration entered live and the Register-plus-
  dependent-line state measured at both widths; the "Registering for" chooser on Dana and
  on Maya with the cost line each way; both arms of the "I need a partner" explainer; the
  Kids card with the child's entry removed (parent aged out, child eligible).
- `/t/wmpc/loon-race-team-test/checkout` (390, 1280) — the $60.00 two-dependent basket,
  read against the sticky bar and against `compute_checkout_total`.
- `/my-tournaments` (390, 1280) — one dependent row and two, with the pill, the organizer
  line and the withheld Withdraw.
- `/profile` (390) and `/profile#my-family` (390) — the "On this page" line, the new date
  of birth field, My family populated, the add-a-child form, and the remove confirmation
  opened and escaped.
- `/admin/wmpc/tournaments/loon-race-team-test/attendees` (390, 1280) — By Player as
  stacked cards at 390 ("Maya Harper" → "11 years old" → "Registered by Dana Harper") and
  as the table at 1280; By Event; the base-equivalent table forced at 390 for the bar-
  overlap comparison.
- Screenshots were taken through the browser pane at both widths; they were not written to
  `.design/shots/ec7e8aeac47d3b87/` and nothing was committed.

## Data altered to reach a state, and restored

Two changes, both reversed. Maya Harper was registered for Open Doubles **through the UI**
(to render the dependent-line-above-Register state finding 1 was raised against, and the
two-event basket) and afterwards hard deleted. Maya's seeded Kids `pending_payment` row was
soft-deleted (`deleted_at = now()`) to render the parent-aged-out / child-eligible card, then
restored (`deleted_at = null`). No payment was attempted (Stripe is unconfigured locally) and
the one dependent registration form left open was closed with "Not now". Final state verified
against the seed as found: `event_registrations` **15 live / 15 total**, `partner_invites`
**0**, Maya's `pending_payment` Kids entry live with `registered_by_player_id` = Dana
(`11111111-…`), one `player_guardians` link, Dana `1979-03-11` / Maya `2015-06-01`.
