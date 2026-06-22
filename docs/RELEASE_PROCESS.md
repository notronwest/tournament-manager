# Release process — `main` is TEST, `production` is PROD

> **Status: LIVE.** This documents what actually shipped. (An earlier draft of
> this file proposed a separate `staging` branch; that design was **not** built —
> the same goals were met more simply by branch-routing `main`→TEST and
> `production`→PROD. This doc replaces it.)

## The model

The repo is **branch-routed** by CI:

```
feature/* ──PR──▶ main ─────────▶ TEST   (test Supabase + test Cloudflare)
                   │                       migrations.yml / edge-functions.yml apply to the TEST project
                   │
                   └──release PR──▶ production ──▶ PROD  (prod Supabase + prod Cloudflare)
                                                          the same workflows apply to the PROD project
```

- **`main` = TEST.** Feature PRs merge to `main`. Every merge auto-deploys the
  frontend to the test Cloudflare project and applies migrations / deploys edge
  functions to the **test** Supabase project. This is where everything is
  exercised against a real backend before prod.
- **`production` = PROD.** It changes **only** via a deliberate **`main` →
  `production` PR**. Merging that PR promotes the batch to prod — frontend,
  migrations, and functions all apply to the **prod** project on the push.

The deploy/migrate workflows (`.github/workflows/migrations.yml`,
`edge-functions.yml`) pick PROD-vs-TEST secrets by the triggering branch:
`refs/heads/production` → PROD, anything else (i.e. `main`) → TEST. Both are
**fail-closed/inert** if the target's secrets aren't set.

## How to promote test → prod

1. **Open a `main` → `production` PR.** Title it with the batch
   (e.g. *"Promote 2026-06-22 — waitlists + custom domains"*).
2. **Pre-flight the diff** (see the checklist below). The PR diff *is* "what's
   about to ship to prod."
3. **Merge it** (the merge is the prod deploy; `gh pr merge` is `ask`-gated, so a
   human approves). CI applies the pending migrations to PROD in order, deploys
   the functions, and Cloudflare builds the prod frontend.

There is no separate "apply migrations" step — **migrations ride the branch** and
apply to PROD because the push is to `production`.

## Pre-flight checklist (before merging a promotion PR)

- **Blast radius.** A `main`→`production` merge promotes **everything** on `main`
  that isn't yet on `production`, not just the feature you have in mind. Check the
  delta: `gh api repos/<owner>/<repo>/compare/production...main --jq '.ahead_by'`
  and review the migration/function file list. To hold something back, **don't
  merge it to `main` yet** — you can't cleanly cherry-pick a subset into a
  promotion (and shouldn't; that's a feature-flag conversation).
- **Migrations are additive & in order.** Scan the pending migrations for
  destructive DDL (`drop`/`rename`/type-changes/`not null` on populated columns).
  Confirm timestamps are monotonic vs. what's already applied — an out-of-order
  migration **fails closed** and wedges the pipeline (see below).
- **PROD secrets set.** `SUPABASE_PROJECT_REF` + `SUPABASE_DB_PASSWORD` must
  exist, or the prod push goes **inert** (frontend deploys, schema doesn't →
  broken prod). `gh secret list` shows names.
- **Server-ahead-of-UX is safe.** A `[DB]`/`[FN]` change may promote before its
  dependent UX (the split model). Make backward-compatible signatures (new RPC
  params `default null`, additive columns) so the old frontend keeps working.
- **Re-check at merge time.** `main` can move between your pre-flight and the
  merge; the PR diff is the pinned source of truth.

## Migration timestamp-order discipline (the wedge to avoid)

`supabase db push` (no `--include-all`) applies only migrations the remote history
hasn't recorded, **in order**. A migration whose timestamp is **earlier** than the
last one already applied to a target **fails closed**:

> `Found local migration files to be inserted before the last migration on remote database`

This is a real, recurring hazard: a DB PR branched days ago (or stamped with an
artificially-early timestamp) and merged **after** newer migrations already landed
→ the whole pipeline wedges until fixed (it happened 2026-06-11 and again
2026-06-22). Fixes:

- **Merge DB PRs in migration-timestamp order**, and prefer a *current* timestamp
  on the migration file (not an artificially-early one).
- **If it wedges: renumber the offending file** to a timestamp after the current
  remote HEAD (safe when it never applied — fail-closed means no partial), or use
  `supabase migration repair` (needs DB creds). The CI failure log names the
  offending file and posts a Discord alert.

## Guards

- **`pre-push`** (`daemon/infrastructure/git-guards/`) refuses a direct push of
  code/schema to **`main` or `production`** — they reach either branch only via a
  PR (`STATUS.md`-only pushes pass; `WMPC_ALLOW_MAIN_PUSH=1` overrides). A GitHub
  `main`→`production` promotion PR is server-side, so the local hook never blocks
  it.
- **`gh pr merge`** is `ask`-gated fleet-wide, so no agent merges (and thus
  deploys to prod) without a human approving.

## Relationship to the E2E suite

`main`/TEST is where the [E2E flow suite](../web/e2e/README.md) exercises changes
against the test backend before they're promoted. Keeping the test DB current is
automatic (migrations apply to it on every `main` merge).
