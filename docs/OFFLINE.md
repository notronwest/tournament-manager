# Running Bert & Erne fully offline (one laptop, no Internet)

For running a tournament at a venue with no Internet (see epic
[#732](https://github.com/notronwest/tournament-manager/issues/732)). This
doc covers the **runtime** piece — bringing the app + database up locally
([#733](https://github.com/notronwest/tournament-manager/issues/733)). Local
director auth, the asset/network audit + verification harness, import/export,
and print were separate cards (#734–#737) — see "Verifying it's actually
network-clean" below for #735's tools.

## What this is

The app is Supabase-native — hosted Postgres, Auth, and API. Offline mode
does **not** re-implement any of that: it runs the exact same
schema/RLS/migrations against a **local** Postgres via the Supabase CLI's
local dev stack (Postgres + Auth + the same REST API `@supabase/supabase-js`
already talks to), and points the app at `http://127.0.0.1:54321` instead of
the hosted project. Nothing about the hosted TEST/PROD apps changes — this
is opt-in tooling, gated behind a separate Vite mode (`--mode offline`) that
the normal `npm run dev` / CI builds never touch.

## One-time setup (do this BEFORE you lose Internet — today, not at the venue)

1. Install the Supabase CLI if you don't have it: `brew install supabase/tap/supabase`
2. Install Docker Desktop and make sure it's running.
3. From the repo root, run **`bash scripts/offline.sh` once while you still
   have Internet.** This is the whole one-time setup — it does every
   network-dependent step and caches the results:
   - installs `web/node_modules` from the lockfile (`npm ci`) — so a checkout
     that predates a dependency change still has every package (this is what
     bit us live on 2026-09-11: a fresh laptop was missing the self-hosted
     `@fontsource/*` fonts and Vite died at import time);
   - runs `supabase start`, which pulls and caches the local stack's Docker
     images.
   Once it prints the OFFLINE banner and serves the app, you're set. `Ctrl-C`
   the app; the images and `node_modules` stay cached. (`supabase stop` — no
   flags — shuts the DB down too until the event, if you want it stopped.)
4. If you'll run the verification harness (recommended — see below), also
   install its browser once online: `npx --prefix web playwright install chromium`.
5. Do a dry run: pull Wi-Fi/Ethernet, run `./scripts/offline.sh`, confirm the
   app loads at `http://localhost:5173` (or whatever port Vite prints) and
   shows an **OFFLINE** banner. This is the Friday dry-run the epic calls for.

Two blockers that used to require manual fixes at the venue are now handled in
committed config/tooling — a fresh `bash scripts/offline.sh` comes up clean with
no hand edits:

- **Web deps** are installed automatically by `scripts/offline.sh` (see above).
- **Inbucket (the dev email inbox) is disabled** in `supabase/config.toml`.
  The pinned Supabase CLI (v2.105.0) can't publish inbucket's port and aborts
  the whole `supabase start`; this app never uses the local inbox, so it's off
  for good. Don't commit it back on. (Details in the `[inbucket]` comment.)

## Running the event

```
./scripts/offline.sh
```

This one command:
- Starts the local Supabase stack (`supabase start` — no-ops if already up).
- Reads the local API URL + anon key from `supabase status` and writes them
  to `web/.env.offline.local` (gitignored, regenerated every run — never
  hardcoded, never committed).
- Starts the web app via `npm run dev:offline` (Vite `--mode offline`),
  wrapped in `caffeinate` on macOS so display/system/idle sleep don't kick in
  mid-event if the lid closes briefly.

Leave the terminal window open for the event. Stopping the app
(<kbd>Ctrl-C</kbd>) does **not** stop the database — the local Postgres
stack keeps running so you can rerun `./scripts/offline.sh` at any point
without losing anything.

## Durability

- The local Postgres data lives in a Docker volume that **persists across
  restarts on its own** — killing the app, restarting the laptop, or
  re-running `./scripts/offline.sh` does not lose data.
- **Never run `supabase stop --no-backup`** — that flag explicitly deletes
  the data volume. Plain `supabase stop` (or just closing the laptop) is
  safe.
- As a portable backstop, run `./scripts/offline-backup.sh` periodically
  (e.g. between rounds) — it writes a timestamped `.sql` snapshot to
  `backups/` (gitignored) that you can copy straight to a USB stick.

## Verifying it's actually network-clean (issue #735)

Running offline isn't enough on its own — a stray CDN font, analytics
beacon, or SDK that still tries to phone home is a hang or a broken page at
the desk, not an outage anyone notices until it's too late.

**One command runs the whole check:**

```
bash scripts/offline-verify.sh          # deps + supabase start + first-paint
bash scripts/offline-verify.sh --full   # ALSO the full mock-event audit
```

`offline-verify.sh` is the automated equivalent of a clean-laptop dry run: it
runs the bundle grep, reinstalls `web/node_modules` from the lockfile (`npm
ci` — catches the missing-deps blocker), starts the real offline runtime
(`scripts/offline.sh`, which runs `supabase start` — catches the inbucket
blocker), and confirms the app reaches **first paint with the network
simulated down**. The default run writes **nothing** to the local DB, so it's
safe against a venue laptop already holding real data. `--full` additionally
runs the full mock-event audit below, which **does** write mock tournaments/teams
to the local DB — don't use `--full` against a stack running a real event.

It composes the two lower-level checks, which you can also run on their own:

1. **Bundle grep** — `./scripts/offline-bundle-grep.sh` builds the app in
   offline mode and greps every JS/CSS file for `http://`/`https://`
   literals, failing if it finds anything not on its hand-reviewed allowlist
   (doc-link strings, XML namespace URIs, localhost — never anything the app
   actually fetches). Run this any time you touch a dependency or an asset
   before an event.
2. **Network-down harness** — two Playwright specs under `web/e2e/offline/`,
   both of which intercept every request the browser makes and fail if any
   targets a host other than `localhost`/`127.0.0.1` — the deterministic
   equivalent of physically switching Wi-Fi off:
   - `first-paint.spec.ts` — just loads the app and confirms it reaches first
     paint (fonts/JS/CSS/local Supabase all local). Fast, and writes nothing
     to the DB.
   - `network-audit.spec.ts` — drives a full mock event (create a tournament +
     event, seed 4 teams, run the round robin, run the playoff, see medals
     awarded). This one **writes** to the local DB.

   `offline-verify.sh` runs these for you (first-paint by default, both under
   `--full`). To run them by hand against an already-running offline runtime:
   ```
   ./scripts/offline.sh                                   # start it (needs
                                                            # Docker running)
   cd web && OFFLINE_BASE_URL=http://localhost:5173 \
     npm run test:e2e:offline                              # both specs
                                                            # (separate terminal)
   ```
   Adjust `OFFLINE_BASE_URL` if `offline.sh` printed a different port. (Needs
   Playwright's chromium — `npx playwright install chromium`, one-time online.)

Known non-fatal caveats found by the audit, fixed by this card:
- Google Fonts self-hosted via `@fontsource/*` (was `fonts.googleapis.com`/
  `fonts.gstatic.com` `<link>`s in `index.html`).
- `@stripe/stripe-js` switched to its `/pure` entry point so the
  fraud-detection script only loads if `loadStripe()` is actually called —
  it never is offline (no `VITE_STRIPE_PUBLISHABLE_KEY` set).
- GA4/PostHog loaders also explicitly check `isOfflineMode()` now, on top of
  the existing consent + env-var gating.

Still open, not fixed here (flagged for awareness, not blocking the event):
- `xlsx`'s package source is a `cdn.sheetjs.com` URL in `package.json` — that
  resolves at `npm install` time only, never at runtime, so it doesn't touch
  the network-down bar. Not worth destabilizing a working dependency pin the
  night before an event.
- This app has no map/tile library (leaflet/mapbox) anywhere in the
  codebase — nothing to audit there.
- The issue's acceptance criteria mentions "consolation/backdraw" rounds;
  this app's actual bracket model is round-robin pools → a top-N playoff
  (1 or 2 rounds), with no separate consolation bracket. The harness exercises
  that real model (round robin, then the playoff round) rather than a feature
  that doesn't exist.

## Known judgment calls (unverified — flagged for the Friday dry run)

- "Survive lid-close" is addressed via `caffeinate`, which keeps the Mac
  awake while the app is running. A MacBook running on battery with the lid
  **fully closed** (true clamshell mode) generally needs external power +
  display/keyboard regardless of any app-level setting — if the plan is to
  run with the lid open on a table between matches, `caffeinate` is enough;
  if it's genuinely clamshell, that's a macOS power setting, not something
  this script can control. Confirm which scenario applies at the dry run.
- The Supabase CLI's local stack requires Docker Desktop. "No Docker image
  pull at start" is satisfied by caching images during the one-time setup
  above — Docker itself is still a dependency of this approach. If Docker
  Desktop itself turns out to be unreliable on the event laptop, that's
  outside this card's scope.
