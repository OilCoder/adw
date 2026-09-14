#!/usr/bin/env bash
# Installs the harness into a project: bash install.sh /path/to/project
set -euo pipefail
target=${1:?usage: install.sh <project-dir>}
src=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$target/.codex" "$target/.codegen/research" "$target/.codegen/contracts"
cp -r "$src/.codex/agents" "$src/.codex/instructions" "$src/.codex/lib" "$src/.codex/rules" "$src/.codex/codegen.mjs" "$target/.codex/"
[[ -f "$target/.codex/models.json" ]] || cp "$src/.codex/models.json" "$target/.codex/"
# The supervisor is the Codex session opened in the project: AGENTS.md hands
# it the role, .codex/config.toml gives it its model and exactly the
# supervisor's permissions, .codex/rules lets it launch the script escalated
# (prompt and permissions must agree, or the model improvises).
[[ -f "$target/AGENTS.md" ]] || cp "$src/templates/AGENTS.md" "$target/AGENTS.md"
[[ -f "$target/.codex/config.toml" ]] || cp "$src/templates/config.toml" "$target/.codex/config.toml"
touch "$target/.gitignore"
for line in ".codegen/runs/" ".codegen/board.html" ".codegen/board.json" ".codegen/journal.jsonl" "wiki/audits/*/audio.*" "__pycache__/" ".pytest_cache/" "node_modules/"; do
  grep -qxF "$line" "$target/.gitignore" || printf '%s\n' "$line" >> "$target/.gitignore"
done
git -C "$target" rev-parse HEAD >/dev/null 2>&1 || echo "note: $target has no commits yet; commit before running build"
echo "installed into $target; open it with: cd $target && codex   (trust the project when asked: .codex/config.toml and .codex/rules load only then)"
