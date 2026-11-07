#!/usr/bin/env bash
# Pull completed scores PB.com -> B&E (the REVERSE direction) from the public results
# API, no login. Runs on the club Mac mini via launchd (com.wmpc.pbcom-score-pull)
# every ~5 min. Shares the PBCOM-PUSH-HOST singleton gate and takes its own
# state/pbcom-pull.lock.
#
# It runs the code in THIS release clone as-is: no fetch, no pull, no reset. A new
# version arrives only when the release tool re-releases and re-runs setup.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

exec npx tsx src/cli.ts poll-scores
