// Processes and agents: run a command with a timeout, run one agent through
// `codex exec` and read its events, run tasks in a pool, and climb the model
// ladder. No state files are touched here; codegen.mjs owns .codegen/.

import { spawn, execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// .codex/models.json and the agents' files. An agent is .codex/agents/<role>.md:
// front matter (`name`, `description`, `maxSteps`) plus the body, which the
// script hands to `codex exec` as the AGENTS.md of the directory the agent
// works in (Codex reads AGENTS.md at the root of a git repository on its first
// turn; verified 2026-09-14). The same file is the only place a role is
// defined. `maxSteps` is not enforced by Codex (no --max-turns): it is the
// step cap the researcher must stay under to count as DONE; the timeout is the
// only hard cut. A ladder entry is a model or a group of models (an array):
// one rung either way. Builders race a group (every model at once, the gate
// picks the winner); researchers try its members one by one.
export const flat = (ladder) => ladder.flat()
export function loadModels(root) {
  const models = JSON.parse(readFileSync(path.join(root, ".codex", "models.json"), "utf8"))
  const agents = Object.fromEntries(["researcher", "builder"].map((a) => [a, loadAgent(root, a)]))
  const stepCap = Object.fromEntries(Object.entries(agents).map(([a, v]) => [a, v.steps]))
  return { models, timeouts: models.timeouts_seconds ?? {}, stepCap, agents }
}

export function loadAgent(root, name) {
  const text = readFileSync(path.join(root, ".codex", "agents", `${name}.md`), "utf8")
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) throw new Error(`agent ${name}: missing front matter`)
  const field = (k) => (m[1].match(new RegExp(`^${k}:\\s*(.+)$`, "m")) ?? [])[1]
  return {
    name,
    steps: Number(field("maxSteps") ?? 40),
    // Researchers get Codex's native web search; builders do not.
    search: field("search") === "true",
    system: m[2].trim(),
  }
}

// The agents' own CODEX_HOME: `codex exec` records every directory it runs in
// as a trusted project in $CODEX_HOME/config.toml (verified 2026-09-14, even
// with --ignore-user-config), and each attempt runs in a new sandbox or den.
// So the agents get a private home next to the sandboxes, with the user's
// auth.json linked in (the token is the only thing they need from ~/.codex);
// state, logs and trust entries land there and the user's config stays clean.
export function agentHome(sandboxes) {
  const home = path.join(sandboxes, "_codex-home")
  mkdirSync(home, { recursive: true })
  const auth = path.join(home, "auth.json")
  const real = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "auth.json")
  if (!existsSync(auth) && existsSync(real)) symlinkSync(real, auth)
  return home
}

// API-equivalent price of one call, in the unit models.json declares
// (`prices` per million tokens: input, cached, output; credits on the Codex
// pricing page). Null when the model has no price listed: the board then
// shows a dash instead of a guess.
export function priceOf(models, model, usage) {
  const p = models.prices?.[String(model).replace(/^[^/]+\//, "")]
  if (!p || !usage) return null
  const cached = usage.cached_input_tokens ?? 0
  const input = Math.max(0, (usage.input_tokens ?? 0) - cached)
  return (input * (p.input ?? 0) + cached * (p.cached ?? 0) + (usage.output_tokens ?? 0) * (p.output ?? 0)) / 1e6
}

// The ladder for one item: models.json in order, minus the ones excluded
// (inside a group too; an emptied group is no rung), cut to
// max_models_per_item rungs.
export function ladderFor(models, role, exclude = []) {
  return (models[role] ?? [])
    .map((m) => (Array.isArray(m) ? m.filter((x) => !exclude.includes(x)) : m))
    .filter((m) => (Array.isArray(m) ? m.length > 0 : !exclude.includes(m)))
    .slice(0, models.max_models_per_item ?? 3)
}

export const short = (m) => (Array.isArray(m) ? m.map(short).join(" | ") : String(m).replace(/^[^/]+\//, ""))

export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

// Runs a command, captures stdout/stderr to files, kills it after
// timeoutSeconds, or after silenceSeconds without a first byte of stdout (a
// model that never starts), or when `signal` aborts (a race lost).
export function run(
  cmd,
  args,
  { cwd, timeoutSeconds, silenceSeconds, signal, stdoutFile, stderrFile, env = {}, cleanEnv = false },
) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv ? env : { ...process.env, ...env },
    })
    let out = "",
      err = "",
      why = null
    const kill = (reason) => {
      why ??= reason
      child.kill("SIGKILL")
    }
    const silence = silenceSeconds ? setTimeout(() => kill("silent"), silenceSeconds * 1000) : null
    child.stdout.on("data", (d) => {
      if (silence) clearTimeout(silence)
      out += d
    })
    child.stderr.on("data", (d) => {
      err += d
    })
    const timer = setTimeout(() => kill("timeout"), timeoutSeconds * 1000)
    const onAbort = () => kill("aborted")
    signal?.addEventListener("abort", onAbort, { once: true })
    child.on("close", (code, sig) => {
      clearTimeout(timer)
      if (silence) clearTimeout(silence)
      signal?.removeEventListener("abort", onAbort)
      if (stdoutFile) writeFileSync(stdoutFile, out)
      if (stderrFile) writeFileSync(stderrFile, err)
      resolve({
        code,
        signal: sig,
        stdout: out,
        stderr: err,
        timedOut: why === "timeout",
        silent: why === "silent",
        aborted: why === "aborted",
      })
    })
  })
}

