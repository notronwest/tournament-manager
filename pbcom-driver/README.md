# pbcom-driver

The **Bert & Erne → PickleballBrackets.com results-push driver** (D-0045,
tournament-manager **#982**). B&E imports registrations/divisions/partnerships from
PB.com (#981, already merged), generates the DUPR-seeded draw, runs the event, and
**pushes results back to PB.com by driving it as a human** — Playwright, no public API,
mirroring `courtreserve-api`'s Court Reserve driver.

> **Status: ON-DEMAND, SUPERVISED-RUN tool.** The PB.com form flows are now
> implemented from the live director-session capture (D-0045): the 6-step verify
> wizard + Start Matches (`createBracketOnPbcom`) and the score-card modal
> (`submitScoreCard`), plus the last-name match mapping (flow C). Everything around
> them is built and tested (config binding, push state machine, idempotent reconcile,
> dry-run, structured logging). **Login is supervised** (email one-time code — see
> below), and this module deploys **nothing**: standing/unattended running on the mini
> is a separate INFRA-INTAKE decision (see `DESIGN.md`).

## What it does

1. **Reads** the B&E draw for a pbcom-sourced division — `events`,
   `event_registrations` (with the preserved PB.com source ids), and `matches`
   (the generated draw + scores).
2. **Plans** the delta against a push ledger — what bracket/scores are not yet on
   PB.com (idempotent; re-runs push only what changed).
3. **Drives** PB.com through the trace-filled seams, **verifies** each write landed,
   and records the ledger only on a verified push.

## Layout

```
pbcom-driver/
├── src/
│   ├── types.ts          B&E-side domain types (the push input) — the contract
│   ├── config.ts         env / secret binding; no-credential skip (exit 2)
│   ├── binding.ts        declarative tournament↔eid, division↔label resolution
│   ├── log.ts            structured (one-JSON-per-line) logging
│   ├── pbcom/
│   │   ├── session.ts    Playwright session + supervised email-code login
│   │   ├── matchMap.ts   PURE flow-C: last-name row matching + seed-move computation
│   │   └── driver.ts     the two real form flows (createBracketOnPbcom, submitScoreCard)
│   └── push/
│       ├── state.ts      verify→waiting→running→completed (+error/needs_attention)
│       ├── plan.ts       pure reconcile/delta planner (idempotency keys)
│       └── run.ts        executor: singleton gate + lock + dry-run + orchestration
├── tests/                unit tests + synthetic fixtures (no real member data)
├── deploy/               launchd plist + run script (mac-mini archetype)
├── DESIGN.md             placement decision + INFRA-INTAKE answers
└── DEPLOYMENT.md         wmpc-deployment v1
```

## Quickstart

```bash
npm install
npm run test        # unit tests (no browser)
npm run typecheck

# Plan (no browser, no creds) against a synthetic fixture:
npx tsx src/cli.ts push <tournamentId> "Mens Doubles Skill: (3.0 To 3.49)" \
  --dry-run --fixture tests/fixtures/draws.synthetic.json

# A real, SUPERVISED push (needs .env + PBCOM-PUSH-HOST or --force-host):
cp .env.template .env   # fill PBCOM_USERNAME, SUPABASE_URL/KEY, PBCOM_PROFILE_DIR
npx tsx src/cli.ts push <tournamentId> "<divisionLabel>" --force-host
#   → a headed Chrome opens; complete the PB.com email-code login once, then the
#     driver drives the verify wizard + scores. Use ALL in place of <divisionLabel>
#     to push every pbcom-sourced division.
```

## CLI

```
push   <tournamentId> <divisionLabel|ALL> [--dry-run] [--fixture f.json] [--force-host]
verify <tournamentId> [<divisionLabel>]   [--fixture f.json]
```

`<divisionLabel>` is the PB.com division string (`events.source_division_label`).
`--dry-run` / `verify` read + plan + print with **no browser and no creds**.

## The PB.com flows (implemented) + the one remaining seam

| Flow | File | State |
| --- | --- | --- |
| **login** | `src/pbcom/session.ts` → `login()` | **supervised seam** — PB.com uses an email one-time code; the driver reuses a persistent profile or waits (headed) for the operator to enter the code. Fully-unattended login is an OPEN INFRA-INTAKE item. |
| **bracket create** | `src/pbcom/driver.ts` → `createBracketOnPbcom()` | **implemented** — drives the 6-step verify wizard (Save→Continue, "no medal rounds" radio, seed via Sort/Move Up-Down, COMPLETE VERIFICATION) then Start Matches; verify-after-write. |
| **score submit** | `src/pbcom/driver.ts` → `submitScoreCard()` | **implemented** — locates the row by last names (flow C), opens the score-cell "Match N" modal (**never** the "Official" print button), enters G1 + win/loss, Save Scores; verify-after-write. |
| **team↔match mapping** | `src/pbcom/matchMap.ts` | **implemented + unit-tested** — pure last-name-set matching, orientation, and seed-move computation. |

See `DESIGN.md` for the placement decision, the #987 identity correction, and the
INFRA-INTAKE checklist for standing/unattended running.
