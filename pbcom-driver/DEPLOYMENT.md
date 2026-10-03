# Deployment — pbcom-driver (module)

This module ships in **two independent shapes** — do not confuse them:

1. **The driver (code) → mac-mini-launchd.** Playwright drives a real Chrome on the
   club's residential IP, so it cannot run in an edge function or on a datacenter IP
   (headless trips PB.com's WebForms bot-management). It runs as a launchd job on the
   club Mac mini, installed by `install.sh`. **Branch routing deploys NONE of this** —
   pushing to `main` ships the web app / edge functions to TEST and deploys *nothing*
   for `pbcom-driver`.
2. **The ledger schema (`supabase/migrations/…_pbcom_push_ledger.sql`) → branch routing.**
   The `pbcom_push_ledger` + `pbcom_push_state` tables are a normal repo migration and
   ride the repo's routing like any other: `main`→TEST, `production`→PROD. So a merge to
   `main` DOES create these tables on TEST; promote to PROD with the usual
   `main`→`production` PR before the mini's driver writes to a PROD DB.

> **Status: unattended auto/poll layer built; owner verifies + ships + runs the
> supervised first run.** The form flows, the durable DB ledger, the all-active auto
> loop, session-lapse handling (Discord alert + clean exit, no crash-loop), the
> singleton host fact, and the installer are all in. What remains is the owner's:
> run the migration to PROD, run `install.sh` on the mini, fill `.env`, and do the
> one-time headed PB.com login + the supervised first run. See `AUTO-PUSH-PRNOTES.md`.

```yaml
# wmpc-deployment: v1
repo: tournament-manager
module: pbcom-driver
archetype: mac-mini-launchd
branches:
  main: ledger MIGRATION only → TEST (Supabase). The DRIVER itself deploys nothing on main.
  production: ledger MIGRATION only → PROD (Supabase), via a main→production PR. The driver deploys nothing on production.
targets:
  - name: pbcom-push-poll
    kind: mac-mini-launchd
    trigger: launchd com.wmpc.pbcom-push, StartInterval 150s, RunAtLoad=false; installed by pbcom-driver/install.sh on the mini
    source: pbcom-driver/deploy/pbcom-push.sh -> npx tsx src/cli.ts poll
    env: PROD (drives the org's live PB.com account; reads the tournament-manager DB; writes the push ledger/state tables)
    url: n/a — drives pickleballbrackets.com; no inbound endpoint
    host: the club Mac mini ONLY; gated on the committed PBCOM-PUSH-HOST fact (wmpcMacMini1), not on where installed
    config_scope: pbcom-driver/.env on the mini (gitignored) — PBCOM_USERNAME, PBCOM_PROFILE_DIR, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PBCOM_DISCORD_WEBHOOK, PBCOM_BINDING_PATH; plus the committed PBCOM-PUSH-HOST fact and the binding config (tournament↔eid). Missing creds → exit 2 (no-credential skip), never crashes
    verify: "npx tsx src/cli.ts poll --dry-run --fixture tests/fixtures/draws.synthetic.json prints the plan and drives nothing; a real supervised run logs to ~/.local/state/wmpc-pbcom/push.{out,err}.log"
    rollback: launchctl unload the plist — nothing queued is lost; the DB ledger reconciles the delta on the next run. The driver NEVER deletes on PB.com; the worst unattended outcome is an un-pushed score, surfaced as needs_attention (+ a Discord alert)
  - name: pbcom-push-ledger-migration
    kind: supabase-branch-routing
    trigger: merge to main (→TEST) then a main→production PR (→PROD) — the repo's standard migration routing
    source: supabase/migrations/20260930120000_pbcom_push_ledger.sql
    env: TEST on main, PROD on production
    url: n/a
    host: n/a (Supabase)
    config_scope: n/a
    verify: "the pbcom_push_ledger + pbcom_push_state tables exist; the dashboard can read pbcom_push_state where state='needs_attention'"
    rollback: drop the two tables (they only hold push-reconcile state; the driver re-plans the full delta on the next run)
  - name: form-flows
    kind: unknown
    trigger: implemented from the PB.com director-session capture (D-0045 "trace first"); driven by the poll loop or a supervised operator
    source: pbcom-driver/src/pbcom/driver.ts (createBracketOnPbcom, submitScoreCard), pbcom-driver/src/pbcom/matchMap.ts (last-name mapping), pbcom-driver/src/pbcom/session.ts (persistent-profile / supervised email-code login)
    env: n/a
    url: n/a
    host: n/a
    config_scope: n/a
    verify: unit tests cover the pure parts (mapping, seed moves, reconcile, DB ledger, auto planning, session-lapse) + everything around the flows; the DOM flows are verify-after-write against live PB.com and were exercised on train.pickleballbrackets.dev
    rollback: the driver NEVER deletes on PB.com; an unverified write is not recorded and surfaces as needs_attention
  - name: record-pbcom-score (REVERSE write — edge function)
    kind: supabase-branch-routing
    trigger: merge to main (→TEST) then a main→production PR (→PROD) — edge-functions.yml deploys ALL functions in supabase/functions/
    source: supabase/functions/record-pbcom-score/index.ts
    env: TEST on main, PROD on production
    url: "{SUPABASE_URL}/functions/v1/record-pbcom-score — service-to-service; the Bearer must carry the service_role role claim (gateway verifies the signature, the fn checks the claim)"
    host: n/a (Supabase edge function)
    config_scope: auto-injected SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY; default verify_jwt (no config.toml entry needed)
    verify: "POST {} with a service-role Bearer → 400 missing-field (proves deployed + authorized); a real write returns {ok,updated,status}"
    rollback: redeploy the prior version; writes are idempotent (score+winner+status) and standings/medals recompute on read, so no data to unwind
  - name: pbcom-score-pull (REVERSE poller)
    kind: mac-mini-launchd
    trigger: launchd every ~5 min on the mini (`poll-scores`); shares the PBCOM-PUSH-HOST singleton + a SEPARATE pbcom-pull.lock. (Standing launchd install is a follow-up; run on demand today.)
    source: pbcom-driver -> npx tsx src/cli.ts poll-scores
    env: PROD (reads the PUBLIC PB.com results API with NO login; writes B&E via the record-pbcom-score edge fn using the service role)
    url: reads pickleballtournaments.com public API; writes {SUPABASE_URL}/functions/v1/record-pbcom-score
    host: the club Mac mini ONLY; gated on the committed PBCOM-PUSH-HOST fact (wmpcMacMini1)
    config_scope: pbcom-driver/.env — SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PBCOM_DISCORD_WEBHOOK, PBCOM_BINDING_PATH, PBCOM_PUBLIC_BASE_URL (default pickleballtournaments.com); NO PBCOM_USERNAME needed (public read)
    verify: "poll-scores [<tid>] --dry-run --force-host prints per-division toWrite/alreadyInSync/unmatched and drives nothing; a real run writes the delta + logs written counts"
    rollback: stop the job — nothing is lost; writes are idempotent + fail-closed (an unmatched completed PB match is Discord-alerted, never written)
```

## The one per-machine bootstrap (mini only)

`pbcom-driver/install.sh` is the single per-machine step (safe to re-run; reconcile
may call it): `npm ci`, create `.env` from the template if missing (never overwrites),
install + load the launchd plist (path + log paths rewritten for the machine), then
print the remaining human steps. It does **not** designate the host or start a push on
load. See `AUTO-PUSH-PRNOTES.md` for the exact sequence.

## What does NOT ship from here

- No web app. The FORWARD driver is browser-driving only, mac-mini-launchd.
- The REVERSE direction adds ONE edge function (`record-pbcom-score`) that DOES ride
  branch routing (main→TEST, production→PROD, via edge-functions.yml) — plus the
  reverse poller (`poll-scores`), which is mac-mini-launchd like the forward one.
- Pushing the driver *code* to `main` still deploys **nothing** for the driver — only
  the migration + the edge function ride branch routing. Keep the shapes distinct.
