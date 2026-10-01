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
# It does NOT start a push on load (RunAtLoad=false) and does NOT designate this
# host as the driver — that is the committed PBCOM-PUSH-HOST fact, set by hand.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

LABEL="com.wmpc.pbcom-push"
PLIST_SRC="$HERE/deploy/com.wmpc.pbcom-push.plist"
LA_DIR="$HOME/Library/LaunchAgents"
PLIST_DST="$LA_DIR/$LABEL.plist"
LOG_DIR="$HOME/.local/state/wmpc-pbcom"
RUN_SH="$HERE/deploy/pbcom-push.sh"

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

# 3) launchd job ───────────────────────────────────────────────────────────────
mkdir -p "$LA_DIR" "$LOG_DIR"
echo "-- installing launchd job $LABEL (~every 150s, RunAtLoad=false)"
# Rewrite the example path + log paths in the committed plist to this machine's.
sed \
  -e "s#/PATH/TO/tournament-manager/pbcom-driver/deploy/pbcom-push.sh#$RUN_SH#g" \
  -e "s#/Users/notronwest/.local/state/wmpc-pbcom#$LOG_DIR#g" \
  "$PLIST_SRC" > "$PLIST_DST"

# Reload cleanly (unload first so a re-run refreshes the definition).
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "   loaded $PLIST_DST (logs → $LOG_DIR/push.{out,err}.log)"

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

The launchd job is loaded but will NO-OP until PBCOM-PUSH-HOST names this host and
.env is filled. It never fires on load. See DEPLOYMENT.md + AUTO-PUSH-PRNOTES.md.
EOF
