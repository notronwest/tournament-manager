# Running Bert & Erne fully offline (one laptop, no Internet)

For running a tournament at a venue with no Internet (see epic
[#732](https://github.com/notronwest/tournament-manager/issues/732)). This
doc covers the **runtime** piece — bringing the app + database up locally
([#733](https://github.com/notronwest/tournament-manager/issues/733)). Local
director auth, the asset/network audit + verification harness, import/export,
and print were separate cards (#734–#737) — see "Verifying it's actually
network-clean" below for #735's tools.

**Running an actual event?** This doc is the technical reference — for the
step-by-step checklist to follow before and during a tournament, see
[`docs/runbooks/TOURNAMENT-PREP.md`](./runbooks/TOURNAMENT-PREP.md) and
[`docs/runbooks/TOURNAMENT-DAY.md`](./runbooks/TOURNAMENT-DAY.md).

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
3. From the repo root, run `supabase start` once. This pulls and caches the
   local stack's Docker images — the only network-dependent step in this
   whole workflow. After it succeeds, `supabase stop` (no flags) to shut it
   back down until the event; the images stay cached.
4. Do a dry run: pull Wi-Fi/Ethernet, run `./scripts/offline.sh`, confirm the
   app loads at `http://localhost:5173` (or whatever port Vite prints) and
   shows an **OFFLINE** banner. This is the Friday dry-run the epic calls for.

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
the desk, not an outage anyone notices until it's too late. Two checks:

1. **Bundle grep** — `./scripts/offline-bundle-grep.sh` builds the app in
   offline mode and greps every JS/CSS file for `http://`/`https://`
   literals, failing if it finds anything not on its hand-reviewed allowlist
   (doc-link strings, XML namespace URIs, localhost — never anything the app
   actually fetches). Run this any time you touch a dependency or an asset
   before an event.
2. **Network-down harness** — `web/e2e/offline/network-audit.spec.ts` drives
   a full mock event (create a tournament + event, seed 4 teams, run the
   round robin, run the playoff, see medals awarded) while intercepting
   every request the browser makes and failing if any of them target a host
   other than `localhost`/`127.0.0.1` — the deterministic equivalent of
   physically switching Wi-Fi off. Run it against the real offline runtime:
   ```
   ./scripts/offline.sh                                   # start it (needs
                                                            # Docker running)
   cd web && OFFLINE_BASE_URL=http://localhost:5173 \
     npm run test:e2e:offline                              # (separate
                                                            # terminal)
   ```
   Adjust `OFFLINE_BASE_URL` if `offline.sh` printed a different port.

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
