# pbcom-driver — design

Governed by **D-0045** (Bert & Erne ⇄ PickleballBrackets.com two-way bridge) and
tracked by **tournament-manager#982**. This document records the placement decision
and answers the daemon **INFRA-INTAKE** checklist. Several answers are marked
**OPEN — needs Ron** because designating an unattended fleet singleton is an
INFRA-INTAKE decision, not one this scaffolding session makes unilaterally.

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
| 1 | **Unattended?** | Yes by design — launchd every ~2 min during play, drives PB.com with no human. **Blocked** until the trace fills the form seams; until then a real run fails loudly and pushes nothing. |
| 2 | **How many machines?** | The repo is on several Macs; **exactly one** (the club mini) may drive. |
| 3 | **Singleton?** | **Gate 1:** committed `PBCOM-PUSH-HOST` fact; the executor self-gates fail-closed (unset = nobody drives) — the `BUILDER-HOST`/`EVENTS-DRAIN-HOST` pattern. **Gate 2:** a same-machine exclusive lockfile (`state/pbcom-push.lock`, O_EXCL). **Gate 3 (OPEN):** the DB-backed ledger should claim atomically once wired, so even a defeated gate 1+2 can't double-submit. Today the ledger is the reconcile backstop: a push is recorded only after PB.com verify, so a re-run re-plans the delta rather than duplicating. |
| 4 | **Propagation.** | Via the same `git pull` + `reconcile.sh` path as the rest of the fleet — **OPEN:** reconcile must learn to `npm install` + refresh this module's launchd plist (like it does for courtreserve-api). Not wired in this PR. |
| 5 | **Bootstrap — one manual touch.** | **OPEN:** the one per-machine step (on the mini only): install deps + load `com.wmpc.pbcom-push.plist`, fill `.env`, set `PBCOM-PUSH-HOST`. To be scripted as `setup.sh`/`install.sh` at productionization. |
| 6 | **Self-heal.** | Idempotent by construction: reconcile keyed on PB.com source ids + match identity means a crashed/re-run push only pushes the delta; a stale lock is reclaimed next tick; the host gate fails closed on a deleted fact. |
| 7 | **Source of truth.** | The repo: `PBCOM-PUSH-HOST` (who drives), the declarative binding config (tournament↔eid), and the B&E DB (the draw + the push ledger). The **binding** and **ledger** should become committed/DB state respectively — **OPEN:** ledger table migration (see §data). |
| 8 | **Failure mode.** | **Fail-closed** everywhere: unset host → nobody drives; missing creds → clean exit 2; a seam that can't verify a write → does NOT record the ledger and escalates to `needs_attention` (the D-0045 "PB.com out of sync" signal); the driver **never deletes** on PB.com (orphans are reported, not removed). |
| 9 | **Secrets / auth.** | The org's own PB.com login in the mini's gitignored `.env` (`PBCOM_USERNAME`/`PBCOM_PASSWORD`), plus `PBCOM_DB_URL`. Same custody model as courtreserve-api's CR creds. Rotation: edit `.env` on the mini. |
| 10 | **Observability.** | Structured one-JSON-per-line logs to `~/.local/state/wmpc-pbcom/push.{out,err}.log`. **OPEN:** a Discord heartbeat / dashboard "PB.com out of sync" surface for the `needs_attention` state (D-0045 requires a human-visible out-of-sync signal). |
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

- **Push ledger persistence.** Reconcile needs a durable record of confirmed pushes.
  The scaffold uses an in-memory ledger + a `PushLedger` seam; production needs a
  `pbcom_push_ledger` table (a migration — intentionally NOT added here, so this PR
  deploys nothing to TEST). Suggested shape mirrors the ledger entry type in
  `src/types.ts`.
- **DrawSource DB read.** `src/cli.ts`'s `DbDrawSource` is a documented stub; wire it
  to read the three tables above on the mini.
- **DUPR→seed automation.** D-0045 says the draw is "seeded by DUPR," but today
  `event_registrations.seed` is set manually and no code derives it from
  `players.dupr_rating_*`. The push consumes `seed` + `matches` as given; producing
  the seed order is an upstream B&E concern (the #970 umbrella), not this driver's.
- **PB.com tournament `eid`.** No column stores PB.com's event-level id; the binding
  config supplies it (by design — it is deployment data, not import data).
