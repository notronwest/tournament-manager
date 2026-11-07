#!/usr/bin/env bash
# Release-tool entry point. The only thing that ships from this repo by running a
# script is the PB.com results driver on the club Mac mini; the web app and the
# Supabase schema ship by branch routing (see DEPLOYMENT.md) and are not touched here.
# Non-interactive mode: WMPC_RELEASE_NONINTERACTIVE=1 with stdin closed. Nothing here prompts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd -P)"
exec bash "$ROOT/pbcom-driver/install.sh" </dev/null
