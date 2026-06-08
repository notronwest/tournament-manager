# Regression harness — one-time setup (separate test project)

The nightly suite (`.github/workflows/regression.yml`) is **inert until these
secrets exist**, by design. This is the one-time bootstrap to take it live,
using a **separate Supabase test project** (decided 2026-06-07) so the seed and
tests never touch production data and registration/payment paths are safe to
exercise.

You (Ron) do steps 1–4 (they need a Supabase account + GitHub secrets, which an
agent can't create). Then a Claude session does step 5 (first green).

## 1. Create the test Supabase project

- New Supabase project, e.g. **`tournament-manager-test`** (same region as prod
  is fine). Note its **project ref**, **URL**, **anon key**, **service-role
  key**, and set a **DB password** you keep.

## 2. Put the schema on it

The test project needs the same schema as prod. One-time, locally:

```
cd tournament-manager
supabase link --project-ref <TEST_PROJECT_REF>
supabase db push        # applies supabase/migrations/** to the test DB
supabase link --project-ref <PROD_PROJECT_REF>   # re-link back to prod when done
```

(Keeping it in sync later: point the migration robot at the test project too, or
re-run `db push` against it when migrations land. Start simple — re-push when
schema changes.)

## 3. Deploy a test app instance pointed at the test project

The suite drives a **deployed app**, and that app must talk to the **test** DB —
not prod. Stand up a separate Cloudflare Pages deploy (or a dedicated branch/
preview) whose env vars point at the test project:

- `VITE_SUPABASE_URL` = test project URL
- `VITE_SUPABASE_ANON_KEY` = test project anon key

Note its URL (e.g. `https://tm-test.pages.dev`) — that's `E2E_BASE_URL`.

## 4. Set the GitHub Actions secrets (repo → Settings → Secrets → Actions)

| Secret | Value |
|---|---|
| `SUPABASE_URL` | test project URL (step 1) |
| `SUPABASE_SERVICE_ROLE_KEY` | test project service-role key (step 1) — **sensitive** |
| `E2E_BASE_URL` | the test app deploy URL (step 3) |
| `E2E_TEST_PASSWORD` | a password for the seeded test accounts (you choose) |
| `DISCORD_WEBHOOK` | the Backlog channel webhook (for the pass/fail post) |

Once all five exist, the nightly stops being inert and runs on schedule.

## 5. First green (a Claude session does this)

```
cd web
npm i && npx playwright install --with-deps chromium
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… E2E_TEST_PASSWORD=… npx tsx e2e/seed.ts
E2E_BASE_URL=<test deploy> E2E_TEST_PASSWORD=… npm run test:e2e
```

Expect to fix seed schema gaps + tune selectors on this first run (E2E always
needs it). Get `issue-09-confirm-cancel.spec.ts` green, then the backfill
(Testing agent, Job 2) translates every other resolved issue's AC into a spec.

## Safety notes

- **Never point these secrets at prod.** The whole reason for a separate
  project is that the seed writes real rows and tests exercise registration.
- The service-role key bypasses RLS — it lives only in GitHub secrets and your
  local shell for the seed, never in the repo.
- See `README.md` for the spec convention and `../../daemon/agents/testing/`
  for the agent that triages failures + authors specs.
