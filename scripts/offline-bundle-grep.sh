#!/usr/bin/env bash
# Offline network audit — the grep part (issue #735, epic #732).
#
# Builds the app in `offline` mode and greps the built bundle for every
# `http://`/`https://` literal. Anything NOT on the allowlist below fails the
# script — the allowlist is a hand-reviewed list of strings that are safe
# because they're never fetched (doc/error-message links, XML namespace
# URIs baked into library code) or because they're localhost. If this script
# finds something new, don't add it to the allowlist without checking
# whether the app actually calls fetch()/loads a <script>/<link> against it
# offline — that's exactly the "stray remote asset" this audit exists to
# catch.
#
# Usage: ./scripts/offline-bundle-grep.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Building the app in offline mode..."
(cd web && npm run build:offline --silent)

# Hosts that are safe to appear as string literals in the built JS/CSS —
# each is either localhost, or a doc/error-message URL string that the app
# never fetches or injects as a script/link. Re-verify with a targeted grep
# before adding anything here.
ALLOWLIST_REGEX='^(localhost|127\.0\.0\.1|example\.com|github\.com|reactjs\.org|fb\.me|developer\.mozilla\.org|www\.w3\.org|purl\.oclc\.org|schemas\.microsoft\.com|schemas\.openxmlformats\.org|sheetjs\.openxmlformats\.org|stripe\.com|dashboard\.stripe\.com)$'

hosts="$(grep -ohE "https?://[a-zA-Z0-9][a-zA-Z0-9._-]*" web/dist/assets/*.js web/dist/assets/*.css 2>/dev/null \
  | sed -E 's#^https?://##' \
  | sort -u)"

flagged=""
while IFS= read -r host; do
  [ -z "$host" ] && continue
  if ! [[ "$host" =~ $ALLOWLIST_REGEX ]]; then
    flagged="$flagged$host"$'\n'
  fi
done <<< "$hosts"

echo
echo "Hosts referenced as http(s) literals in web/dist:"
echo "$hosts" | sed 's/^/  /'
echo

if [ -n "$flagged" ]; then
  echo "FAIL — unreviewed host(s) found in the offline bundle:" >&2
  echo "$flagged" | sed 's/^/  /' >&2
  echo "Either this is a real stray remote asset (fix the code), or it's" >&2
  echo "safe and belongs in ALLOWLIST_REGEX in this script — verify which" >&2
  echo "before doing either." >&2
  exit 1
fi

echo "PASS — every http(s) literal in the offline bundle is on the reviewed allowlist."
