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
- **Segmented controls vs. action buttons** (2026-06-05). Buttons are for
  actions; selections that show or hide UI should look like selections. Use a
  connected segmented control: `display: inline-flex`, shared container border
  (`1px solid #d1d5db`, `borderRadius: 6`, `overflow: hidden`), segment buttons
  with `border: none, borderRadius: 0`. Add `borderLeft: "1px solid #d1d5db"`
  on the second (and each subsequent) segment for the internal divider. The
  established instance is the "Pick a partner / I need a partner" toggle in
  `PublicTournamentPage.tsx`.
