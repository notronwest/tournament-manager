# Migrations — how schema changes reach this project's database

This repo follows the WMPC migration convention
([`../../wmpc-meta/conventions/migrations.md`](../../wmpc-meta/conventions/migrations.md)):
**migrations are code — drafted in a PR, reviewed, and applied by CI on merge.
Never hand-run `supabase db push` from a session.** (Hand-applying is what
caused drift — see PR #71/#77 "Reconcile migration drift".)

## How it works

- Migration `.sql` files live in `supabase/migrations/`.
- A PR that adds one leads with **"⚠️ Contains a DB migration."**
- On merge to `main`, `.github/workflows/migrations.yml` runs
  `supabase db push` against the `tournament-manager` Supabase project.
- The Builder may **draft** additive/reversible migrations; risky ones
  (destructive DDL, RLS, `SECURITY DEFINER`, money, backfills) it Blocks for
  Ron to design.

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
