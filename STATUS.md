# Status — tournament-manager

Append-only session handoff log. **Read this first; append a dated entry
before you wrap.** Newest on top; new entries supersede old — don't rewrite.

Current state: **V5 brand wired — brush wordmark in navbar, homepage
rebuilt to mockup 01 on shared publicTheme tokens. Foundation
(schema + auth + organizer-side tournament create/list/view) still
in place underneath.**
Last updated: **2026-06-03**

## 2026-06-05 — Partner-mode picker UX direction picked (PR #58)

- PR #58 turned the "Pick a partner / I need a partner" toggle into a
  connected segmented control. Visually it still reads as two buttons,
  which isn't the intent — selections that swap form content shouldn't
  look like actions.
- Wrote `mockups/partner-mode-options.html` — seven alternatives, each
  shown with both states (picker-active and need-active) inside a mock
  register card.
- **Decision: option 5 — compact choice tiles** (icon + label, 1px
  border, blue-wash when active). Refined the mockup with: smaller
  one-line tiles, and 🙋 for "I need a partner" (the prior 🔎 was
  wrong — that user isn't searching, they're raising a hand to be
  matched).
- **Next**: implement on the PR's branch
  (`feature/issue-15-segmented-control`) against
  `web/src/pages/public/PublicTournamentPage.tsx` (~L1481 container,
  ~L1670 `partnerModeBtnStyle`). Use Lucide icons (`Handshake` +
  `HandHelping`) instead of emojis for cross-platform consistency.
  Update the segmented-control note in `docs/DESIGN_PREFERENCES.md`
  that PR #58 added — replace with the choice-tile pattern.

## 2026-06-03 — V5 homepage + publicTheme refactor

- Rebuilt `web/src/pages/public/HomePage.tsx` to mockup 01 from
  `mockups/layouts-v5.html` — cream hero w/ court-yellow radial glow,
  Alfa Slab One headline with court-red accent line, two ink CTAs,
  upcoming-tournament grid with G/Y/R color-cycling stripes. Search +
  loading/error/empty states preserved.
- Added Google Fonts preload (Alfa Slab One, Anton, IBM Plex Mono,
  Inter) to `web/index.html`; `<title>` is now "bert & erne —
  pickleball tournaments".
- Refactored HomePage to consume the shared tokens / primitives from
  `web/src/lib/publicTheme.ts` (the brush-wordmark commit landed it).
  Hero-specific variants (oversized H1, big CTAs, billboard H2)
  built by spreading the shared bases so future palette tweaks
  cascade.
- Boxed V5 outlined logo retired and `git mv`'d to
  `mockups/archive/v5-outlined-boxed/` — runtime brand mark is the
  brush wordmark in SiteHeader. Build output confirms the boxed SVG
  is no longer bundled.
- Reference gallery checked in at `mockups/layouts-v5.html` (5
  surfaces: public homepage, public tournament detail, organizer
  dashboard, printed program, registration email) for when the
  other four get built out.

**Next on the V5 rollout**: apply the mockup 02 treatment to
`PublicTournamentPage`, and decide whether the boxed V5 logo (now in
the archive) should come back as the favicon.

## 2026-06-03 — Design system adopted

- `web/src/tokens.css` added (overrides: primary `#2563eb`, danger `#dc2626`,
  overlay) and `ConfirmModal` migrated onto tokens (value-preserving).
- Lucide (`lucide-react`) adopted.
- `docs/DESIGN_PREFERENCES.md` points at `../wmpc-meta/design-system/`.
- Landed as a merged PR.

## ⏳ In flight / pending

- **Auth providers not configured in the Supabase dashboard** — magic link +
  Google OAuth won't deliver until the manual config in [`CLAUDE.md`](./CLAUDE.md)
  ("Manual Supabase dashboard config") is done. Email/password works.

## 🔜 Next

- Living roadmap is [`docs/BACKLOG.md`](./docs/BACKLOG.md) — the source of
  truth for what's next / coming / shipped. Spirit: smallest end-to-end loop
  first.

## Deeper references

- [`CLAUDE.md`](./CLAUDE.md) — six locked decisions, schema, routes, deploy.
- [`docs/BACKLOG.md`](./docs/BACKLOG.md) ·
  [`docs/DESIGN_PREFERENCES.md`](./docs/DESIGN_PREFERENCES.md).
- [`../wmpc-meta/strategy.md`](../wmpc-meta/strategy.md).
