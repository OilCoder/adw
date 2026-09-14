#!/usr/bin/env bash
# Every shell command a prompt cites must be something that role can run, or
# the model improvises in silence (opencode-min HANDOFF 2026-09-10). Roles:
# the supervisor (.codex/instructions/supervisor.md + codegen.md against
# .codex/rules/codegen.rules: a cited `node .codex/codegen.mjs research|build|merge`
# must have an allow rule, since they only work escalated; a cited command that
# a forbidden rule matches is a contradiction), the builder and the researcher
# (.codex/agents/*.md: the researcher has no shell, so it must cite no
# command). Warns only.
#   bash tests/lint-prompts.sh
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
node - <<'JS'
const { readFileSync } = require("node:fs")
let warnings = 0
const warn = (m) => { warnings++; console.log(m) }
const front = (text) => text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [null, "", text]
const cited = (body) => [...new Set([...body.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((c) => /^(node |bash |git |cat |head |tail |sed |grep |ls |python3 |npm |npx |uv |rm )/.test(c)))]
// The rules file, as prefix rules: pattern (a list of words) and decision.
const rules = [...readFileSync(".codex/rules/codegen.rules", "utf8").matchAll(/prefix_rule\(pattern=\[([^\]]*)\],\s*decision="(\w+)"/g)].map((m) => ({ pattern: [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]), decision: m[2] }))
const decide = (cmd) => {
  const words = cmd.split(/\s+/)
  const hits = rules.filter((r) => r.pattern.every((w, i) => words[i] === w)).map((r) => r.decision)
  return hits.includes("forbidden") ? "forbidden" : hits.includes("prompt") ? "prompt" : hits.includes("allow") ? "allow" : "unlisted"
}
const sup = readFileSync(".codex/instructions/supervisor.md", "utf8") + readFileSync(".codex/instructions/codegen.md", "utf8")
for (const c of cited(sup)) {
  const d = decide(c)
  if (d === "forbidden") warn(`supervisor: cites \`${c}\` but a rule forbids it`)
  if (/^node \.codex\/codegen\.mjs (research|build|merge)\b/.test(c) && d !== "allow") warn(`supervisor: cites \`${c}\`, which only works escalated, but no allow rule covers it`)
}
for (const name of ["researcher"]) {
  const [, , body] = front(readFileSync(`.codex/agents/${name}.md`, "utf8"))
  for (const c of cited(body)) warn(`${name}.md: cites \`${c}\` but the researcher has no shell`)
}
console.log(warnings ? `${warnings} warning(s)` : "prompts and rules agree")
JS
