#!/usr/bin/env bash
# Everything that must stay green while the harness is reorganized. No models, no cost.
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
for f in .codex/*.mjs .codex/lib/*.mjs tests/*.mjs tests/fake-codex/codex; do node --check "$f"; done
bash tests/lint-prompts.sh
bash tests/golden-board.sh
bash tests/golden.sh
