# pbcom-driver

The **Bert & Erne → PickleballBrackets.com results-push driver** (D-0045,
tournament-manager **#982**). B&E imports registrations/divisions/partnerships from
PB.com (#981, already merged), generates the DUPR-seeded draw, runs the event, and
**pushes results back to PB.com by driving it as a human** — Playwright, no public API,
mirroring `courtreserve-api`'s Court Reserve driver.

> **Status: NON-FORM scaffold.** Everything around the PB.com forms is built and
> tested (session lifecycle, config binding, the push state machine, idempotent
> reconcile, dry-run, structured logging). The two PB.com form operations
> (`createBracketOnPbcom`, `submitScoreCard`) are typed stubs with clearly-marked
> **TRACE SEAMS** — their DOM bodies are filled from the live director-session trace
> (D-0045 "trace first"). Selectors are **not guessed**.

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
│   │   ├── session.ts    Playwright session/login SCAFFOLD (TRACE SEAM: login)
│   │   └── driver.ts     the two form seams (createBracketOnPbcom, submitScoreCard)
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
npx tsx src/cli.ts push --tournament <id> --dry-run --fixture tests/fixtures/draws.synthetic.json

# A real push (needs .env + the trace-filled seams + PBCOM-PUSH-HOST):
cp .env.template .env   # fill PBCOM_* and PBCOM_DB_URL
npx tsx src/cli.ts push --force-host   # --force-host for local dev only
```

## The two seams awaiting the trace

| Seam | File | Fills |
| --- | --- | --- |
| login | `src/pbcom/session.ts` → `login()` | the PB.com login form selectors + post-login signal |
| bracket create | `src/pbcom/driver.ts` → `createBracketOnPbcom()` | navigate to the event/division, create the bracket, seat seeded teams, verify |
| score submit | `src/pbcom/driver.ts` → `submitScoreCard()` | locate the match by source ids, enter + save the score, verify |

Their **input/output types are final** (see `driver.ts`); only the DOM bodies are
pending. See `DESIGN.md` for the placement decision and the INFRA-INTAKE checklist.
