# pbcom-driver — unattended auto-push layer (PR notes)

Builds the UNATTENDED automation layer on top of the existing on-demand
`pbcom-driver` (D-0045 / tournament-manager#982). The on-demand supervised push
(`push <tournamentId> <divisionLabel|ALL>`) is unchanged; this adds the standing
`poll` loop, a durable DB ledger, session-lapse handling, the singleton host fact,
and the one-step installer.

## What changed

### Added
- **`supabase/migrations/20260930120000_pbcom_push_ledger.sql`** — the durable ledger
  + out-of-sync state (ships via branch routing, NOT with the driver code).
- **`pbcom-driver/src/alert.ts`** — Discord alerter (`DiscordAlerter`, `NoopAlerter`):
  best-effort, deduped ~6h, never throws; unset webhook → logged loudly + skipped.
- **`pbcom-driver/install.sh`** — the one per-mini bootstrap step.
- **`pbcom-driver/PBCOM-PUSH-HOST`** — the committed singleton fact (`wmpcMacMini1`,
  the same host as courtreserve-api's `EVENTS-DRAIN-HOST`/`BILLING-HOST`).
- **`pbcom-driver/tests/dbledger.test.ts`**, **`pbcom-driver/tests/auto.test.ts`**.
- **`pbcom-driver/AUTO-PUSH-PRNOTES.md`** (this file).

### Changed
- **`src/push/run.ts`** — the in-memory `PushLedger` seam is now joined by
  `DbPushLedger` (durable, DB-backed) + `PushStateSink`/`DbPushStateSink`, plus the
  new `runAutoPush` all-active orchestration, `isSessionLapse`, `hasWork`, and an
  `activeOnly` planning path. `MemoryLedger` stays for `--fixture`/tests. (The task
  pointed at `push/state.ts` for the in-memory seam, but the seam actually lives in
  `run.ts` — `state.ts` is the pure state machine and is left untouched.)
- **`src/cli.ts`** — new `poll` command (and `push --auto` alias) wired to
  `runAutoPush` with `DbPushLedger` + `DbPushStateSink` + `DiscordAlerter`; the shared
  per-division drive extracted to `driveDivisionOnSession` (used by both the on-demand
  and the auto session-reusing driver); the manual `push` path now uses `DbPushLedger`
  too (a supervised re-run reconciles against prior confirmed pushes).
- **`src/config.ts`** — adds `discordWebhook` (`PBCOM_DISCORD_WEBHOOK`); the real-run
  credential gate now requires `PBCOM_USERNAME` only, not a nonexistent
  `PBCOM_PASSWORD` (PB.com is email-OTP + persistent profile — Ron's decision #1).
- **`deploy/pbcom-push.sh`** → runs `poll`; **`deploy/com.wmpc.pbcom-push.plist`** →
  `StartInterval` 120→150s (RunAtLoad already false).
- **`.env.template`** → documents `PBCOM_DISCORD_WEBHOOK`.
- **`DEPLOYMENT.md`**, **`DESIGN.md`** (INFRA-INTAKE table flipped), **`README.md`**.

## Ledger table shape + idempotency key

`public.pbcom_push_ledger` — one row per CONFIRMED push (written only after the driver
reads the write back from PB.com):

| column | meaning |
| --- | --- |
| `id` | uuid pk |
| `tournament_id` | FK tournaments(id); scopes the ledger + prevents cross-tournament collisions |
| `division_key` | normalized division label (first segment of `entry_key`) |
| `kind` | `bracket` \| `score` |
| `entry_key` | the reconcile identity: division label (bracket) or match identity (score) |
| `score_digest` | the confirmed score (e.g. `11-6/w:a`); empty for a bracket row |
| `pushed_at`, `created_at` | timestamps |

**Idempotency key = unique `(tournament_id, kind, entry_key)`** with an UPSERT on that
constraint. `entry_key` mirrors `PushLedgerEntry` / `matchIdentity`: a score's identity
is `divisionKey | both teams' identity tokens | stage | bracket | round | position`,
where a team token is `source_team_id` → else the `source_attendee_header_id` set →
else the last-name set (NEVER `source_activity_id` — #987). The identity is TEAM-based
(PB.com source ids / last names), not keyed on PB.com round/position (B&E and PB.com
number rounds differently); the structural stage/bracket coords only disambiguate a
double-elim rematch of the same two teams. Result: a crashed/re-run push re-plans and
pushes only the delta, a corrected score UPSERTs the same row (new digest → re-push),
and the same push is never double-recorded.

`public.pbcom_push_state` — one row per `(tournament_id, division_key)` holding the
lifecycle state; the dashboard reads `where state = 'needs_attention'` for the D-0045
"PB.com out of sync" surface. Both tables: RLS on, org-admin SELECT policy, writes are
service-role only.

## Auto-mode behavior (`poll`)

Each ~150s tick, gated on `PBCOM-PUSH-HOST` + the same-machine lock:
1. Discover every tournament in the binding config; for each, read its ACTIVE
   (status active/medal_round/complete) pbcom divisions and plan the delta (no browser).
2. If nothing has a delta → **no browser is opened** (cheap no-op tick).
3. Otherwise open ONE persistent-profile session for the tick and, per division with a
   delta: create the bracket if the ledger doesn't have it, then push each changed/new
   score, **verify-before-ledger**, recording only confirmed pushes. Corrected scores
   re-push (their digest changed). The driver NEVER deletes on PB.com.

## Session-lapse / Discord flow

- If opening the session (or a mid-tick call) throws `PbcomLoginError` (PB.com would
  need the email OTP again), the loop records `needs_attention`
  ("PB.com session expired — re-auth needed") for the pending divisions, posts ONE
  Discord alert (deduped ~6h), and **exits 0** — launchd does not crash-loop.
- A write that will not verify is surfaced as `needs_attention` + an out-of-sync alert,
  never a silent success; it is not recorded, so it re-pushes next tick.
- `PBCOM_DISCORD_WEBHOOK` unset → the alert is logged loudly and skipped (still records
  `needs_attention`, still exits cleanly).

## One-time mini bootstrap (owner)

1. Ship the migration: merge to `main` (→TEST), verify, then `main`→`production` PR
   (→PROD) so `pbcom_push_ledger` + `pbcom_push_state` exist in the DB the mini writes.
2. On the club mini, from `tournament-manager/pbcom-driver`: `./install.sh`.
3. Confirm `PBCOM-PUSH-HOST` names this mini (it is committed as `wmpcMacMini1`).
4. Fill `.env`: `PBCOM_USERNAME`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `PBCOM_PROFILE_DIR`, and `PBCOM_DISCORD_WEBHOOK`. Ensure the binding config
   (`PBCOM_BINDING_PATH`) maps each tournament to its PB.com `eid`.
5. One-time PB.com login (email code) into the persistent profile — see below.

## Supervised first run (D-0039)

1. Dry-run (no browser, no creds beyond the DB): confirm the plan looks right —
   `npx tsx src/cli.ts poll --dry-run --fixture tests/fixtures/draws.synthetic.json`,
   then against the real DB: `npx tsx src/cli.ts poll --dry-run --force-host`.
2. Watched real run: `npx tsx src/cli.ts poll --force-host` — a headed Chrome opens;
   complete the PB.com email-code login once (it persists in `PBCOM_PROFILE_DIR`), then
   watch it create the bracket + push scores and verify each write. Confirm rows land in
   `pbcom_push_ledger` and PB.com shows the scores.
3. Only then rely on the launchd job (already loaded by `install.sh`, RunAtLoad=false).

## Left for the owner

- Run the migration to TEST then PROD (branch routing) before the mini writes to PROD.
- `install.sh` on the mini + fill `.env` + the one-time headed PB.com login.
- Provide/point `PBCOM_DISCORD_WEBHOOK` at the intended channel.
- Optional: teach `reconcile.sh` to invoke `install.sh` (it is idempotent) so the plist
  refreshes on sync, mirroring courtreserve-api.
- **Empirical:** measure how long the PB.com director session survives unattended; the
  re-auth ping is the safety net regardless.
- The PB.com DOM flows (`createBracketOnPbcom`/`submitScoreCard`) are verify-after-write
  from the training capture; the supervised first run is where they meet live PROD PB.com.
