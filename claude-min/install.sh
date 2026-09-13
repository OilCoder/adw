#!/usr/bin/env bash
# Installs the harness into a project: bash install.sh /path/to/project
set -euo pipefail
target=${1:?usage: install.sh <project-dir>}
src=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$target/.claude" "$target/.codegen/research" "$target/.codegen/contracts"
cp -r "$src/.claude/agents" "$src/.claude/rules" "$src/.claude/lib" "$src/.claude/codegen.mjs" "$target/.claude/"
# modules used to sit flat next to codegen.mjs (before 2026-09-13); remove those copies so nothing stale is left
rm -f "$target"/.claude/{agent,sandbox,board,board-html}.mjs "$target/.claude/board.css"
[[ -f "$target/.claude/models.json" ]] || cp "$src/.claude/models.json" "$target/.claude/"
# The supervisor is the Claude Code session opened in the project: CLAUDE.md
# hands it the role, .claude/settings.json gives it exactly the supervisor's
# permissions (prompt and permissions must agree, or the model improvises).
[[ -f "$target/CLAUDE.md" ]] || cp "$src/templates/CLAUDE.md" "$target/CLAUDE.md"
[[ -f "$target/.claude/settings.json" ]] || cp "$src/templates/settings.json" "$target/.claude/settings.json"
touch "$target/.gitignore"
for line in ".codegen/runs/" ".codegen/board.html" ".codegen/board.json" ".codegen/journal.jsonl" ".claude/settings.local.json" "wiki/audits/*/audio.*" "__pycache__/" ".pytest_cache/" "node_modules/"; do
  grep -qxF "$line" "$target/.gitignore" || printf '%s\n' "$line" >> "$target/.gitignore"
done
git -C "$target" rev-parse HEAD >/dev/null 2>&1 || echo "note: $target has no commits yet; commit before running build"
echo "installed into $target; open it with: cd $target && claude"
