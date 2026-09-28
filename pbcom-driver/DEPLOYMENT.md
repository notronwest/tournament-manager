# Deployment — pbcom-driver (module)

This module does **not** ship through tournament-manager's branch routing. The web
app and edge functions deploy on `main`→TEST / `production`→PROD; **`pbcom-driver`
deploys via launchd on the club Mac mini** (Playwright can't run in an edge function
or on a datacenter IP), exactly like `courtreserve-api`. Pushing to `main` deploys
**nothing** for this module.

> **Status: scaffold — NOT YET WIRED to run.** The launchd job below is designed but
> intentionally not installed by any reconcile step in this PR, and the form seams are
> unfilled, so a real run cannot push. Productionization (installer, reconcile wiring,
> HOST fact, ledger migration) is the INFRA-INTAKE follow-up in `DESIGN.md`.

```yaml
# wmpc-deployment: v1
repo: tournament-manager
module: pbcom-driver
archetype: mac-mini-launchd
branches:
  main: n/a for this module — pushing to main deploys NOTHING here; a human installs on the mini
  production: n/a for this module
targets:
  - name: push
    kind: mac-mini-launchd
    trigger: NOT YET WIRED — will be launchd job com.wmpc.pbcom-push (~every 2 min) once installed on the mini; today run by hand
    source: pbcom-driver/deploy/pbcom-push.sh -> npx tsx src/cli.ts push
    env: PROD (drives the org's live PB.com account; reads the tournament-manager DB)
    url: n/a — drives pickleballbrackets.com; no inbound endpoint
    host: the club Mac mini ONLY; gated on the committed PBCOM-PUSH-HOST fact, not on where installed
    config_scope: pbcom-driver/.env on the mini (gitignored) — PBCOM_BASE_URL, PBCOM_USERNAME, PBCOM_PASSWORD, PBCOM_DB_URL, PBCOM_BINDING_PATH; plus the committed PBCOM-PUSH-HOST fact and the binding config (tournament↔eid). Missing creds → exit 2 (no-credential skip), never crashes
    verify: "npx tsx src/cli.ts push --dry-run --fixture tests/fixtures/draws.synthetic.json prints the plan and drives nothing; a real run logs to ~/.local/state/wmpc-pbcom/push.{out,err}.log"
    rollback: launchctl unload the plist — nothing queued is lost; the ledger reconciles the delta on the next run. NOTE the driver NEVER deletes on PB.com; the worst unattended outcome is an un-pushed score, surfaced as needs_attention
  - name: form-seams
    kind: unknown
    trigger: filled from the PB.com director-session trace (D-0045 "trace first") — until then a real push errors "TRACE SEAM not filled"
    source: pbcom-driver/src/pbcom/session.ts (login), pbcom-driver/src/pbcom/driver.ts (createBracketOnPbcom, submitScoreCard)
    env: n/a
    url: n/a
    host: n/a
    config_scope: n/a
    verify: unit tests cover everything AROUND the seams; the seams themselves need the trace + a live PB.com verify
    rollback: n/a
```

## What does NOT ship from here

- No web app, no edge function, no migration. This module is browser-driving only.
- The **push ledger table** and the **reconcile/launchd wiring** are deliberately
  absent (see `DESIGN.md` gaps) so this PR deploys nothing.
