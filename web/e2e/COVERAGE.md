# E2E coverage map — tournament-manager

What the regression suite actually exercises, against the full product surface —
so "how comprehensive is the testing?" has an honest answer. Derived from the
route/page/edge-function inventory **and** the WMPC roadmap board.

**This is the comprehensiveness tracker and the backlog driver.** When a spec
lands, flip its row to ✅ and link the file. When a new journey ships, add a ❌
row so the gap is visible.

## Legend

- ✅ **covered** — a green spec asserts this journey
- ⚠️ **partial** — touched but not fully asserted
- ❌ **not covered** — built and shippable, no spec yet
- 🔭 **not built** — on the roadmap, no product yet (don't count against coverage)
- 📧 needs email · 💳 needs Stripe (test mode, gated on #255)

## Summary (today)

**15 green specs across the public player surface.** Account/auth (incl. signup +
reset), discovery, the full registration spread (doubles existing/new/seeker,
singles, change-partner, cancel, discard-pick), all green. Remaining gaps:
payment (💳 blocked on #255), player self-service, refunds, and the entire
organizer/admin surface — the bulk of the product by journey count.

| Area | Covered | Built, untested | Notes |
|---|---|---|---|
| Account & auth | 4 | 2 | login/out, signup, forgot-reset ✅ |
| Public discovery | 3 | 2 | |
| Registration (player) | 8 | 0 | full spread incl. invite-accept ✅ |
| Checkout & payment | 0 | ~6 | 💳 all blocked on #255 |
| My account / self-service | 3 | 0 | ✅ |
| Refunds & change requests | 0 | 4 | 💳📧 |
| Organizer — setup | 0 | ~10 | none |
| Organizer — operations | 0 | ~8 | none |
| Organizer — financial/comms | 0 | 4 | |
| Platform admin & Quote Studio | 0 | ~8 | none |

---

## Account & auth (#251)

| Journey | Status | Spec / note |
|---|---|---|
| Log in (email + password) | ✅ | `flows/auth.spec.ts` |
| Log out | ✅ | `flows/auth.spec.ts` |
| Create account (signup → confirm) | ✅ 📧 | `flows/auth-email.spec.ts` (generateLink) |
| Forgot / reset password | ✅ 📧 | `flows/auth-email.spec.ts` (generateLink) |
| Magic-link signup | ❌ 📧 | |
| Google OAuth sign-in | ❌ | external provider — likely out of scope |
| Complete / edit profile | ❌ | RequireProfile gate; avatar, ratings |
| Request email change | ❌ 📧 | |

## Public discovery (#252 — closed)

| Journey | Status | Spec / note |
|---|---|---|
| Browse home (published tournaments) | ✅ | `flows/discovery.spec.ts` |
| Search / filter | ✅ | `flows/discovery.spec.ts` |
| Open a tournament | ✅ | `flows/discovery.spec.ts` |
| View an event's detail | ⚠️ | reached, not deep-asserted |
| Contact organizer (form) | ❌ 📧 | |
| Custom-domain → tournament | ❌ | board #408/#31 |

## Registration — player (#253)

| Journey | Status | Spec / note |
|---|---|---|
| Doubles — existing partner | ✅ | `flows/registration.spec.ts` |
| Doubles — new partner | ✅ | `flows/registration.spec.ts` |
| Doubles — "I need a partner" (seeker) | ✅ | `flows/registration.spec.ts` |
| Cancel a pending registration | ✅ | `issue-09-confirm-cancel.spec.ts` (Path 2) |
| Discard partner pick in the form | ✅ | `issue-09-confirm-cancel.spec.ts` (Path 1) |
| Singles registration | ✅ | `flows/registration.spec.ts` |
| Accept a partner invite | ✅ 📧 | `flows/registration.spec.ts` (handles the new-invitee profile step) |
| Change partner before payment | ✅ | `flows/registration.spec.ts` |

## Checkout & payment (#254 — gated on #255 💳)

| Journey | Status | Spec / note |
|---|---|---|
| Proceed to checkout | ❌ 💳 | |
| Pay (Stripe Payment Element) | ❌ 💳 | webhook flips reg → paid |
| Additional-event pricing | ❌ 💳 | |
| Apply coupon | ❌ 💳 | |
| Charity donation | ❌ 💳 | board #378 |

## My account / self-service

| Journey | Status | Spec / note |
|---|---|---|
| View my tournaments / registrations | ✅ | `flows/self-service.spec.ts` |
| View my partner invites | ✅ | `flows/self-service.spec.ts` |
| Withdraw from an event (pending reg) | ✅ | `flows/self-service.spec.ts` (paid-reg refund still 💳) |

## Refunds & change requests

| Journey | Status | Spec / note |
|---|---|---|
| Request a refund (player) | ❌ 📧 | |
| Organizer approve / deny withdrawal | ❌ 💳📧 | |
| Change-request queue (organizer view) | ❌ | |
| Self-withdraw refund policy (auto vs manual) | ❌ 💳 | |

## Organizer / admin — tournament setup

_None covered._ Create org · Stripe Connect onboarding 💳 · create tournament
(wizard) · create tournament (simple) · edit tournament · change status
(draft→published→closed→completed) · create event · edit event · bulk-edit
events · event console.

## Organizer / admin — operations

_None covered._ Manage locations · event courts · tournament court manager ·
build schedule · pair teams / pairing board 📧 · generate scorecards ·
round-robin estimator · attendees (players view) · attendees (events view).

## Organizer / admin — financial & comms

_None covered._ Create/edit coupons · donations report · manage tournament
contacts 📧 · platform fee settings.

## Platform admin & Quote Studio

_None covered._ Org picker · site dashboard · site-wide attendees · player
detail/edit 📧 · Quote Studio (list, create, edit, catalog, send 📧, customer
view `/q/:token`, contract) · org danger-zone delete.

## System / background (mostly indirect)

_Not directly E2E-tested; exercised as side effects or out of scope._
Stripe webhook 💳 · sweep stale pending regs · welcome/partner/withdrawal/
cancellation emails 📧 · contact-form & feedback submission 📧 · admin-update-player.

## Planned — not built yet (🔭, roadmap board)

Don't count against coverage; add rows when they ship. Register-then-checkout
(#29) · shopping-cart registration (#27) · multi-day (#51) · public standings
(#48) · no-show/forfeit (#50) · clone tournament (#17) · DUPR connect (#7/#8) ·
play-up / require-DUPR (#14) · cancellation-policy wizard step (#33) ·
multi-org admin UX (#44) · rich-text editor (#106) · per-tournament FAQ (#215).

---

## Recommended next (by value)

1. **Account & auth** — signup + forgot-password (📧 via `generateLink`). Closes
   the last of Ron's original list; no new infra.
2. **Registration remainder** — singles, invite-accept (📧). High-traffic paths.
3. **Stripe-test enabler (#255)** → **checkout/pay** (💳). Unlocks the money path
   — the highest-risk area with zero coverage.
4. **One organizer happy-path** — create tournament → add event → publish. The
   entire admin surface is untested; even one smoke spec is high value.
