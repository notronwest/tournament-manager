#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# pbcom-driver installer — the ONE per-machine step to make the unattended
# PickleballBrackets.com results push run on the club Mac mini.
#
# Idempotent and safe to re-run (reconcile.sh can call it on sync). It:
#   1. installs node deps (npm ci, falling back to npm install),
#   2. creates .env from .env.template if missing (NEVER overwrites an existing one),
#   3. installs + (re)loads the launchd job com.wmpc.pbcom-push (~every 150s),
#      with the real checkout path and per-user log paths written in,
#   4. prints the remaining one-time human steps (set PBCOM-PUSH-HOST, do the
#      one-time PB.com login, add PBCOM_DISCORD_WEBHOOK).
#
# Runs ONLY from the release clone (~/data/web/wmpc/releases/tournament-manager/
# pbcom-driver) — a commit the release tool has approved — never from a working
# checkout that tracks main. Anywhere else it refuses before touching anything.
#
# It does NOT start a push on load (RunAtLoad=false) and does NOT designate this
# host as the driver — that is the committed PBCOM-PUSH-HOST fact, set by hand.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"

# 0) release-clone guard ───────────────────────────────────────────────────────
# The jobs below drive a live public site. They must be bound to an approved
# commit, so refuse unless this script sits in the release clone.
RELEASE_DIR="$HOME/data/web/wmpc/releases/tournament-manager/pbcom-driver"
RELEASE_REAL="$(cd "$RELEASE_DIR" 2>/dev/null && pwd -P || true)"
if [ -z "$RELEASE_REAL" ] || [ "$HERE" != "$RELEASE_REAL" ]; then
  echo "REFUSING: install.sh must run from the release clone, not from here." >&2
  echo "  running from: $HERE" >&2
  echo "  required:     $RELEASE_DIR" >&2
  echo "  A checkout that tracks main would put unreleased code behind a live PB.com account." >&2
  exit 3
fi
cd "$HERE"

LA_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/.local/state/wmpc-pbcom"

echo "== pbcom-driver install =="
echo "checkout: $HERE"

# 1) deps ─────────────────────────────────────────────────────────────────────
echo "-- installing node deps"
if [ -f package-lock.json ]; then
  npm ci || npm install
else
  npm install
fi
echo "   note: the driver uses the REAL installed Google Chrome (channel: chrome)."
echo "         Ensure Google Chrome is installed on this mini (Playwright drives it)."

# 2) .env (never overwrite) ────────────────────────────────────────────────────
if [ -f .env ]; then
  echo "-- .env exists — leaving it untouched"
else
  cp .env.template .env
  echo "-- created .env from .env.template — FILL IT IN (PBCOM_USERNAME, SUPABASE_URL,"
  echo "   SUPABASE_SERVICE_ROLE_KEY, PBCOM_PROFILE_DIR, PBCOM_DISCORD_WEBHOOK)."
fi

# 3) launchd jobs ──────────────────────────────────────────────────────────────
mkdir -p "$LA_DIR" "$LOG_DIR"

# install_job <label> <script-name> — rewrite the example path + log paths in the
# committed plist to this machine's, then reload cleanly (unload first so a re-run
# refreshes the definition). Neither job fires on load (RunAtLoad=false).
install_job() {
  local label="$1" script="$2"
  local src="$HERE/deploy/$label.plist" dst="$LA_DIR/$label.plist"
  echo "-- installing launchd job $label (RunAtLoad=false)"
  sed \
    -e "s#/PATH/TO/tournament-manager/pbcom-driver/deploy/$script#$HERE/deploy/$script#g" \
    -e "s#/Users/notronwest/.local/state/wmpc-pbcom#$LOG_DIR#g" \
    "$src" > "$dst"
  launchctl unload "$dst" 2>/dev/null || true
  launchctl load "$dst"
  echo "   loaded $dst"
}
install_job com.wmpc.pbcom-push pbcom-push.sh
install_job com.wmpc.pbcom-score-pull pbcom-score-pull.sh
echo "   logs -> $LOG_DIR/{push,score-pull}.{out,err}.log"

# The old hand-placed pull job (label com.wmpc.pbcom-pull) fetched and force-reset
# a checkout to main every 5 minutes. It must never be loaded again.
if launchctl list 2>/dev/null | grep -q 'com\.wmpc\.pbcom-pull$'; then
  echo "WARNING: the retired job com.wmpc.pbcom-pull is loaded. Unload it and delete its plist:" >&2
  echo "  launchctl unload ~/Library/LaunchAgents/com.wmpc.pbcom-pull.plist" >&2
fi

# 4) remaining human steps ─────────────────────────────────────────────────────
cat <<EOF

== almost done — the one-time human steps ==
1. Designate THIS mini as the driver (singleton gate 1). Create the committed fact:
     echo "$(hostname -s)" > "$HERE/PBCOM-PUSH-HOST"    # then commit it
   (An UNSET fact fails closed: nobody drives.)
2. Fill $HERE/.env  (PBCOM_USERNAME, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
   PBCOM_PROFILE_DIR, and PBCOM_DISCORD_WEBHOOK for out-of-sync alerts).
3. Do the ONE-TIME PB.com login (email one-time code) into the persistent profile,
   HEADED, so the session is reused unattended afterwards:
     npx tsx src/cli.ts push <tournamentId> ALL --force-host --dry-run   # sanity (no browser)
     npx tsx src/cli.ts poll --force-host                                # headed: complete the code
4. Confirm the binding config exists (PBCOM_BINDING_PATH; see binding.example.json)
   mapping each B&E tournament to its PB.com eid.

The launchd jobs are loaded but will NO-OP until PBCOM-PUSH-HOST names this host and
.env is filled. It never fires on load. See DEPLOYMENT.md + AUTO-PUSH-PRNOTES.md.
EOF
