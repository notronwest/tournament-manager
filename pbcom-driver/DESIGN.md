# pbcom-driver — design

Governed by **D-0045** (Bert & Erne ⇄ PickleballBrackets.com two-way bridge) and
tracked by **tournament-manager#982**. This document records the placement decision
and answers the daemon **INFRA-INTAKE** checklist. Several answers are marked
**OPEN — needs Ron** because designating an unattended fleet singleton is an
INFRA-INTAKE decision, not one this scaffolding session makes unilaterally.

> **Update — unattended auto-push layer (D-0045 productionization).** The OPEN
> items below have since been resolved per Ron's decisions and built on top of the
> on-demand driver: a durable DB ledger (`pbcom_push_ledger` + `pbcom_push_state`),
> an all-active `poll` mode driven by launchd on the mini every ~150s, session-lapse
> handling (records `needs_attention`, posts a Discord alert, exits cleanly — no
> crash-loop), the committed `PBCOM-PUSH-HOST` singleton fact (`wmpcMacMini1`), and
> the one-step `install.sh`. Auth stays **persistent-profile + re-auth ping** (no
> hands-off login — PB.com is email-OTP). The INFRA-INTAKE table records the resolved
> answers; the section below is kept as the original scaffold-scope record.

## Scope of the original PR — on-demand, supervised-run ONLY

This PR ships the driver as an **on-demand tool a human runs and watches**, not a
standing service. Concretely:

- The **PB.com form flows are real** now (verify wizard + Start Matches; score-card
  modal; last-name match mapping) — filled from the live director-session capture on
  `train.pickleballbrackets.dev` (D-0045 "trace first").
- **Login is supervised.** PB.com authenticates by email → one-time **code** (no
  password to fill from a secret). `login()` therefore either reuses a persistent
  Chrome profile (operator logged in once) or, headed, waits for the operator to enter
  the emailed code. **Headless/unattended login throws by design.**
- **Nothing is deployed.** No launchd job is installed, no reconcile wiring, no HOST
  fact is committed, no ledger migration is added. The `deploy/` plist + script are
  design artifacts, not installed by this PR.

**Standing/unattended running is a SEPARATE INFRA-INTAKE decision with Ron**, and it
turns on exactly the questions this module cannot answer alone: **headless login vs.
the email-code step**, **WebForms bot-management on a mini/residential IP**, **PB.com
session lifetime** (how long a director cookie lasts unattended), the **singleton
HOST fact + reconcile/launchd wiring**, and the **DB-backed ledger** for cross-run
idempotency. Until that pass, run it by hand and watch it.

## Identity correction (#987) — why matching is by last names, not activity ids

The original scaffold keyed match/team identity on `source_activity_id`, believing it
was a per-entry id. **#987 (now on `main`) established that PB.com's ActivityID is the
DIVISION id — shared by every registrant in a division** — so it cannot identify a
team or a match. This PR corrects that:

- **Team identity** = `source_team_id` (doubles group) → else the `source_attendee_header_id`
  set (genuinely per-attendee) → else the normalized last-name set. Never `source_activity_id`.
- **PB.com row matching** (the crux, flow C) is by the **normalized, unordered set of
  player last names per team**, because a PB.com round-robin row shows last names and
  no per-entry id. Matching is by TEAMS, never by round/position (B&E and PB.com number
  rounds differently). This is the pure, unit-tested `src/pbcom/matchMap.ts`.

## Placement decision — why `tournament-manager/pbcom-driver/`

**Decision:** the driver lives as a self-contained module directory inside the
**tournament-manager** repo (`pbcom-driver/`), with its own `package.json`,
lifecycle, and mac-mini-launchd deploy shape — **not** as a Supabase edge function,
and **not** (yet) as a brand-new sibling repo.

**Why here and not an edge function.** Playwright drives a real browser; it cannot
run inside a Supabase edge function (Deno, no browser, short-lived). Like
`courtreserve-api`, the browser-driving job runs on the club **Mac mini** on the
club's residential IP (headless / datacenter IPs trip WebForms bot-management).
So the driver is a mini-hosted process, sitting *beside* the edge functions, not
inside them.

