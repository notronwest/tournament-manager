# Deployment — tournament-manager

This repo ships **three things**, all triggered by a branch push and routed by
which branch you pushed to: the **Vite SPA** (Cloudflare Pages builds it), the
**Supabase schema** (GitHub Actions runs `supabase db push`), and the **Supabase
edge functions** (GitHub Actions deploys them). `main` → **TEST**, `production`
→ **PROD**, promoted by a deliberate `main`→`production` PR. Migrations ride the
branch — there is no separate "apply the migrations" step, and hand-running
`db push` is what caused drift in the first place.

```yaml
# wmpc-deployment: v1
repo: tournament-manager
archetype: cloudflare-pages
branches:
  main: TEST — test Pages project rebuilds; migrations + edge functions apply to the test Supabase project
  production: PROD — prod Pages project rebuilds; migrations + edge functions apply to the prod Supabase project
targets:
  - name: web
    kind: cloudflare-pages
    trigger: push to main (TEST) or production (PROD); every open PR also builds a preview
    source: web/ (root directory web, build `npm install && npm run build`, output dist)
    env: TEST | PROD | PREVIEW
    url: https://test.bertanderne.com (TEST) | https://bertanderne.com (PROD) | https://<branch>.tournament-manager-test.pages.dev (PREVIEW — served by the TEST project, confirmed from a PR's Cloudflare check)
    host: cloudflare
    config_scope: per Pages project in the Cloudflare dashboard — test project holds TEST VITE_*, prod project holds PROD VITE_*, and the Preview scope is configured separately from both
    verify: load the URL; confirm the Supabase URL the running app reports is the intended project
    rollback: Cloudflare dashboard → Pages project → Deployments → Rollback to this deployment
  - name: migrations
    kind: supabase-migrations
    trigger: push to main or production touching supabase/migrations/**
    source: supabase/migrations/
    env: TEST | PROD
    url: n/a
    host: cloudflare
    config_scope: GitHub Actions repo secrets — TEST_SUPABASE_PROJECT_REF + TEST_SUPABASE_DB_PASSWORD for TEST; SUPABASE_PROJECT_REF + SUPABASE_DB_PASSWORD for PROD; SUPABASE_ACCESS_TOKEN is account-level and covers both
    verify: the migrations.yml run is green (it is fail-closed — inert, not failing, when the target's secrets are unset)
    rollback: a new forward migration — never edit or delete an applied one
  - name: edge-functions
    kind: supabase-edge-functions
    trigger: push to main or production touching supabase/functions/**
    source: supabase/functions/
    env: TEST | PROD
    url: n/a
    host: cloudflare
    config_scope: same GitHub Actions secrets as migrations; each function's runtime secrets are set per Supabase project
    verify: the edge-functions.yml run is green; call the function against the target project
    rollback: revert the commit and let the workflow redeploy the prior version
  - name: organizer-custom-domains
    kind: cloudflare-pages
    trigger: manual, one domain at a time (Tier 1 — bespoke)
    source: the custom_domains table + web/src/lib/customDomain.tsx host routing
    env: PROD
    url: e.g. https://pickleballangels.com
    host: cloudflare
    config_scope: a Pages **custom domain** on the prod project (Cloudflare provisions TLS; no API involved) plus a custom_domains row mapping host → tournament_id
    verify: load the custom host root; it should render that tournament's public page
    rollback: remove the Pages custom domain, or delete the custom_domains row to unmap it
```

## What ships from this repo

| Target | Trigger | Lands at |
|---|---|---|
| `web` | push to `main` | TEST — `https://test.bertanderne.com` |
| `web` | push to `production` | PROD — `https://bertanderne.com` |
| `web` | any open PR | preview — `https://<branch>.tournament-manager-test.pages.dev` |
| `migrations` | push to `main`/`production` under `supabase/migrations/**` | that branch's Supabase project |
| `edge-functions` | push to `main`/`production` under `supabase/functions/**` | that branch's Supabase project |
| `organizer-custom-domains` | hand-wired per domain | that organizer's domain, e.g. `pickleballangels.com` |

## Targets

### web — cloudflare-pages

Two Pages projects, each tracking its own branch. Root directory `web`, build
`npm install && npm run build`, output `dist`. Deep-link reloads work via
`web/public/_redirects` (`/* /index.html 200`) rather than 404ing before React
Router sees them.

After any new production URL exists it must be added to **Supabase → Auth → URL
Configuration → Redirect URLs**, or magic links and Google OAuth reject the
redirect. That list also needs the localhost ports you actually dev on — if a
port isn't allow-listed, Supabase silently falls back to the Site URL, which is
how a magic link generated on localhost ends up pointing at production.

