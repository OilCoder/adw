#!/usr/bin/env bash
# Everything that must stay green while the harness is reorganized. No models, no cost.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
for f in .opencode/*.mjs tests/*.mjs tests/fake-opencode/opencode; do node --check "$f"; done
bash tests/lint-prompts.sh
bash tests/golden-board.sh
bash tests/golden.sh
