#!/usr/bin/env bash
# Push B&E results to PickleballBrackets.com by driving PB.com as a human.
# Runs on the club Mac mini via launchd (com.wmpc.pbcom-push) every ~150s. Mirrors
# the courtreserve-api drain jobs:
#   • Refuses to run anywhere but the host named in PBCOM-PUSH-HOST (singleton).
#   • Holds a same-machine lock; the DB ledger is the backstop — a re-run only
#     pushes the DELTA (create-if-needed + scores since the last confirmed push).
#   • Inert (the CLI exits 2, logged) until PBCOM_USERNAME + SUPABASE_* are in .env.
#   • A lapsed PB.com session records needs_attention + posts a Discord alert and
#     exits cleanly (no crash-loop); a human re-auths headed once and it resumes.
# `poll` = the unattended all-active mode: every ACTIVE, PB.com-bound division.
set -euo pipefail
cd "$(dirname "$0")/.."

# tsx/node come from the repo's node_modules; ensure Node is on PATH for launchd.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

exec npx tsx src/cli.ts poll