// Runs one agent with one model through `codex exec` in the given directory
// and returns its final text, steps, cost, whether it wrote its output once and
// never edited it (oneShot: the shallow research reports), and whether it was
// rate limited. The agent's body becomes the AGENTS.md of that directory
// (written here if absent: the sandbox already carries it in its base commit,
// the researcher's den does not). Codex runs with the user's config and rules
// ignored, in its workspace-write sandbox (cwd and the temp dirs writable,
// .git protected, no network), approvals never: a blocked action returns an
// error to the model, nothing asks. Sessions are ephemeral; `home` is the
// agents' private CODEX_HOME (agentHome).
export async function runAgent({
  agent,
  model,
  models,
  prompt,
  cwd,
  home,
  timeoutSeconds,
  silenceSeconds,
  signal,
  logPrefix,
  env,
}) {
  const agentsFile = path.join(cwd, "AGENTS.md")
  try {
    readFileSync(agentsFile)
  } catch {
    writeFileSync(agentsFile, agent.system + "\n")
  }
  const lastFile = `${logPrefix}.last.txt`
  const started = Date.now()
  const result = await run(
    "codex",
    [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-c",
      "approval_policy=never",
      "-c",
      `web_search=${agent.search ? "live" : "disabled"}`,
      "--model",
      model,
      "--cd",
      cwd,
      "--output-last-message",
      lastFile,
      prompt,
    ],
    {
      cwd,
      timeoutSeconds,
      silenceSeconds,
      signal,
      stdoutFile: `${logPrefix}.events.jsonl`,
      stderrFile: `${logPrefix}.stderr.txt`,
      env: { ...(home ? { CODEX_HOME: home } : {}), ...env },
    },
  )
  const texts = []
  let steps = 0,
    writes = 0,
    edits = 0,
    usage = null,
    failure = null
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type === "item.completed") {
      const it = e.item ?? {}
      if (["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(it.type)) steps++
      if (it.type === "agent_message" && it.text) texts.push(it.text)
      if (it.type === "file_change")
        for (const c of it.changes ?? []) {
          if (c.kind === "add") writes++
          else edits++
        }
    }
    if (e.type === "turn.completed") usage = e.usage ?? usage
    if (e.type === "turn.failed" || e.type === "error")
      failure = String(e.error?.message ?? e.message ?? JSON.stringify(e))
  }
  // Rate limited: the turn failed on a usage or rate limit before any work.
  // Reported so the ladder moves on at once instead of burning the timeout on
  // a model that cannot answer.
  const rateLimited = steps === 0 && failure != null && /rate.?limit|usage limit|too many requests|429|quota/i.test(failure)
  return {
    ...result,
    steps,
    finalText: texts.at(-1) ?? "",
    oneShot: writes === 1 && edits === 0,
    cost: priceOf(models, model, usage),
    duration_ms: Date.now() - started,
    usage,
    subtype: failure ? "error" : "success",
    rateLimited,
    failure,
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

// Climbs a ladder: for each rung (a model, or a group of models as an array),
// `onRung(rung)` then up to `attemptsPerRung` calls of `attempt(rung, n)` (one
// for a group); an attempt that returns "stop" ends the climb (the item is
// closed, for good or bad), "next" leaves the rung at once (a model that never
// answered or is rate limited), anything else moves on. Researchers use one
// attempt per rung, builders two.
export async function climb({ ladder, attemptsPerRung = 1, onRung = () => {}, attempt }) {
  for (const rung of ladder) {
    onRung(rung)
    const tries = Array.isArray(rung) ? 1 : attemptsPerRung
    for (let n = 1; n <= tries; n++) {
      const r = await attempt(rung, n)
      if (r === "stop") return
      if (r === "next") break
    }
  }
}
