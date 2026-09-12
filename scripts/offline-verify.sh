#!/usr/bin/env bash
# scripts/offline-verify.sh — one-command offline verification harness
# (issue #735, epic #732).
#
# Proves a laptop is actually ready to run Bert & Erne with no Internet, by
# exercising the exact path a fresh machine takes and failing loudly on the
# two blockers that bit us live on 2026-09-11 setting up the tournament laptop:
#
#   1. Missing web deps — a checkout that predates a dependency change (e.g.
#      the self-hosted @fontsource/* fonts) has node_modules missing packages,
#      and the app dies at Vite import time. Caught here by a clean-checkout
#      `npm ci` + an offline build.
#   2. `supabase start` failing on the inbucket/mailpit port bug in the pinned
#      CLI. Caught here because this script actually starts the stack — if it
#      can't come up, the harness fails instead of the operator discovering it
#      at the venue.
#
# Then it brings the REAL offline runtime up (scripts/offline.sh) and confirms
# the app reaches first paint with the network simulated down (localhost-only).
#
# Usage:
#   bash scripts/offline-verify.sh          # deps + supabase + first-paint (safe:
#                                           #   writes NOTHING to the local DB)
#   bash scripts/offline-verify.sh --full   # ALSO run the full mock-event audit
#                                           #   (network-audit.spec.ts) — this
#                                           #   WRITES mock tournaments/teams to
#                                           #   the local DB, so don't run --full
#                                           #   against a stack holding a real
#                                           #   event.
#
# Prereqs (all one-time, WITH network — same dry-run window as docs/OFFLINE.md):
# Docker running, the Supabase CLI installed, the npm cache populated (run
# scripts/offline.sh once online), and Playwright's chromium installed
# (`npx --prefix web playwright install chromium`).
set -euo pipefail
cd "$(dirname "$0")/.."

FULL=0
if [ "${1:-}" = "--full" ]; then FULL=1; fi

step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Static bundle audit — no remote assets baked into the offline build.
#    (This also builds in offline mode, so it fails here if deps are missing.)
# ---------------------------------------------------------------------------
step "Bundle audit (no remote http(s) assets)"
./scripts/offline-bundle-grep.sh

# ---------------------------------------------------------------------------
# 2. Clean-checkout dependency install — reproduce node_modules from the
#    lockfile exactly. This is the blocker-1 guard: if a package can't be
#    resolved (missing from the lockfile or the npm cache), it fails here.
# ---------------------------------------------------------------------------
step "Web dependencies install from the lockfile (npm ci)"
npm --prefix web ci

# ---------------------------------------------------------------------------
# 3 + 4. Start the real offline runtime and confirm first paint with the
#        network down. offline.sh does `supabase start` (blocker-2 guard) +
#        writes the offline env + launches Vite. We launch it in its own
#        process group so we can tear the whole tree down afterwards.
# ---------------------------------------------------------------------------
step "Offline runtime up + first paint (network simulated down)"

LOG="$(mktemp -t offline-verify)"
# setpgrp makes this a new process-group leader (macOS has no `setsid`); the
# whole runtime tree then shares the group so cleanup can signal all of it.
perl -e 'setpgrp(0,0); exec @ARGV' bash ./scripts/offline.sh >"$LOG" 2>&1 &
LAUNCHER_PID=$!

cleanup() {
  # Signal the entire process group (negative PID) — kills caffeinate, npm,
  # and Vite together. Leaves the Supabase stack running, matching offline.sh.
  kill -TERM "-$LAUNCHER_PID" 2>/dev/null || true
  wait "$LAUNCHER_PID" 2>/dev/null || true
  rm -f "$LOG" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for Vite to print its Local URL (first run also does npm ci + supabase
# start, so give it real time).
BASE_URL=""
for _ in $(seq 1 180); do
  if ! kill -0 "$LAUNCHER_PID" 2>/dev/null; then
    echo "---- scripts/offline.sh output ----" >&2
    cat "$LOG" >&2
    fail "offline runtime exited before it was ready (see output above)."
  fi
  BASE_URL="$(grep -oE 'http://localhost:[0-9]+' "$LOG" | head -1 || true)"
  [ -n "$BASE_URL" ] && break
  sleep 1
done
[ -n "$BASE_URL" ] || { cat "$LOG" >&2; fail "Vite never reported a Local URL (offline runtime did not come up)."; }
echo "Offline app serving at $BASE_URL"

# Run the deterministic network-down first-paint check against that server.
( cd web && OFFLINE_BASE_URL="$BASE_URL" npx playwright test \
    --config=playwright.offline.config.ts e2e/offline/first-paint.spec.ts ) \
  || fail "first-paint audit failed — the app did not paint cleanly offline."

# ---------------------------------------------------------------------------
# 5. Optional: full mock-event network audit (writes to the local DB).
# ---------------------------------------------------------------------------
if [ "$FULL" = "1" ]; then
  step "Full mock-event network audit (--full; writes mock data to the local DB)"
  ( cd web && OFFLINE_BASE_URL="$BASE_URL" npx playwright test \
      --config=playwright.offline.config.ts e2e/offline/network-audit.spec.ts ) \
    || fail "full network-down event audit failed."
fi

printf '\n\033[32mPASS — offline runtime verified end to end%s.\033[0m\n' \
  "$([ "$FULL" = "1" ] && echo " (incl. full mock-event audit)")"
