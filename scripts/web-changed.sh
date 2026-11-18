#!/usr/bin/env bash
# Did a push change anything the website bundle is built from?
# Usage: web-changed.sh <event> <before-sha> <sha>
# Prints "yes" or "no". The list of inputs lives in scripts/web-build-inputs.txt.
# workflow_dispatch, or a before sha that is missing, all-zero or unreadable,
# counts as "yes" (keeps the bundle wait).
set -u
event="${1:-}"; before="${2:-}"; sha="${3:-HEAD}"
inputs="$(dirname "$0")/web-build-inputs.txt"
if [ "$event" = "push" ] \
   && [ -n "$before" ] && [ "$before" != "0000000000000000000000000000000000000000" ] \
   && git cat-file -e "$before^{commit}" 2>/dev/null \
   && changed="$(grep -v '^\s*$' "$inputs" | xargs git diff --name-only "$before" "$sha" --)" \
   && [ -z "$changed" ]; then
  echo no
else
  echo yes
fi
