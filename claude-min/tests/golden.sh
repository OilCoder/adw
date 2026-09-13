#!/usr/bin/env bash
# Behaviour freeze with the fake opencode (no models, seconds): bash tests/golden.sh [--update] [scenario…]
set -euo pipefail
exec node "$(dirname -- "${BASH_SOURCE[0]}")/golden.mjs" "$@"
