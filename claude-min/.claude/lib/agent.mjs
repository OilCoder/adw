// Processes and agents: run a command with a timeout, run one agent through
// `claude -p` and read its events, run tasks in a pool, and climb the model
// ladder. No state files are touched here; codegen.mjs owns .codegen/.

import { spawn, execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

// .claude/models.json and the agents' files. An agent is a Claude Code agent
// file (.claude/agents/<role>.md): native front matter (`name`, `description`,
// `maxTurns`) plus `allow` and `deny`, the permission rules the script hands to
// claude -p as a settings file. The same file is the only place a role is
// defined. A run that hit its `maxTurns` did not finish.
export function loadModels(root) {
  const models = JSON.parse(readFileSync(path.join(root, ".claude", "models.json"), "utf8"))
  const agents = Object.fromEntries(["researcher", "builder"].map((a) => [a, loadAgent(root, a)]))
  const stepCap = Object.fromEntries(Object.entries(agents).map(([a, v]) => [a, v.steps]))
  return { models, timeouts: models.timeouts_seconds ?? {}, stepCap, agents }
}

export function loadAgent(root, name) {
  const text = readFileSync(path.join(root, ".claude", "agents", `${name}.md`), "utf8")
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) throw new Error(`agent ${name}: missing front matter`)
  const field = (k) => (m[1].match(new RegExp(`^${k}:\\s*(.+)$`, "m")) ?? [])[1]
  const list = (k) => {
    const v = field(k)
    return v ? JSON.parse(v) : []
  }
  return {
    name,
    steps: Number(field("maxTurns") ?? 40),
    allow: list("allow"),
    deny: list("deny"),
    system: m[2].trim(),
  }
}

// The ladder for one item: models.json in order, minus the ones excluded,
// cut to max_models_per_item rungs.
export function ladderFor(models, role, exclude = []) {
  return (models[role] ?? []).filter((m) => !exclude.includes(m)).slice(0, models.max_models_per_item ?? 3)
}

export const short = (m) => String(m).replace(/^[^/]+\//, "")

export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

// Runs a command, captures stdout/stderr to files, kills it after timeoutSeconds.
export function run(cmd, args, { cwd, timeoutSeconds, stdoutFile, stderrFile, env = {}, cleanEnv = false }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv ? env : { ...process.env, ...env },
    })
    let out = "",
      err = ""
    child.stdout.on("data", (d) => {
      out += d
    })
    child.stderr.on("data", (d) => {
      err += d
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutSeconds * 1000)
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (stdoutFile) writeFileSync(stdoutFile, out)
      if (stderrFile) writeFileSync(stderrFile, err)
      resolve({ code, signal, stdout: out, stderr: err, timedOut: signal === "SIGKILL" })
    })
  })
}

// Runs one agent with one model through `claude -p` in the given directory
// and returns its final text, turns, cost, whether it wrote its output once and
// never edited it (oneShot: the shallow research reports), and whether it was
// rate limited. Permissions come from the agent file: default mode (an unlisted
// tool call is denied, never asked) plus its allow and deny rules, written to a
// settings file next to the logs. CLAUDECODE is dropped from the environment
// because a nested claude refuses to start while it is set.
export async function runAgent({ agent, model, prompt, cwd, timeoutSeconds, logPrefix, env }) {
  const settingsFile = `${logPrefix}.settings.json`
  writeFileSync(
    settingsFile,
    JSON.stringify(
      { permissions: { defaultMode: "default", allow: agent.allow, deny: agent.deny } },
      null,
      2,
    ),
  )
  const stripped = { ...process.env }
  delete stripped.CLAUDECODE
  const result = await run(
    "claude",
    [
      "-p",
      prompt,
      "--model",
      model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      String(agent.steps),
      "--permission-mode",
      "default",
      "--settings",
      settingsFile,
      "--system-prompt",
      agent.system,
    ],
    {
      cwd,
      timeoutSeconds,
      stdoutFile: `${logPrefix}.events.jsonl`,
      stderrFile: `${logPrefix}.stderr.txt`,
      env: { ...stripped, ...env },
      cleanEnv: true,
    },
  )
  const texts = []
  let steps = 0,
    writes = 0,
    edits = 0,
    rateLimits = 0,
    cost = null,
    duration_ms = null,
    usage = null,
    subtype = null
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type === "assistant") {
      const blocks = e.message?.content ?? []
      if (blocks.some((b) => b.type === "tool_use")) steps++
      for (const b of blocks) {
        if (b.type === "text" && b.text) texts.push(b.text)
        if (b.type === "tool_use" && b.name === "Write") writes++
        if (b.type === "tool_use" && b.name === "Edit") edits++
      }
    }
    if (
      e.type === "rate_limit_event" ||
      (e.type === "system" && e.subtype === "api_retry" && /rate/i.test(String(e.error ?? "")))
    )
      rateLimits++
    if (e.type === "result") {
      cost = e.total_cost_usd ?? null
      duration_ms = e.duration_ms ?? null
      usage = e.usage ?? null
      subtype = e.subtype ?? null
      if (!texts.length && e.result) texts.push(String(e.result))
    }
  }
  // Rate limited: retries and no work. Reported so the ladder moves on at
  // once instead of burning the timeout on a model that cannot answer.
  const rateLimited = steps === 0 && rateLimits >= 3
  return {
    ...result,
    steps,
    finalText: texts.at(-1) ?? "",
    oneShot: writes === 1 && edits === 0,
    cost,
    duration_ms,
    usage,
    subtype,
    rateLimited,
  }
}

// Runs up to `limit` tasks at a time. `next()` returns a task or null when
// nothing is ready; the loop ends when nothing is ready and nothing is running.
export async function pool(limit, next) {
  const running = new Set()
  for (;;) {
    let task
    while (running.size < limit && (task = next())) {
      const p = task().finally(() => running.delete(p))
      running.add(p)
    }
    if (running.size === 0) return
    await Promise.race(running)
  }
}

// Climbs a ladder: for each model (rung), `onRung(model)` then up to
// `attemptsPerRung` calls of `attempt(model, n)`; an attempt that returns
// "stop" ends the climb (the item is closed, for good or bad), "next" leaves
// the rung at once (a rate-limited model), anything else moves on.
// Researchers use one attempt per rung, builders two.
export async function climb({ ladder, attemptsPerRung = 1, onRung = () => {}, attempt }) {
  for (const model of ladder) {
    onRung(model)
    for (let n = 1; n <= attemptsPerRung; n++) {
      const r = await attempt(model, n)
      if (r === "stop") return
      if (r === "next") break
    }
  }
}
