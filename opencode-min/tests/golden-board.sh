#!/usr/bin/env bash
# Freezes the board HTML/JSON for a fixed state: bash tests/golden-board.sh [--update]
set -euo pipefail
TZ=UTC exec node "$(dirname -- "${BASH_SOURCE[0]}")/golden-board.mjs" "$@"
