# Migrations — how schema changes reach this project's database

This repo follows the WMPC migration convention
([`../../wmpc-meta/conventions/migrations.md`](../../wmpc-meta/conventions/migrations.md)):
**migrations are code — drafted in a PR, reviewed, and applied by CI on merge.
Never hand-run `supabase db push` from a session.** (Hand-applying is what
caused drift — see PR #71/#77 "Reconcile migration drift".)

## How it works

- Migration `.sql` files live in `supabase/migrations/`.
- A migration ships in its **own DB PR, separate from the UX that depends on
  it** (the regenerated `types` ride with the migration; the dependent app
  code is a second PR). The DB PR is **marked** (see below) and leads with
  **"⚠️ Contains a DB migration."**
- On merge to `main`, `.github/workflows/migrations.yml` runs
  `supabase db push` against the `tournament-manager` Supabase project.
- The Builder may **draft** additive/reversible migrations; risky ones
  (destructive DDL, RLS, `SECURITY DEFINER`, money, backfills) it Blocks for
  Ron to design.

## Schema first, UX second

The preview deploys only the frontend, against the **live** DB, and a
migration applies **only on merge** — so a bundled schema+UI PR can't be
validated before merge (the new UI calls a column that isn't there yet; this
is what made #167 untestable). Split it (expand/contract):

1. **DB PR** — migration (+ types) only → merge → schema is live.
2. **UX PR** — dependent code, now testable on the preview against the real
   schema → validate → merge.

Safe because migrations here are additive/backward-compatible (the old UI
ignores the new column). It makes the **UX** testable pre-merge, not the
**migration** itself (no staging DB) — see the canonical convention.

## Spotting & ordering DB PRs on the Review board

A migration is the one kind of merge that touches shared state and applies in
a fixed sequence, so DB PRs are flagged and merged **first, in order**, before
UX work:

- **Marked two ways** so they're unmissable on the board and in the PR list:
  - the **`db-migration`** label (filter/group the board by it), and
  - a **`[DB]`** prefix on the PR title.
- **Merge in migration-timestamp order — this is the protection, not a flag.**
  The order key is the migration filename's `YYYYMMDDHHMMSS` prefix. When two DB
  PRs sit in Review, merge the **lower** timestamp first, so the remote history
  stays linear and `db push` never sees an out-of-order file. (We briefly ran
  `db push --include-all` as an auto-backstop; it backfired by re-applying
  already-recorded migrations → `schema_migrations` duplicate-key wedge on
  2026-06-11, so it was removed.)
- **Write idempotent DDL** so a re-run is harmless: `add column if not exists`,
  `create or replace function`, `drop … if exists`.
- **If a migration genuinely lands out of order**, the run fails closed (Discord
  alert) → fix forward by renumbering the file's timestamp to after the head, or
  `supabase migration repair` from a linked machine.

Shared canonical rule: [`../../wmpc-meta/conventions/migrations.md`](../../wmpc-meta/conventions/migrations.md).

## Turn-on checklist — currently INERT (fail-closed)

The workflow exits green doing nothing until BOTH are true:

1. **Reconcile drift.** From a machine linked to THIS project:
   ```
   supabase link --project-ref <ref>     # tournament-manager
   supabase db diff                      # must be EMPTY (DB == supabase/migrations/)
   ```
   If it isn't clean, check in the missing migration(s) first. **Do not enable
   auto-apply on a drifted database.**
2. **Set repo Actions secrets** (Settings → Secrets and variables → Actions):
   - `SUPABASE_ACCESS_TOKEN` — a Supabase personal access token
   - `SUPABASE_DB_PASSWORD` — this project's database password
   - `SUPABASE_PROJECT_REF` — this project's ref
   - `DISCORD_WEBHOOK` — failure alerts (reuse the Backlog webhook)

Once both are done, every merge that touches `supabase/migrations/**` applies
pending migrations automatically. On failure it posts to Discord — fail-closed.

## Types

After an apply, regenerate the typed client and commit it (never hand-edit):
```
cd web && npx supabase gen types typescript --linked > src/types/supabase.ts
```
(Automating type-regen on apply is the next step to add.)