**Why in tournament-manager and not a new sibling repo.** The truest mirror of
`courtreserve-api` would be a dedicated `pbcom-driver` repo. Two reasons it stays in
tournament-manager for now:
1. **It IS a B&E product feature.** D-0045 scopes this to tournament-manager; the
   driver reads B&E's data model and must track its schema. The import side (#981)
   already lives here (`web/src/lib/pbImport.ts`, `pbReconcile.ts`, the
   `import-pb-registrations` edge fn, the `pbcom_import_source_tracking` migration).
   Colocation keeps the push's **input types honest against the schema** and lets it
   reuse the same division-label / normalization conventions as the import.
2. **A new repo is a fleet-infra act, and daemon says ask first.** Spinning a
   standing, unattended, singleton service into its own repo pulls in a HOST fact,
   `reconcile.sh` wiring, a launchd install, and a decision-register update — exactly
   the INFRA-INTAKE conversation daemon's CLAUDE.md requires up front. This PR is
   **scaffold-only and deploys nothing**, so it should not create that surface
   unilaterally.

**Recommended production home (OPEN — needs Ron):** promote `pbcom-driver/` to a
dedicated repo (mirroring `courtreserve-api`'s archetype) at the INFRA-INTAKE pass,
OR keep it as a tournament-manager module run on the mini. Either is viable; the code
is written to move cleanly (no imports from the Vite app or the edge functions).

**Deploy note:** tournament-manager is branch-routed (`main`→TEST, `production`→PROD),
but **this module deploys via mac-mini-launchd, not via a branch.** A merge to `main`
ships the web app / edge functions to TEST and deploys **nothing** for `pbcom-driver`
— it ships only when a human runs the installer on the mini. This is documented in
`DEPLOYMENT.md` so the branch-routing is not mistaken for the driver's trigger.

## INFRA-INTAKE answers

| # | Question | Answer |
|---|----------|--------|
| 1 | **Unattended?** | **RESOLVED — yes, via a launchd `poll` loop every ~150s on the mini** (Ron's decision #2). Each tick discovers every ACTIVE, PB.com-bound division and pushes its delta (create-if-needed + scores since the last confirmed push). Auth is NOT hands-off: it reuses the persistent director profile; when the session has lapsed it records `needs_attention` + posts a Discord alert + exits cleanly (Ron's decision #1), so a human re-auths once and it resumes. Bot-management is handled the same way as courtreserve-api (real Chrome, residential IP, mini only). Session lifetime stays **empirical** (see row 9). |
| 2 | **How many machines?** | The repo is on several Macs; **exactly one** (the club mini) may drive. |
| 3 | **Singleton?** | **RESOLVED.** **Gate 1:** committed `PBCOM-PUSH-HOST` fact (now set to `wmpcMacMini1`); `runPush`/`runAutoPush` self-gate fail-closed (unset = nobody drives) — the `BUILDER-HOST`/`EVENTS-DRAIN-HOST` pattern. **Gate 2:** a same-machine exclusive lockfile (`state/pbcom-push.lock`, O_EXCL). **Gate 3:** the DB ledger (`pbcom_push_ledger`) is the durable backstop — a push is recorded only after PB.com verify, on a `(tournament, kind, entry_key)` uniqueness constraint (UPSERT), so even a defeated gate 1+2 re-plans the delta and cannot double-submit. |
| 4 | **Propagation.** | Via the same `git pull` + `reconcile.sh` path as the rest of the fleet. `install.sh` is idempotent and safe for reconcile to invoke (`npm ci` + refresh the launchd plist), mirroring courtreserve-api. The ledger schema propagates separately, via branch routing (main→TEST, production→PROD). |
| 5 | **Bootstrap — one manual touch.** | **RESOLVED:** `install.sh` is the one per-machine step (mini only) — installs deps, seeds `.env` from the template (never overwrites), loads the plist, and prints the remaining human steps (set `PBCOM-PUSH-HOST`, one-time headed PB.com login, add `PBCOM_DISCORD_WEBHOOK`). See `AUTO-PUSH-PRNOTES.md`. |
| 6 | **Self-heal.** | Idempotent by construction: reconcile keyed on PB.com source ids + match identity means a crashed/re-run push only pushes the delta; a stale lock is reclaimed next tick; the host gate fails closed on a deleted fact. |
| 7 | **Source of truth.** | The repo: `PBCOM-PUSH-HOST` (who drives) and the declarative binding config (tournament↔eid, which also IS the set of tournaments the `poll` loop discovers). The B&E DB holds the draw + the durable push ledger. **RESOLVED:** the ledger is now `public.pbcom_push_ledger` (+ `pbcom_push_state`), added by `supabase/migrations/20260930120000_pbcom_push_ledger.sql` (§data). |
| 8 | **Failure mode.** | **Fail-closed** everywhere: unset host → nobody drives; missing creds → clean exit 2; a seam that can't verify a write → does NOT record the ledger and escalates to `needs_attention` (the D-0045 "PB.com out of sync" signal); the driver **never deletes** on PB.com (orphans are reported, not removed). |
| 9 | **Secrets / auth.** | PB.com login is **email + one-time code** (supervised), aided by `PBCOM_USERNAME` + a persistent `PBCOM_PROFILE_DIR` in the mini's gitignored `.env`. The draw is read read-only from Supabase via `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (service-role, never committed). Same custody model as courtreserve-api's creds; rotation = edit `.env`. **RESOLVED (as far as it can be):** there is no hands-off login — the unattended loop reuses the persistent director profile and, when it lapses, records `needs_attention` + Discord-alerts for a human re-auth (Ron's decision #1). **EMPIRICAL / still unknowable:** how long a PB.com director cookie survives unattended — measured in practice, not designed; the re-auth ping is the safety net for whatever it turns out to be. |
| 10 | **Observability.** | **RESOLVED.** Structured one-JSON-per-line logs to `~/.local/state/wmpc-pbcom/push.{out,err}.log`, PLUS: (a) a **Discord alert** (`PBCOM_DISCORD_WEBHOOK`) on a lapsed session / an unverifiable write — deduped ~6h, best-effort, never crashes; unset → logged loudly + skipped; and (b) the **`pbcom_push_state`** table, one row per division, which the dashboard reads `where state = 'needs_attention'` to render the D-0045 "PB.com out of sync" surface. |
| 11 | **Can the Chief of Staff use it?** | **OPEN:** expose a documented mini entry point (`npx tsx src/cli.ts push` under the host guard) and, for club-data reach, a read-only plan/status via `wmpc-mcp`. Not built in this PR. |

## Data model the push reads (tournament-manager, origin/main)

- `events` — a division. Push-relevant: `source_system`, `source_division_label`
  (PB.com division identity), `bracket_type`, `format`, `gender`.
  (`supabase/migrations/20260928120000_pbcom_import_source_tracking.sql`,
  `20260503000001_init_schema.sql`)
- `event_registrations` — one row per player; a doubles team = two rows linked by
  `partner_registration_id`. Push-relevant: `source_activity_id` (per-entry
  idempotency key), `source_team_id` (partner group), `source_attendee_header_id`,
  `seed`.
- `matches` — the generated draw **and** the scores:
  `team_a_reg_id`/`team_b_reg_id`, `team_a_score`/`team_b_score`, `winner_reg_id`,
  `status`, `bracket` (winners/consolation/final), `stage`, `round`, `position`,
  `slot_key`. (`20260504030000_matches.sql`, `20260914210000_double_elim.sql`)

### Known dependencies / gaps (see the PR body)

- **Push ledger persistence.** RESOLVED. `public.pbcom_push_ledger` (+
  `pbcom_push_state`) now backs reconcile durably —
  `supabase/migrations/20260930120000_pbcom_push_ledger.sql`. `DbPushLedger`
  (`src/push/run.ts`) reads/writes it via the service-role key, scoped per
  tournament, UPSERTing on `(tournament_id, kind, entry_key)` so a re-run pushes
  only the delta and a corrected score re-pushes into the same row. `MemoryLedger`
  stays for `--fixture` / dry-runs / tests. The row shape mirrors `PushLedgerEntry`.
  NOTE: the migration ships via branch routing (main→TEST, production→PROD); the
  driver code does not.
- **DrawSource DB read.** `src/cli.ts`'s `DbDrawSource` is **implemented** — it reads
  the three tables above (plus `players` for last names) from the tournament-manager
  Supabase project via the service-role key (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`,
  read-only). A `--fixture` source remains for dry-runs / demos without a DB.
- **DUPR→seed automation.** D-0045 says the draw is "seeded by DUPR," but today
  `event_registrations.seed` is set manually and no code derives it from
  `players.dupr_rating_*`. The push consumes `seed` + `matches` as given; producing
  the seed order is an upstream B&E concern (the #970 umbrella), not this driver's.
- **PB.com tournament `eid`.** No column stores PB.com's event-level id; the binding
  config supplies it (by design — it is deployment data, not import data).
