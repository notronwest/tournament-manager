#!/usr/bin/env bash
# Push B&E results to PickleballBrackets.com by driving PB.com as a human.
# Runs on the club Mac mini via launchd (com.wmpc.pbcom-push). Mirrors the
# courtreserve-api drain jobs:
#   • Refuses to run anywhere but the host named in PBCOM-PUSH-HOST (singleton).
#   • Holds a same-machine lock; claims/records are idempotent so a re-run only
#     pushes the delta.
#   • Inert (the CLI exits 2, logged) until PBCOM_* creds + PBCOM_DB_URL are in .env.
#   • Drives PB.com only through the trace-filled seams; until the trace lands, a
#     real run surfaces a clear "TRACE SEAM not filled" error and pushes nothing.
# Invoked with no --tournament: pushes every tournament in the binding config.
set -euo pipefail
cd "$(dirname "$0")/.."

# tsx/node come from the repo's node_modules; ensure Node is on PATH for launchd.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

exec npx tsx src/cli.ts push
