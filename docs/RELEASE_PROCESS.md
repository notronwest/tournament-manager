# Release process — test on `.test`, promote to prod on purpose

> **Status:** PLAN (decided 2026-06-11). Tracks via #227. This document is the
> design; the implementation is staged below and not yet built. Until it's
> live, `main` still auto-deploys to prod on every merge.

## The problem

Today **merge to `main` = live in prod**: the frontend (Cloudflare), DB
migrations (`migrations.yml`), and edge functions (`edge-functions.yml`) all
deploy/apply to **production** the moment a PR merges. There is no stage where a
change is exercised against a real backend before it reaches customers, and no
way to say "*these four issues* go live now, the rest waits." Migrations and
edge functions especially can't be tested before prod (the gap behind the #167
and 2026-06-11 incidents).

## The model — a `staging` branch that fronts a real test environment

Decouple **merged** from **live** with one long-lived pre-prod branch.

```
feature/*  ──PR──▶  staging  ──────────────▶  .test environment   (test Supabase + tm-test Cloudflare)
                       │                          ▲  E2E suite runs here
                       │
                       └──release PR──▶  main  ──▶  PRODUCTION       (prod Supabase + prod Cloudflare)
```

- **`staging`** is the **release candidate**. Feature PRs merge here. Every
  merge auto-deploys to **`.test`**: the app to the `tm-test` Cloudflare
  project, migrations to the **test** Supabase project, edge functions to the
  **test** project. The **E2E suite runs against `.test`** on each staging
  merge (and nightly).
- **`main`** is **production**, and it changes **only via a release PR from
  `staging`**. Merging that PR promotes the batch to prod exactly as today
  (Cloudflare prod + migrations + functions). No direct feature merges to
  `main`.

### "These 4 issues go live"

You control what's on `staging` (you merge it there), so `staging` *is* the
next release. Going live is one action: **open a release PR `staging → main`**,
title it with the batch (e.g. *"Release 2026-06-12 — #211 #214 #216 #220"*),
review the diff, merge. Want to hold something back? **Don't merge it to
`staging` yet** — keep its PR open. The gate is the staging merge for *testing*,
and the release PR for *going live*.

### What this buys

- **Real pre-prod testing** for *everything*, including the two things that
  previously couldn't be: **migrations** and **edge functions** now apply to
  the test project on staging merge, so they're exercised on `.test` before any
  release. This closes the recurring "can't test before prod" gap.
- **Deliberate, reviewable releases** — prod changes only through a batch you
  explicitly promote, with the full `staging → main` diff in front of you.
- **The E2E suite has a home** — it gates `.test`, the env it was always meant
  to run against.

## Pipeline rewiring (what implementation touches)

| Piece | Today | After |
|---|---|---|
| Prod frontend (Cloudflare prod project) | builds on `main` | unchanged (`main`) |
| Test frontend (`tm-test` Cloudflare project) | builds on `main` | **production branch → `staging`** |
| `migrations.yml` | push to `main` → **prod** DB | keep; **add** push to `staging` → **test** DB |
| `edge-functions.yml` | push to `main` → **prod** project | keep; **add** push to `staging` → **test** project |
| `regression.yml` / E2E | nightly vs `.test` | also **on push to `staging`** (release-candidate gate) |
| `main` | open to any PR | **release-PR-only** (from `staging`) |

New CI secrets (test-project deploy, distinct from the existing E2E *seed*
secrets): a test `SUPABASE_PROJECT_REF` + `SUPABASE_DB_PASSWORD` +
`SUPABASE_ACCESS_TOKEN` (or reuse the access token). The migrate/deploy
workflows pick prod-vs-test secrets by the triggering branch.

## Ripple effects (must change with it)

- **The Builder** branches off `origin/main` and opens PRs to `main`. It must
  switch to **base `staging`** (one `agents/builder/PROMPT.md` change). Its
  worktrees, orphan/rework scans, and the "deploy-on-merge server PR" split all
  re-point at `staging`.
- **The split conventions** (`[DB]`/`[FN]` server PRs ship first) still hold,
  now relative to `staging`: a migration/function merged to `staging` deploys
  to **test** first — which is exactly the testability the split was reaching
  for. Update `wmpc-meta/conventions/migrations.md`, `MIGRATIONS.md`,
  `FUNCTIONS.md`, and daemon Pillar 2 to say "deploys to `.test` on staging
  merge; to prod on release."
- **Test DB schema** stays current automatically (migrations apply to it on
  staging merge) — retiring the manual "re-push to the test project" step in
  `web/e2e/SETUP.md`.

## Edge cases

- **Hotfix.** An urgent prod fix can't wait behind the staging queue: branch
  off `main`, PR **straight to `main`** (a one-issue release PR), merge, then
  **back-merge `main → staging`** so the branches don't diverge.
- **Keeping `staging` and `main` in sync.** A release is a full merge of
  `staging` into `main`, so after each release they match. Avoid cherry-picking
  a *subset* of staging into a release — instead, only merge to `staging` what
  you're willing to release together. (If subset-releases become common, that's
  a feature-flag conversation, not a branch one.)
- **`main` protection.** Enforce release-PR-only with a branch rule (require PR,
  restrict who/what can push) — note `main` is currently unprotected; the
  existing `pre-push` guard already blocks stray code pushes, so this mainly
  formalizes "from `staging` only."

## Implementation plan (phased — tracked in #227)

0. **Branch.** Create `staging` off `main`; set the convention that feature PRs
   target `staging`. (Builder PROMPT base → `staging`.)
1. **Test frontend.** Repoint the `tm-test` Cloudflare project's production
   branch to `staging`; confirm it builds with the test env vars.
2. **Test backend deploys.** Add test-project secrets; add `staging`-triggered
   jobs to `migrations.yml` + `edge-functions.yml` that target the **test**
   project (prod jobs on `main` unchanged).
3. **Gate.** Run the E2E suite on push to `staging` (plus nightly); wire its
   pass/fail into the release decision.
4. **Promote.** Document + adopt the **release-PR ritual** (`staging → main`,
   titled with the batch) and the hotfix path; protect `main`.
5. **Docs/conventions.** Update the split conventions + Pillar 2 + SETUP.md to
   the staging-first language; retire the manual test-DB re-push.

## Relationship to the E2E suite

This is the **gate**; the [E2E flow suite](../web/e2e/README.md) (epic, filed
separately) is the **coverage** that runs in it. The suite can be built in
parallel — it already targets `.test` via `E2E_BASE_URL` — and becomes a hard
release gate at Phase 3.
