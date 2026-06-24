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
- **Choice tiles for mode selection** (2026-06-05). Buttons are for actions;
  selections that swap form content should look like selections. Render as
  compact icon-plus-label tiles in a 2-column grid (`display: grid`,
  `gridTemplateColumns: "1fr 1fr"`, `gap: 8`). Each tile: `padding: "8px 10px"`,
  `borderRadius: 6`, 1px border. **Inactive** = `#fff` background, `#d1d5db`
  border, `#444` text. **Active** = `#eff6ff` background, `#2563eb` border,
  `#1e40af` text. Use a Lucide icon (sized 18px) plus a short label —
  consider semantic accuracy when picking the icon (e.g. `HandHelping` for
  "I need a partner," NOT `Search` — that user isn't searching). Wrap in
  `role="radiogroup"`; give each tile `role="radio"` + `aria-checked` so the
  selection semantics reach screen readers. The established instance is the
  "I have a partner / I need a partner" picker in `PublicTournamentPage.tsx`
  (look for `partnerModeTileStyle`). Prior segmented-control approach (PR #58
  v1) was rejected — even with shared borders the segments still read as
  action buttons.