Runbook: [`docs/RELEASE_PROCESS.md`](./docs/RELEASE_PROCESS.md) · Pages setup detail is in [`CLAUDE.md`](./CLAUDE.md)

### migrations — supabase-migrations

`.github/workflows/migrations.yml` picks PROD-vs-TEST secrets by triggering
branch: `refs/heads/production` → PROD, anything else → TEST. **Fail-closed and
inert** — if the target's secrets aren't set it exits green having done nothing,
which means the frontend can deploy while the schema silently doesn't.
`migration-lint.yml` gates PRs on duplicate versions. An out-of-order timestamp
fails closed and wedges the pipeline.

Runbook: [`supabase/MIGRATIONS.md`](./supabase/MIGRATIONS.md)

### edge-functions — supabase-edge-functions

`.github/workflows/edge-functions.yml`, same branch→target routing and the same
fail-closed behaviour.

### organizer-custom-domains — cloudflare-pages

Tier 1 (shipped) is bespoke: one organizer domain at a time, wired by hand as a
**Pages custom domain** on the prod project, plus a `custom_domains` row mapping
the host to a tournament. On a mapped host, `/` renders that tournament's public
page; every other path works normally. Tier 2 (self-serve, via Cloudflare for
SaaS custom hostnames) is **not built**.

Runbook: [`docs/CUSTOM_DOMAINS.md`](./docs/CUSTOM_DOMAINS.md)

## Environments & variable scopes

| Environment | Comes from | Variable scope |
|---|---|---|
| **TEST** | the `main` build | the test Pages project's variables + `TEST_*` GitHub secrets |
| **PR preview** | every open PR | the **test** project's Preview scope — configured *separately* from that project's production (TEST) scope |
| **PROD** | the `production` build | the prod Pages project's variables + the unprefixed GitHub secrets |

**A PR preview is not TEST** — even though both come from the same Pages project
(`tournament-manager-test`). Cloudflare keeps *Production* and *Preview*
variables separate within one project, and `VITE_*` is baked into the bundle at
build time, so a preview compiles against the *Preview* scope's `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, and any feature secret. If those differ from TEST the
preview behaves differently for reasons unrelated to the code — suspect the env
vars before debugging. Add any new variable to the Preview scope **and** PROD,
not just TEST. Changing a Cloudflare variable takes effect only on the next
rebuild; a page refresh won't pick it up.

A preview is also **frontend-only against a live DB** — the migration it depends
on applies only on merge to `main`. That's why DB and UX ship as separate PRs.

**Promotion blast radius:** a `main`→`production` merge promotes *everything* on
`main` not yet on `production`, not just the feature you have in mind. Check the
delta before merging:

```bash
gh api repos/notronwest/tournament-manager/compare/production...main --jq '.ahead_by'
```

## Verify a deploy

```bash
gh run list --repo notronwest/tournament-manager --limit 5
```

Then load the environment's URL and confirm the app is talking to the intended
Supabase project. A green `migrations.yml` is the schema check — but remember
green can also mean *inert*, so confirm the target's secrets exist with
`gh secret list`.

## Roll back

- **web** — Cloudflare dashboard → the Pages project → **Deployments** → **⋯** →
  *Rollback to this deployment*.
- **migrations** — a new forward migration. Never edit or delete an applied one.
- **edge-functions** — revert the commit; the workflow redeploys the prior version.
- **organizer-custom-domains** — remove the Pages custom domain or delete the
  `custom_domains` row.

## Does NOT deploy from here

- **Supabase dashboard config** — Auth redirect URLs, the Google OAuth provider,
  and email templates are set by hand per Supabase project; the CLI doesn't
  manage them, so they never ride a deploy.
- **`regression.yml`** — Playwright E2E. It's a **gate**, not a deploy target.
- **Tier 2 self-serve custom domains** — designed but not built. Every organizer
  domain today is hand-wired.

## Deeper docs

- [`docs/RELEASE_PROCESS.md`](./docs/RELEASE_PROCESS.md) — the branch-routing
  model, promotion procedure, and the pre-flight checklist.
- [`supabase/MIGRATIONS.md`](./supabase/MIGRATIONS.md) — migration authoring rules.
- [`docs/CUSTOM_DOMAINS.md`](./docs/CUSTOM_DOMAINS.md) — organizer domain wiring.
- `../wmpc-meta/conventions/deployment-doc.md` — why this file exists and its shape.
