#!/usr/bin/env bash
# Claude Code status line for claude-min projects. Claude Code pipes session JSON
# here on every event; the `rate_limits` object (Pro/Max, after the first API
# response) is the only official window into the subscription's quota, so the
# script keeps the latest copy in ~/.claude/usage.json for the codegen board and
# prints a short line: model, context, 5-hour and 7-day usage.
# Enable once in ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "bash ~/.claude/statusline.sh", "refreshInterval": 60 }
input=$(cat)
node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"))
const rl = d.rate_limits
if (rl && (rl.five_hour || rl.seven_day)) {
  const f = require("path").join(require("os").homedir(), ".claude", "usage.json")
  try { require("fs").writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), plan: d.subscription_type ?? null, rate_limits: rl }, null, 2)) } catch {}
}
const pct = (w) => (w && w.used_percentage != null ? `${Math.round(w.used_percentage)}%` : "–")
const ctx = d.context_window?.used_percentage
process.stdout.write(`[${d.model?.display_name ?? "?"}] ctx ${ctx != null ? Math.round(ctx) + "%" : "–"} · 5h ${pct(rl?.five_hour)} · 7d ${pct(rl?.seven_day)}`)
' <<<"$input"
