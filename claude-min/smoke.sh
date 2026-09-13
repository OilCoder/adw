#!/usr/bin/env bash
# End-to-end check of the harness with one real model: bash smoke.sh [model]
# Run it from a plain terminal, or with `env -u CLAUDECODE` from inside Claude Code.
set -euo pipefail
src=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/claude-min-smoke.XXXXXX")
[[ -n "${KEEP:-}" ]] || trap 'rm -rf -- "$work"' EXIT; echo "workdir: $work"
cp -a "$src/tests/fixtures/${FIXTURE:-builder-basic}/." "$work/"
bash "$src/install.sh" "$work" >/dev/null
if [[ -n "${1:-}" ]]; then
  node -e 'const f=process.argv[1],m=JSON.parse(require("fs").readFileSync(f));m.builder=[process.argv[2]];m.researcher=[process.argv[2]];require("fs").writeFileSync(f,JSON.stringify(m,null,2))' "$work/.claude/models.json" "$1"
fi
git -C "$work" init -q && git -C "$work" add -A && git -C "$work" -c user.name=smoke -c user.email=smoke@localhost commit -qm "fixture"
cd "$work" && node .claude/codegen.mjs ${CMD:-build --parallel 1}
