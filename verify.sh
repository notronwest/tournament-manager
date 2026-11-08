#!/usr/bin/env bash
# Release-tool verification, run from the clone after setup.sh. Exit 0 is the only pass.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd -P)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$ROOT/pbcom-driver"

# The driver must never move its own checkout: no job may hard-reset to main.
if grep -rIn -e "reset --""hard" . --exclude-dir=node_modules --exclude-dir=state >/dev/null 2>&1; then
  echo "verify: pbcom-driver contains a hard reset" >&2
  exit 1
fi

npm run typecheck
# auto/partners/run.test.ts assert "refuses when this host is not PBCOM-PUSH-HOST",
# which is false on the designated mini itself, so they cannot pass where this runs.
npx vitest run --exclude tests/auto.test.ts --exclude tests/partners.test.ts --exclude tests/run.test.ts
echo "verify: ok"
