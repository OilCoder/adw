// Processes and agents: run a command with a timeout, run one OpenCode agent and
// read its events, run tasks in a pool, and climb the model ladder. No state
// files are touched here; codegen.mjs owns .codegen/.

import { spawn, execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

// .opencode/models.json plus the guard that keeps it in step with opencode.json:
// a model the ladder names but the whitelist hides is refused by OpenCode and
// burns an attempt. Also the step caps from the agents' front matter (a run
// that hit its cap did not finish).
export function loadModels(root) {
  const models = JSON.parse(readFileSync(path.join(root, ".opencode", "models.json"), "utf8"))
  const providers = JSON.parse(readFileSync(path.join(root, "opencode.json"), "utf8")).provider ?? {}
  const hidden = [...new Set([...(models.researcher ?? []), ...(models.builder ?? [])])].filter((m) => {
    const [p, id] = m.split("/")
    const w = providers[p]?.whitelist
    return Array.isArray(w) && !w.includes(id)
  })
  if (hidden.length)
    throw new Error(
      `models.json names models that opencode.json does not whitelist: ${hidden.join(", ")}; add them to provider.<id>.whitelist or drop them from the ladder`,
    )
  const stepCap = Object.fromEntries(
    ["researcher", "builder"].map((a) => [
      a,
      Number(
        (readFileSync(path.join(root, ".opencode", "agents", `${a}.md`), "utf8").match(/^steps:\s*(\d+)/m) ??
          [])[1] ?? Infinity,
      ),
    ]),
  )
  return { models, timeouts: models.timeouts_seconds ?? {}, stepCap }
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
export function run(cmd, args, { cwd, timeoutSeconds, stdoutFile, stderrFile, env = {} }) {
  return new Promise((resolve) => {
    // OpenCode resolves its project from $PWD, not from the real cwd; without
    // this override a builder edits the directory the script was started in.
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env, PWD: cwd },
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

// Runs one OpenCode agent with one model and returns its final text, step
// count and whether it wrote its output once and never edited it (oneShot:
// measured on a quarter to a half of research reports; those are the shallow ones).
export async function runAgent({ agent, model, prompt, cwd, timeoutSeconds, logPrefix, env }) {
  const result = await run(
    "opencode",
    ["run", "--format", "json", "--model", model, "--agent", agent, prompt],
    {
      cwd,
      timeoutSeconds,
      stdoutFile: `${logPrefix}.events.jsonl`,
      stderrFile: `${logPrefix}.stderr.txt`,
      env,
    },
  )
  const texts = []
  let steps = 0,
    writes = 0,
    edits = 0
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type === "step_start") steps++
      if (event.type === "text" && event.part?.text) texts.push(event.part.text)
      if (event.type === "tool_use") {
        if (event.part?.tool === "write") writes++
        else if (event.part?.tool === "edit") edits++
      }
    } catch {
      /* not json */
    }
  }
  return { ...result, steps, finalText: texts.at(-1) ?? "", oneShot: writes === 1 && edits === 0 }
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
// "stop" ends the climb (the item is closed, for good or bad), anything else
// moves on. Researchers use one attempt per rung, builders two.
export async function climb({ ladder, attemptsPerRung = 1, onRung = () => {}, attempt }) {
  for (const model of ladder) {
    onRung(model)
    for (let n = 1; n <= attemptsPerRung; n++) {
      if ((await attempt(model, n)) === "stop") return
    }
  }
}
