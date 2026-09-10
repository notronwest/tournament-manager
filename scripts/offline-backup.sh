#!/usr/bin/env bash
# Snapshot the local offline Postgres database to a plain .sql file that can
# be copied to a USB stick (issue #733). Run this periodically during an
# offline event as the durability backstop, alongside the Docker volume's
# own persistence (which survives a process kill/restart on its own).
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v supabase >/dev/null 2>&1; then
  echo "error: supabase CLI not found on PATH." >&2
  exit 1
fi

mkdir -p backups
OUT="backups/offline-$(date +%Y%m%dT%H%M%S).sql"

supabase db dump --local -f "$OUT"

echo "Wrote $OUT — copy this file to a USB stick."
