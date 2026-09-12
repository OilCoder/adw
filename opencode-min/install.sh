#!/usr/bin/env bash
# Installs the minimal codegen harness into a project: bash install.sh /path/to/project
set -euo pipefail
target=${1:?usage: install.sh <project-dir>}
src=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$target/.opencode" "$target/.codegen/research" "$target/.codegen/contracts"
cp -r "$src/.opencode/agents" "$src/.opencode/instructions" "$src"/.opencode/*.mjs "$src/.opencode/board.css" "$target/.opencode/"
[[ -f "$target/.opencode/models.json" ]] || cp "$src/.opencode/models.json" "$target/.opencode/"
[[ -f "$target/opencode.json" ]] || cp "$src/opencode.json" "$target/"
touch "$target/.gitignore"
for line in ".codegen/runs/" ".codegen/board.html" ".codegen/board.json" ".codegen/journal.jsonl" "wiki/audits/*/audio.*" "__pycache__/" ".pytest_cache/" "node_modules/"; do
  grep -qxF "$line" "$target/.gitignore" || printf '%s\n' "$line" >> "$target/.gitignore"
done
git -C "$target" rev-parse HEAD >/dev/null 2>&1 || echo "note: $target has no commits yet; commit before running build"
echo "installed into $target"
