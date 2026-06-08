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
  is fine). From **Settings**, capture (into a password manager, **not** chat):
  - **Project ref** and **URL** (Settings → **Data API**).
  - **Publishable key** (`sb_publishable_…`, Settings → **API Keys**) — the
    public/anon key for the app build.
  - **Secret key** (`sb_secret_…`, same **API Keys** page) — the full-access
    server key the seed uses (this is the "service-role" key in the new key
    system; **never** ships to the frontend).
  - A **DB password** you set (for the `db push` in step 2).

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
not prod. Stand up a **separate Cloudflare Pages project** (free — the Pages
free plan allows many sites). Cloudflare → **Workers & Pages → Create → Pages →
Connect to Git** → the `tournament-manager` repo, then mirror prod's build with
test env vars:

| Setting | Value |
|---|---|
| Project name | `tm-test` (→ `https://tm-test.pages.dev` = `E2E_BASE_URL`) |
| Production branch | `main` (same code as prod; differs only by env → test DB) |
| Root directory | `web` *(the app lives in `web/`)* |
| Build command | `npm run build` |
| Build output directory | `dist` (i.e. `web/dist`) |
| Env var `VITE_SUPABASE_URL` | test project URL (Settings → **Data API**) |
| Env var `VITE_SUPABASE_ANON_KEY` | test **Publishable key** (`sb_publishable_…`, Settings → **API Keys**) |

Save and Deploy. SPA routing already works (`web/public/_redirects`). Note: this
project rebuilds on every push to `main` like prod (same code, test DB) — fine
within the free 500 builds/month.

## 4. Set the GitHub Actions secrets (repo → Settings → Secrets → Actions)

| Secret | Value |
|---|---|
| `SUPABASE_URL` | test project URL (step 1) |
| `SUPABASE_SERVICE_ROLE_KEY` | test **Secret key** `sb_secret_…` (step 1) — **sensitive, bypasses RLS** |
| `E2E_BASE_URL` | the `tm-test` Pages URL (step 3) |
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
