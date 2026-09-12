#!/usr/bin/env bash
# Every shell command an agent prompt cites must be allowed by that agent's bash
# permissions, or the model improvises in silence (HANDOFF 2026-09-10). Warns only.
#   bash tests/lint-prompts.sh
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
node - <<'EOF'
const { readFileSync, readdirSync } = require("node:fs")
let warnings = 0
for (const f of readdirSync(".opencode/agents").filter((x) => x.endsWith(".md"))) {
  const text = readFileSync(`.opencode/agents/${f}`, "utf8")
  const [, front = "", body = ""] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? []
  // bash permissions: lines like `    "git status*": allow` under `bash:`
  const bash = front.match(/^  bash:\n((?:    .*\n)*)/m)?.[1] ?? ""
  const rules = [...bash.matchAll(/^    "([^"]+)": (allow|deny|ask)/gm)].map((m) => ({ pat: m[1], action: m[2] }))
  const glob = (p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
  // last matching rule wins (OpenCode semantics)
  const decide = (cmd) => rules.filter((r) => glob(r.pat).test(cmd)).at(-1)?.action ?? "ask"
  // commands cited in backticks: start with a known program name
  const cited = [...new Set([...body.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((c) => /^(node |bash |git |cat |head |tail |sed |grep |ls |python3 |npm |npx |uv )/.test(c)))]
  // A citation may be a program name with flags but no target (`sed -n`); judge it with an argument appended.
  for (const c of cited) { const a = decide(c) === "allow" ? "allow" : decide(`${c} x`); if (a !== "allow") { warnings++; console.log(`${f}: cites \`${c}\` but bash permission says ${a}`) } }
  const allowed = rules.filter((r) => r.action === "allow" && r.pat !== "*").map((r) => r.pat)
  for (const p of allowed) if (!cited.some((c) => glob(p).test(c)) && !/^(git (status|log|diff|branch)\*|ls\*|head \*|tail \*|sed -n \*|grep \*|cat \.codegen\/\*|npm (ci|install|run|test)\*|npx .*|node --test\*|python3 -m .*|bash \.codegen\/contracts\/\*|git (diff|status)\*)$/.test(p)) console.log(`${f}: allows \`${p}\` which no prompt line cites (fine if intentional)`)
}
console.log(warnings ? `${warnings} warning(s)` : "prompts and permissions agree")
EOF
