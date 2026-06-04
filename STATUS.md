# Status — tournament-manager

Append-only session handoff log. **Read this first; append a dated entry
before you wrap.** Newest on top; new entries supersede old — don't rewrite.

Current state: **Foundation — schema + auth + organizer-side tournament
create/list/view. Design tokens + Lucide adopted.**
Last updated: **2026-06-03**

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
