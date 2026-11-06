# Design Preferences

> **Shared system first.** The universal WMPC design system — token
> vocabulary, ConfirmModal / row-indicator / focus conventions, the Lucide
> icon system, logo & asset conventions — lives in
> [`../../wmpc-meta/design-system/DESIGN_SYSTEM.md`](../../wmpc-meta/design-system/DESIGN_SYSTEM.md),
> with tokens in
> [`../../wmpc-meta/design-system/tokens.css`](../../wmpc-meta/design-system/tokens.css).
> tournament-manager's copy of the tokens (with its own values) is
> [`web/src/tokens.css`](../web/src/tokens.css). **Reference `var(--token)`,
> never raw hex.** This file holds only what's specific to tournament-manager.

When a rule here contradicts an ad-hoc styling choice in code, the code is
wrong — bring it back in line. Date entries when you add new ones.

---

## Mobile-first (hard rule — standing issue #500)

**Design, build, and test every UI at phone width (~390px) FIRST**, then scale
up to desktop. Never desktop-first-then-shrink. Most WMPC users are on phones.

- **No row that places actions/controls beside content may shrink the content
  column to ~0 on mobile** — such rows must **stack** (or wrap) on mobile.
  Failure to learn from: the `EventCard` header put the Change-partner /
  Cancel-registration buttons beside a `minWidth:0` text column, so at 390px the
  meta line wrapped one character per line and the buttons overlapped the title
  (perfect on desktop). Fixed by stacking the row on mobile (`isMobileViewport`).
- **Test populated states, not just empty ones.** A card looks fine empty and
  breaks once it has status pills + action buttons. The E2E mobile audit
  (`web/e2e/mobile/`, iPhone+Pixel) must render each component state.
- **Tap targets ≥ 44px**; floating elements (e.g. the Feedback button) must not
  overlap primary CTAs at phone width.
- Page-overflow checks are necessary but **not sufficient** — clipped (not
  scrolled) overflow passes them; review actual phone-width screenshots.

---

## tournament-manager specifics

- **Palette identity.** tournament-manager runs a slightly different blue
  and red than the canonical defaults — `--primary: #2563eb`,
  `--danger: #dc2626`, and a darker `--overlay`. These are deliberate
  overrides in [`web/src/tokens.css`](../web/src/tokens.css); to restyle the
  app, change the values there, not the components.
- **ConfirmModal.** [`components/ConfirmModal.tsx`](../web/src/components/ConfirmModal.tsx)
  follows the shared confirmation convention and now draws its colors from
  tokens (`--primary` / `--danger` / `--overlay` / `--surface`). It adds a
  `busy` state ("Working…") that disables the buttons during an async
  `onConfirm` — keep that behavior when touching it.
- **Court grid.** `.tcm-courts-grid` skips the 3-column breakpoint on
  purpose so exactly 4 courts render as a clean 2×2 (see `index.css`). That's
  layout, not a shared rule.
- **Choice tiles for mode selection** (2026-06-05, corrected 2026-11-06).
  Buttons are for actions; selections that swap form content should look like
  selections. Render as compact tiles in a 2-column grid (`display: grid`,
  `gridTemplateColumns: "1fr 1fr"`, `gap: 8`), `borderRadius: 6`.

  | | Inactive | Active |
  |---|---|---|
  | background | `#fff` | `#eff6ff` |
  | border | `inkMuted #6b7280`, 1px | `#2563eb`, **2px** |
  | text | `ink` | `#1e40af` |
  | weight | 500 | **600** |
  | padding | `10px 12px` | `9px 11px` |
  | glyph | — | a Lucide **`Check`** (16px, `strokeWidth: 3`) |

  The active padding is 1px tighter on each side so the second border pixel
  comes out of the padding and **the label does not shift** when you choose a
  tile. Reserve a fixed-width slot for the glyph in both states so the labels
  line up. Each tile is ≥ 44px tall. Wrap the pair in `role="radiogroup"`;
  give each tile `role="radio"` + `aria-checked` so the selection reaches
  screen readers. Where a tile carries its own meaning-bearing icon as well,
  size it 18px and pick it for semantic accuracy (e.g. `HandHelping` for "I
  need a partner," NOT `Search` — that user isn't searching).

  **What changed, and why it matters.** This block used to prescribe a
  `#d1d5db` inactive border and distinguish the chosen tile by colour alone.
  Both are wrong. `#d1d5db` on white is **1.5:1**, under the 3:1 a control's
  resting edge needs; and darkening it to `inkMuted` to clear that floor
  leaves the two borders **1.07:1** apart, so in greyscale — or to a
  red-green or blue-blind reader — the chosen tile becomes unreadable. The
  tick, the border weight and the font weight carry the selection; the blue
  only reinforces it. Caught by the design gate on the platform-fee screen.

  The reference instance is the platform-fee screen's inherit/custom pair
  (`PlatformFeeEditor.tsx`). The older "I have a partner / I need a partner"
  picker (`partnerModeTileStyle` in `PublicTournamentPage.tsx`) still carries
  the superseded values and is due the same fix; five other local copies of
  this pattern exist, and a shared `ChoiceTile` would retire all of them.
  Prior segmented-control approach (PR #58 v1) was rejected — even with
  shared borders the segments still read as action buttons.
