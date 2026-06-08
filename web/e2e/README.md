# Regression E2E — acceptance criteria as nightly tests

Each resolved issue's **`## Acceptance criteria`** becomes a Playwright spec
here, so a bug we fixed once can never silently come back. Runs nightly in CI
against the deployed app and reports pass/fail to Discord.

**Token-free at runtime** — these are deterministic Playwright tests, no LLM.
The only LLM cost is *writing* a spec from an issue's AC (once, when it
resolves) and the occasional maintenance fix.

## How it works

1. **Seed** (`seed.ts`) — uses the Supabase **service-role** key to create a
   deterministic fixture: a test org, a published tournament, a doubles event,
   two test players (auth users via the admin API), and a `pending_payment`
   registration with a picked partner. Idempotent: it upserts a fixed
   `e2e-test` org so re-runs are stable. Everything is namespaced/marked so
   it's obviously test data.
2. **Run** (`*.spec.ts`) — each spec drives the deployed UI through one
   resolved issue's acceptance criteria and asserts the expected behavior.
   `fixtures.ts` provides a `loginAs(test-organizer / test-player)` helper
   (email/password — the app supports `signInWithPassword`).
3. **Report** (`regression.yml`) — nightly GitHub Action: seed → `playwright
   test` → post a one-line pass/fail summary to the Backlog Discord channel.

## The convention

When an issue is merged, add `web/e2e/issue-<N>-<slug>.spec.ts` translating its
`## Acceptance criteria` steps 1:1 into Playwright. The AC is already scripted
("1. Log in. 2. Click Register. 3. → see X"), so this is mechanical.

## Running locally

```
cd web
npm i
npx playwright install --with-deps chromium
E2E_SUPABASE_URL=… E2E_SUPABASE_SERVICE_ROLE_KEY=… npx tsx e2e/seed.ts   # seed the fixture
BASE_URL=https://tournament-manager.pages.dev TEST_ORG_PW=… npm run test:e2e
```

## Required CI secrets

- `E2E_SUPABASE_URL`, `E2E_SUPABASE_SERVICE_ROLE_KEY` — for the seed.
- `E2E_BASE_URL` — the deployed app to test (prod or a preview).
- `E2E_TEST_PASSWORD` — password for the seeded test accounts.
- `DISCORD_WEBHOOK` — the Backlog channel webhook for the report.

## Status / what's left to go green

This PR is the **foundation**. To turn the first specs green:
1. Set the CI secrets above.
2. Run `seed.ts` once and fix any schema-specific gaps (NOT NULL columns,
   enum values) — the seed is written from the schema but needs one live pass.
3. Tune selectors in the specs against the real DOM (E2E always needs this).
Start with `issue-09-confirm-cancel.spec.ts` and `issue-15-…`, then expand to
every resolved issue.
