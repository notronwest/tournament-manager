#!/usr/bin/env bash
# check-migration-drift.sh — alarm for Supabase schema drift.
#
# DRIFT = a migration APPLIED on the remote (prod) DB that is NOT a committed
# file in supabase/migrations/. That's the failure that silently blocks
# `supabase db push` for everyone (see the 2026-06-06 incident: two migrations
# applied directly to prod, never checked in, blocked all later deploys).
#
# Exit codes: 0 = in sync · 1 = drift detected · 2 = could not verify.
# Run in CI (see .github/workflows/migration-drift-check.yml) or locally.
#
# Env (CI secrets): SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD,
# SUPABASE_PROJECT_REF. Locally, an already-linked project also works.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # supabase/scripts/ -> repo root
cd "$ROOT"

command -v supabase >/dev/null 2>&1 || { echo "drift-check: supabase CLI not found"; exit 2; }

# Committed migration versions (the 14-digit timestamp prefix of each file).
local_versions=$(ls supabase/migrations/*.sql 2>/dev/null \
  | sed -E 's#.*/([0-9]{14})_.*#\1#' | grep -E '^[0-9]{14}$' | sort -u)

# Link (idempotent) if a ref is provided, then read remote-applied migrations.
if [ -n "${SUPABASE_PROJECT_REF:-}" ]; then
  supabase link --project-ref "$SUPABASE_PROJECT_REF" >/dev/null 2>&1 || true
fi
list=$(supabase migration list --linked 2>&1) || {
  echo "drift-check: could not read remote migration list:"; echo "$list"; exit 2; }

# Remote-applied versions live in the REMOTE column. The CLI draws the table
# with unicode bars (│); normalize to | then take column 2. Defensive: any
# 14-digit token in that column counts.
remote_versions=$(printf '%s\n' "$list" | sed 's/│/|/g' \
  | awk -F'|' 'NF>=2 { v=$2; gsub(/[^0-9]/,"",v); if (v ~ /^[0-9]{14}$/) print v }' | sort -u)

# Fail toward alerting: if we parsed nothing, say so rather than report "clean".
[ -n "$remote_versions" ] || {
  echo "drift-check: parsed zero remote versions — verify manually:"; echo "$list"; exit 2; }

# Drift = applied-on-remote but NOT committed locally.
drift=$(comm -13 <(printf '%s\n' "$local_versions") <(printf '%s\n' "$remote_versions"))

if [ -n "$drift" ]; then
  echo "DRIFT DETECTED — applied on remote but NOT committed to supabase/migrations/:"
  printf '  %s\n' $drift
  echo
  echo "Fix: \`supabase db pull\` to reconcile the orphan(s) into the repo, commit, and"
  echo "merge. Until then, \`supabase db push\` is blocked for everyone."
  exit 1
fi

echo "drift-check: IN SYNC — all $(printf '%s\n' "$remote_versions" | wc -l | tr -d ' ') remote migrations are committed."
exit 0
