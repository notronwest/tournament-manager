# Migrations — how schema changes ship

The committed files in this directory are the **single source of truth** for the
production schema. Prod is changed *only* by applying these, *only* from CI.

## The flow

1. **Write a migration file** here: `YYYYMMDDHHMMSS_short_description.sql`. Use a
   timestamp later than every existing file (and later than anything already
   applied on prod). Match the header style of recent migrations.
2. **Open a PR.** The migration is reviewed like any other change.
3. **Merge to `main`.** CI (`.github/workflows/deploy-migrations.yml`) runs
   `supabase db push` and applies it to prod. Each migration runs in its own
   transaction, so a bad one rolls back cleanly.

That's it. You never run `supabase db push` yourself, and you never edit prod
schema by hand.

## Do not

- ❌ Edit schema in the **Supabase dashboard SQL editor** (or ad-hoc `psql` /
  `db execute`). This is how drift happens — prod changes that aren't in the
  repo, which then block everyone's next deploy.
- ❌ Run `supabase db push` from a laptop. Applying an uncommitted (or
  not-yet-merged) file is the other way drift happens.

## Guardrails (so the above can't quietly break)

- **Deploy-from-CI** (`deploy-migrations.yml`) — the only path that touches prod.
- **Drift alarm** (`migration-drift-check.yml`, daily) — pings Discord if prod
  ever diverges from this directory. Run locally anytime:
  `bash supabase/scripts/check-migration-drift.sh`.

## If a deploy fails with "Remote migration versions not found in local"

Prod has a migration that isn't committed here (drift). Reconcile it:

```
supabase db pull          # writes the orphan migration(s) into this directory
# review, commit under their original timestamps, open a PR, merge
```

Once the repo and prod agree again, deploys flow normally.

## Required CI secrets (one-time, repo Settings → Secrets → Actions)

- `SUPABASE_ACCESS_TOKEN` — Supabase personal access token
- `SUPABASE_DB_PASSWORD` — the project database password
- `SUPABASE_PROJECT_REF` — the remote project ref (not the local config name)
- `MIGRATION_ALERT_WEBHOOK` — Discord webhook for the drift alarm
