#!/usr/bin/env bash
# Every shell command a prompt cites must be allowed by that role's Bash rules,
# or the model improvises in silence (HANDOFF 2026-09-10). Roles: builder and
# researcher (.claude/agents/*.md, `allow`/`deny` in the front matter) and the
# supervisor (.claude/rules/supervisor.md + codegen.md against
# templates/settings.json). Warns only.
#   bash tests/lint-prompts.sh
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
node - <<'JS'
const { readFileSync, readdirSync } = require("node:fs")
let warnings = 0
const front = (text) => text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [null, "", text]
const list = (f, k) => { const v = (f.match(new RegExp(`^${k}:\\s*(.+)$`, "m")) ?? [])[1]; return v ? JSON.parse(v) : [] }
// Claude Code Bash rules as the harness writes them: `Bash(prefix*)`, `*` matches anything (verified 2026-09-12: `Bash(bash .codegen/contracts/*)` let the builder run its gate in default mode).
const bashRules = (rules) => rules.filter((r) => /^Bash\(/.test(r)).map((r) => r.slice(5, -1))
const glob = (p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
const decide = (allow, deny, cmd) => (deny.some((p) => glob(p).test(cmd)) ? "deny" : allow.some((p) => glob(p).test(cmd)) ? "allow" : "deny (unlisted)")
const cited = (body) => [...new Set([...body.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((c) => /^(node |bash |git |cat |head |tail |sed |grep |ls |python3 |npm |npx |uv )/.test(c)))]
const check = (name, body, allow, deny) => {
  const A = bashRules(allow), D = deny.includes("Bash") ? ["*"] : bashRules(deny)
  for (const c of cited(body)) {
    const a = decide(A, D, c) === "allow" ? "allow" : decide(A, D, `${c} x`)
    if (a !== "allow") { warnings++; console.log(`${name}: cites \`${c}\` but Bash permission says ${a}`) }
  }
}
for (const f of readdirSync(".claude/agents").filter((x) => x.endsWith(".md"))) {
  const [, fm, body] = front(readFileSync(`.claude/agents/${f}`, "utf8"))
  check(f, body, list(fm, "allow"), list(fm, "deny"))
}
const settings = JSON.parse(readFileSync("templates/settings.json", "utf8")).permissions
check("supervisor", readFileSync(".claude/rules/supervisor.md", "utf8") + readFileSync(".claude/rules/codegen.md", "utf8"), settings.allow, settings.deny)
console.log(warnings ? `${warnings} warning(s)` : "prompts and permissions agree")
JS
