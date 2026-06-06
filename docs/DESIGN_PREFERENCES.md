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
