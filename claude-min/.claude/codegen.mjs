// Minimal code-generation loop on Claude Code.
// Minimal code-generation loop for OpenCode.
//
//   node .claude/codegen.mjs research [--only q1,q2] [--reject q3,q4]
//   node .claude/codegen.mjs build [--parallel N (default 4)] [--only c1,c2] [--resume]
//   research and build run in the foreground; the supervisor's Bash tool
//   backgrounds them and wakes the session when they exit.
//   node .claude/codegen.mjs status
//   node .claude/codegen.mjs structure          lists tracked files that break .codegen/structure.md
//   node .claude/codegen.mjs merge [--partial]     fast-forward the run's integration branch into the user's branch
//   node .claude/codegen.mjs board [--watch]     writes .codegen/board.html (also written on every state change)
//
// State lives in .codegen/ inside the project:
//   research/questions.json   [{id, question, context?}]      written by the supervisor
//   research/<id>.md          report                          written by a researcher
//   structure.md              the map: folders, domains, naming; required before build
//   plan.json                 {contracts: [{id, title, depends_on: []}]}
//   contracts/<id>/contract.json  {objective, read, allowed_to_modify, protected, requirements, gate}
//   contracts/<id>/gate.sh    the check the script trusts
//   runs/<run>/               logs, attempts, report.json
//   ../.<project>-codegen-sandboxes/<id>/  one fresh repo per contract while it builds
//
// Models come from .claude/models.json, cheapest first, edited by hand: if a
// model keeps failing you, move it down there.

import { spawn, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync, copyFileSync } from "node:fs"
import path from "node:path"

import { pathToFileURL } from "node:url"
import { statSync } from "node:fs"

// node:sqlite (used by the board) is still flagged experimental in Node 22.
process.removeAllListeners("warning")
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.warn(w) })

const ROOT = process.cwd()
const STATE = path.join(ROOT, ".codegen")
// Each contract builds in a sandbox next to the repository: an export of the
// integration branch with its own fresh git history, so the builder sees an
// independent project and nothing the builder does can reach the user's tree.
const SANDBOXES = path.join(path.dirname(ROOT), `.${path.basename(ROOT)}-codegen-sandboxes`)
const MODELS = JSON.parse(readFileSync(path.join(ROOT, ".claude", "models.json"), "utf8"))
// Agents are Claude Code agent files (.claude/agents/*.md): native front
// matter (`name`, `description`, `maxTurns`) plus `allow` and `deny`, the
// permission rules the script hands to claude -p as a settings file. The
// same file is the only place a role is defined.
function loadAgent(name) {
  const text = readFileSync(path.join(ROOT, ".claude", "agents", `${name}.md`), "utf8")
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) throw new Error(`agent ${name}: missing front matter`)
  const field = (k) => (m[1].match(new RegExp(`^${k}:\\s*(.+)$`, "m")) ?? [])[1]
  const list = (k) => { const v = field(k); return v ? JSON.parse(v) : [] }
  return { name, steps: Number(field("maxTurns") ?? 40), allow: list("allow"), deny: list("deny"), system: m[2].trim() }
}
const AGENTS = Object.fromEntries(["researcher", "builder"].map((a) => [a, loadAgent(a)]))
// A run that hit its step cap did not finish.
const STEP_CAP = Object.fromEntries(Object.entries(AGENTS).map(([a, v]) => [a, v.steps]))
const TIMEOUTS = MODELS.timeouts_seconds ?? {}

// ---------- helpers ----------

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) { args[key] = next; i++ } else args[key] = true
    } else args._.push(a)
  }
  return args
}

function readJson(file, fallback) {
  if (!existsSync(file)) {
    if (fallback !== undefined) return fallback
    throw new Error(`missing ${path.relative(ROOT, file)}`)
  }
  return JSON.parse(readFileSync(file, "utf8"))
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n")
}

function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
}

let LOG_FILE = null
function log(line) {
  const text = `${new Date().toISOString().slice(11, 19)} ${line}`
  console.log(text)
  if (LOG_FILE) appendFileSync(LOG_FILE, text + "\n")
}

// Runs a command, captures stdout/stderr to files, kills it after timeoutSeconds.
function run(cmd, args, { cwd, timeoutSeconds, stdoutFile, stderrFile, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } })
    let out = "", err = ""
    child.stdout.on("data", (d) => { out += d })
    child.stderr.on("data", (d) => { err += d })
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
// and returns its final text, turns, cost and whether it was rate limited.
// Permissions come from the agent file: default mode (an unlisted tool call
// is denied, never asked) plus its allow and deny rules, written to a
// settings file next to the logs. CLAUDECODE is dropped from the environment
// because a nested claude refuses to start while it is set.
async function runAgent({ agent, model, prompt, cwd, timeoutSeconds, logPrefix, env }) {
  const a = AGENTS[agent]
  const settingsFile = `${logPrefix}.settings.json`
  writeJson(settingsFile, { permissions: { defaultMode: "default", allow: a.allow, deny: a.deny } })
  const childEnv = { ...env }; const stripped = { ...process.env }; delete stripped.CLAUDECODE
  const result = await new Promise((resolve) => {
    const args = ["-p", prompt, "--model", model, "--output-format", "stream-json", "--verbose", "--max-turns", String(a.steps), "--permission-mode", "default", "--settings", settingsFile, "--system-prompt", a.system]
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...stripped, ...childEnv } })
    let out = "", err = ""
    child.stdout.on("data", (d) => { out += d })
    child.stderr.on("data", (d) => { err += d })
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutSeconds * 1000)
    child.on("close", (code, signal) => { clearTimeout(timer); writeFileSync(`${logPrefix}.events.jsonl`, out); writeFileSync(`${logPrefix}.stderr.txt`, err); resolve({ code, signal, stdout: out, stderr: err, timedOut: signal === "SIGKILL" }) })
  })
  const texts = []
  let steps = 0, rateLimits = 0, cost = null, duration_ms = null, usage = null, subtype = null
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.type === "assistant") {
      const blocks = e.message?.content ?? []
      if (blocks.some((b) => b.type === "tool_use")) steps++
      for (const b of blocks) if (b.type === "text" && b.text) texts.push(b.text)
    }
    if (e.type === "rate_limit_event" || (e.type === "system" && e.subtype === "api_retry" && /rate/i.test(String(e.error ?? "")))) rateLimits++
    if (e.type === "result") { cost = e.total_cost_usd ?? null; duration_ms = e.duration_ms ?? null; usage = e.usage ?? null; subtype = e.subtype ?? null; if (!texts.length && e.result) texts.push(String(e.result)) }
  }
  // Rate limited: retries and no work. Reported so the ladder moves on at
  // once instead of burning the timeout on a model that cannot answer.
  const rateLimited = steps === 0 && rateLimits >= 3
  return { ...result, steps, finalText: texts.at(-1) ?? "", cost, duration_ms, usage, subtype, rateLimited }
}

// Runs up to `limit` tasks at a time. `next()` returns a task or null when
// nothing is ready; the loop ends when nothing is ready and nothing is running.
async function pool(limit, next) {
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

// Files whose path matches an entry: exact path, `dir/**`, or `*.ext`.
function matches(file, pattern) {
  if (pattern.endsWith("/**")) return file === pattern.slice(0, -3) || file.startsWith(pattern.slice(0, -2))
  if (pattern.startsWith("*.")) return file.endsWith(pattern.slice(1))
  return file === pattern
}

// News for the supervisor. The supervisor is the Claude Code session that
// launched this command: its Bash tool wakes it when the process exits, so
// the news only needs to be in the output and the journal.
function notify(text) {
  journal({ kind: "notify", text })
  log(`[codegen] ${text}`)
}

// Sandboxes are exports of committed content: the harness and the plan must
// be in git or the builder finds no agent and no contract.
function sealAndCheckTracked() {
  const dirty = git(["status", "--porcelain", "--", ".codegen", ".claude", ".gitignore", ":!.codegen/journal.jsonl"])
  if (dirty) {
    git(["add", ".codegen", ".claude", ".gitignore"])
    git(["commit", "-q", "-m", "codegen: seal plan and harness"])
    journal({ kind: "seal", contracts: readJson(path.join(STATE, "plan.json"), { contracts: [] }).contracts.length })
    log("sealed .codegen and the harness into a commit")
  }
}

// .codegen/journal.jsonl: one line per thing that happened, read by the board.
function journal(event) {
  mkdirSync(STATE, { recursive: true })
  appendFileSync(path.join(STATE, "journal.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n")
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

// .codegen/board.html: the dependency graph and a board by state, rewritten
// on every state change so a browser tab can follow the run.
async function writeBoard() {
  // board.mjs is imported fresh whenever it changes on disk, so a build that
  // runs for hours picks up a new board without a restart.
  const boardFile = path.join(ROOT, ".claude", "board.mjs")
  let renderBoard
  let boardJson
  try { ({ renderBoard, boardJson } = await import(`${pathToFileURL(boardFile).href}?v=${statSync(boardFile).mtimeMs}`)) } catch (e) { console.error(`board: ${e.message}`); return null }
  const plan = readJson(path.join(STATE, "plan.json"), { contracts: [] })
  const current = readJson(path.join(STATE, "runs", "current.json"), null)
  const report = current ? readJson(path.join(STATE, "runs", current.run, "report.json"), null) : null
  const research = readJson(path.join(STATE, "research", "status.json"), null)
  const alive = Boolean(current?.pid && pidAlive(current.pid))
  const researchRun = readJson(path.join(STATE, "runs", "current-research.json"), null)
  const researchAlive = Boolean(researchRun?.pid && pidAlive(researchRun.pid))
  const journalFile = path.join(STATE, "journal.jsonl")
  const events = existsSync(journalFile) ? readFileSync(journalFile, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : []
  const file = path.join(STATE, "board.html")
  const args = { root: ROOT, sandboxes: SANDBOXES, plan, report, current, research, alive, researchRun, researchAlive, events, models: MODELS, ladders: { builder: ladderFor("builder"), researcher: ladderFor("researcher") } }
  writeFileSync(file, renderBoard(args))
  // board.json next to the HTML: same facts, for project-garden and scripts.
  // "merged" asks git whether the integration branch is already in the user's branch.
  // Only meaningful once something landed on the integration branch: a fresh
  // branch is trivially an ancestor of the user's branch.
  let merged = null
  const landed = Object.values(report?.contracts ?? {}).some((c) => c.status === "PASS")
  if (landed && current?.integration && current?.user_branch) { try { execFileSync("git", ["merge-base", "--is-ancestor", current.integration, current.user_branch], { cwd: ROOT, stdio: "ignore" }); merged = true } catch { merged = false } }
  if (boardJson) writeJson(path.join(STATE, "board.json"), boardJson({ ...args, merged }))
  return file
}

// ---------- model ladder ----------

// The ladder for one item: models.json in order, minus the ones excluded,
// cut to max_models_per_item rungs.
function ladderFor(role, exclude = []) {
  return (MODELS[role] ?? []).filter((m) => !exclude.includes(m)).slice(0, MODELS.max_models_per_item ?? 3)
}
const short = (m) => String(m).replace(/^[^/]+\//, "")

// ---------- research ----------

async function research(args) {
  const questions = readJson(path.join(STATE, "research", "questions.json"))
  const statusFile = path.join(STATE, "research", "status.json")
  const previous = readJson(statusFile, { results: {} }).results
  const running = readJson(path.join(STATE, "runs", "current-research.json"), null)
  if (running?.pid && pidAlive(running.pid)) throw new Error(`research ${running.run} is still running (pid ${running.pid}); wait for it or kill it first`)
  const reject = args.reject ? String(args.reject).split(",") : []
  for (const id of reject) {
    const r = previous[id]
    if (!r?.model) throw new Error(`cannot reject ${id}: no report recorded`)
    if (r.status === "PARTIAL" || (r.rejected?.length ?? 0) >= 2) throw new Error(`cannot reject ${id}: ${r.status === "PARTIAL" ? "it is PARTIAL" : "already rejected twice"}; the question is too big for one sitting. Split it into new ids by what is missing and run those.`)
  }
  const only = args.only ? String(args.only).split(",") : reject.length ? reject : null
  const selected = questions.filter((q) => !only || only.includes(q.id))
  if (selected.length === 0) throw new Error("no questions selected")
  // --reject: the supervisor judged these reports useless. Their model counts
  // as failed for the question, the report is set aside, and the question
  // reruns starting at the next rung.
  for (const id of reject) {
    const r = previous[id]
    const file = path.join(STATE, "research", `${id}.md`)
    if (existsSync(file)) { let n = (r.rejected?.length ?? 0) + 1; while (existsSync(path.join(STATE, "research", `${id}.rejected-${n}.md`))) n++; execFileSync("mv", [file, path.join(STATE, "research", `${id}.rejected-${n}.md`)]) }
    previous[id] = { ...r, status: "REJECTED", report: null, rejected: [...new Set([...(r.rejected ?? []), r.model])] }
    journal({ kind: "reject", id, model: r.model })
  }
  if (reject.length) writeJson(statusFile, { run: readJson(statusFile, {}).run ?? null, results: previous })
  const runId = `${stamp()}-research`
  const runDir = path.join(STATE, "runs", runId)
  mkdirSync(runDir, { recursive: true })
  LOG_FILE = path.join(runDir, "log.txt")
  const results = {}
  writeJson(path.join(STATE, "runs", "current-research.json"), { run: runId, pid: process.pid, started: new Date().toISOString(), questions: selected.map((q) => q.id) })
  journal({ kind: "research-start", run: runId, questions: selected.map((q) => ({ id: q.id, question: q.question })) })
  writeBoard()

  log(`research ${runId}: ${selected.length} questions, ladder ${ladderFor("researcher").map(short).join(" > ")}${reject.length ? ` (questions skip models that already failed them)` : ""}`)
  const queue = [...selected]
  await pool(selected.length, () => {
    const q = queue.shift()
    if (!q) return null
    return async () => {
      const output = path.join("research", `${q.id}.md`)
      const outputAbs = path.join(STATE, output)
      let attempt = 0
      const rejected = previous[q.id]?.rejected ?? []
      const exhausted = [...rejected]
      for (const model of ladderFor("researcher", rejected)) {
        attempt++
        log(`  ${q.id}: attempt ${attempt} with ${model}`)
        // The researcher works in an empty directory of its own: it can write
        // anything there and nothing else; the report is copied back.
        const den = path.join(runDir, `${q.id}.${attempt}.work`)
        rmSync(den, { recursive: true, force: true }); mkdirSync(den, { recursive: true })
        const prompt = [
          `Research question ${q.id}: ${q.question}`,
          q.context ? `Context: ${q.context}` : "",
          `Write the report to ./report.md in the current directory.`,
        ].filter(Boolean).join("\n")
        const r = await runAgent({
          agent: "researcher", model, prompt, cwd: den,
          timeoutSeconds: TIMEOUTS.researcher ?? 600, logPrefix: path.join(runDir, `${q.id}.${attempt}`),
        })
        const draft = path.join(den, "report.md")
        if (existsSync(draft) && readFileSync(draft, "utf8").trim().length > 200) { mkdirSync(path.dirname(outputAbs), { recursive: true }); copyFileSync(draft, outputAbs) }
        const text = existsSync(outputAbs) && existsSync(draft) ? readFileSync(outputAbs, "utf8") : ""
        const written = text.trim().length > 200
        // DONE only when the model closed with it, in time, within its step cap
        // and with the summary the supervisor reads; anything else with a file
        // is PARTIAL, for the supervisor to accept or split.
        const closed = !r.timedOut && r.steps < STEP_CAP.researcher && /^## Summary for contracts/m.test(text) && /^DONE\b/.test(r.finalText.trim().split("\n").at(-1))
        const status = written ? (closed ? "DONE" : "PARTIAL") : (r.rateLimited ? "RATE_LIMITED" : r.timedOut ? "TIMEOUT" : "NO_REPORT")
        results[q.id] = { status, model, attempt, steps: r.steps, cost: r.cost, duration_ms: r.duration_ms, report: written ? `.codegen/${output}` : null, final: r.finalText.slice(-400), run: runId, at: new Date().toISOString(), rejected: exhausted }
        log(`  ${q.id}: ${status} (${r.steps} steps)`)
        if (written) break
        exhausted.push(model)
      }
      // Models that failed without a report stay skipped for this question in later runs.
      results[q.id] ??= { status: "NO_MODELS", model: null, attempt: 0, steps: 0, report: null, final: "", run: runId, at: new Date().toISOString(), rejected: exhausted }
      if (results[q.id].status !== "DONE" && results[q.id].status !== "PARTIAL") { results[q.id].rejected = exhausted; log(`  ${q.id}: ${results[q.id].status}${exhausted.length ? ` (tried ${exhausted.map(short).join(", ")})` : ""}`) }
      const res = results[q.id]
      journal({ kind: "research", id: q.id, question: q.question, status: res.status, model: res.model, models: res.report ? exhausted.concat([res.model]) : exhausted, steps: res.steps, report: res.report })
      if (res.status !== "DONE") notify(`research ${q.id}: ${res.status} with ${short(res.model) ?? "no model"}${res.report ? `, report at ${res.report}` : ", no report"}${res.final ? `. Last words: ${res.final.replace(/\s+/g, " ").trim().slice(-160)}` : ""}. Accept it or split it into new ids; the other questions keep running.`)
      writeBoard()
    }
  })
  writeJson(path.join(runDir, "report.json"), { run: runId, results })
  writeJson(statusFile, { run: runId, results: { ...previous, ...results } })
  writeJson(path.join(STATE, "runs", "current-research.json"), { run: runId, pid: null, finished: new Date().toISOString() })
  writeBoard()
  const tally = Object.values(results).reduce((t, r) => ((t[r.status] = (t[r.status] ?? 0) + 1), t), {})
  notify(`research run ended: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ")}${Object.entries(results).filter(([, r]) => r.status !== "DONE").length ? `; not DONE: ${Object.entries(results).filter(([, r]) => r.status !== "DONE").map(([id, r]) => `${id} (${r.status})`).join(", ")}` : ""}. Judge the new reports and continue.`)
  printResearch(results)
}

function printResearch(results) {
  console.log("\nResearch summary")
  for (const [id, r] of Object.entries(results)) {
    console.log(`  ${r.status.padEnd(9)} ${id}  ${r.report ?? "(no report)"}  [${short(r.model)}]${r.rejected?.length ? `  skipped: ${r.rejected.map(short).join(", ")}` : ""}`)
    if (r.status === "PARTIAL" && r.final) console.log(`            last words: ${r.final.replace(/\s+/g, " ").trim().slice(-300)}`)
  }
}

// ---------- build ----------

function loadPlan(only) {
  const plan = readJson(path.join(STATE, "plan.json"))
  const map = loadStructure()
  if (!map) throw new Error("plan: write .codegen/structure.md first (see .claude/rules/structure.md)")
  const ids = new Set()
  for (const c of plan.contracts) {
    if (!c.id || ids.has(c.id)) throw new Error(`plan: duplicate or missing id ${c.id}`)
    ids.add(c.id)
    c.depends_on ??= []
    for (const d of c.depends_on) if (!plan.contracts.some((x) => x.id === d)) throw new Error(`plan: ${c.id} depends on unknown ${d}`)
    const dir = path.join(STATE, "contracts", c.id)
    c.contract = readJson(path.join(dir, "contract.json"))
    if (!existsSync(path.join(dir, "gate.sh"))) throw new Error(`plan: ${c.id} has no gate.sh`)
    if (!Array.isArray(c.contract.allowed_to_modify) || c.contract.allowed_to_modify.length === 0) throw new Error(`plan: ${c.id} has empty allowed_to_modify`)
    const heavy = (c.contract.read ?? []).filter((p) => /\*\*|idea\.md$|\.codegen\/research\//.test(p))
    if (heavy.length || (c.contract.read ?? []).length > 5) throw new Error(`plan: ${c.id} read list is too big for a cheap model (${heavy.join(", ") || `${c.contract.read.length} files`}): at most 5 concrete files, never a glob, the idea or a research report; quote what the builder needs in the contract instead`)
    if (map) for (const p of c.contract.allowed_to_modify) if (!inMap(p.replace(/\/\*\*$/, "/x"), map) && !inMap(p, map)) throw new Error(`plan: ${c.id} allows ${p}, which is outside .codegen/structure.md`)
  }
  return plan
}

function changedFiles(cwd) {
  const tracked = git(["diff", "--name-only", "HEAD", "--"], cwd)
  const untracked = git(["ls-files", "--others", "--exclude-standard"], cwd)
  const junk = /(^|\/)(__pycache__|\.pytest_cache|node_modules|\.venv|\.mypy_cache|\.ruff_cache)\/|\.pyc$|\.egg-info\//
  return [...new Set(`${tracked}\n${untracked}`.split("\n").filter((f) => f && !junk.test(f)))].sort()
}

function checkScope(contract, files) {
  const protectedPatterns = [".codegen/**", ".claude/**", ...(contract.protected ?? [])]
  const outside = files.filter((f) => !contract.allowed_to_modify.some((p) => matches(f, p)))
  const touchedProtected = files.filter((f) => protectedPatterns.some((p) => matches(f, p)))
  return { outside, touchedProtected }
}

// The map: .codegen/structure.md, written by the supervisor. Machine-readable
// part = every bullet that starts with a backticked path under "## Folders"
// ("- `src/core/**`: pure logic", "- `*`: root config files" for top-level
// files) and under "## Repeated names allowed" ("- `index.ts`").
function loadStructure() {
  const file = path.join(STATE, "structure.md")
  if (!existsSync(file)) return null
  const folders = [], repeated = ["index.*", "__init__.py", "mod.rs", "README.md"]
  let section = ""
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const h = line.match(/^##\s+(.*)/); if (h) { section = h[1].trim().toLowerCase(); continue }
    const b = line.match(/^\s*[-*]\s+`([^`]+)`/); if (!b) continue
    if (section.startsWith("folders")) folders.push(b[1])
    else if (section.startsWith("repeated names")) repeated.push(b[1])
  }
  if (!folders.length) throw new Error("structure: .codegen/structure.md has no `path` bullets under ## Folders")
  return { folders, repeated }
}

const inMap = (file, map) => map.folders.some((p) => p === "*" ? !file.includes("/") : matches(file, p) || matches(file, p.replace(/\/\*\*$/, "")))
const PROVISIONAL = /(^|\/)(todo|placeholder|tmp|temp|old|backup|untitled|new)([._-][^/]*)?$|\.(tmp|bak|orig|old|swp|rej)$|~$/i

// Files that break the map: outside every declared folder, provisional, or a
// new file whose name already exists elsewhere (unless the name is conventional).
function checkStructure(map, files, cwd, before = new Set()) {
  if (!map) return []
  const tree = git(["ls-files"], cwd).split("\n").filter(Boolean)
  const byName = {}
  for (const f of tree) (byName[path.basename(f)] ??= []).push(f)
  const problems = []
  for (const f of files) {
    if (!inMap(f, map)) problems.push(`${f}: outside the map`)
    else if (PROVISIONAL.test(f)) problems.push(`${f}: provisional file`)
    else if (!before.has(f)) {
      const name = path.basename(f)
      const twins = (byName[name] ?? []).filter((x) => x !== f)
      if (twins.length && !map.repeated.some((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(name))) problems.push(`${f}: same name as ${twins[0]}`)
    }
  }
  return problems
}

async function runGate(id, cwd, logFile, env) {
  const r = await run("bash", [path.join(".codegen", "contracts", id, "gate.sh")], {
    cwd, timeoutSeconds: TIMEOUTS.gate ?? 300, stdoutFile: logFile, stderrFile: logFile + ".stderr", env,
  })
  return { pass: r.code === 0 && !r.timedOut, output: (r.stdout + "\n" + r.stderr).slice(-3000), timedOut: r.timedOut }
}

async function build(args) {
  const only = args.only ? String(args.only).split(",") : null
  const parallel = Number(args.parallel ?? 4)
  const plan = loadPlan(null)
  const live = readJson(path.join(STATE, "runs", "current.json"), null)
  if (live?.pid && pidAlive(live.pid)) throw new Error(`build ${live.run} is still running (pid ${live.pid}); wait for it or kill it first`)
  // --resume continues the current run on its integration branch: contracts
  // that already passed stay passed, and the user's new commits (fixed gates,
  // harness updates) are merged into that branch first.
  const previous = args.resume ? readJson(path.join(STATE, "runs", "current.json"), null) : null
  if (args.resume && !previous) throw new Error("nothing to resume: no current run")
  sealAndCheckTracked()
  const userBranch = git(["rev-parse", "--abbrev-ref", "HEAD"])
  const runId = previous ? previous.run : `${stamp()}-build`
  const runDir = path.join(STATE, "runs", runId)
  mkdirSync(runDir, { recursive: true })
  LOG_FILE = path.join(runDir, "log.txt")
  const integration = previous ? previous.integration : `codegen/${runId}`
  const integrationDir = path.join(SANDBOXES, "_integration")
  rmSync(integrationDir, { recursive: true, force: true })
  mkdirSync(SANDBOXES, { recursive: true })
  if (!previous) git(["branch", integration, "HEAD"])
  git(["clone", "-q", "--branch", integration, ROOT, integrationDir])
  if (previous) {
    git(["fetch", "-q", "origin", userBranch], integrationDir)
    try { git(["merge", "-q", "--no-edit", "-m", `codegen: bring ${userBranch} into ${integration}`, "FETCH_HEAD"], integrationDir) }
    catch (e) { throw new Error(`cannot merge ${userBranch} into ${integration}: ${String(e.stderr ?? e.message).slice(-400)}`) }
    git(["push", "-q", "origin", `${integration}:${integration}`], integrationDir)
    log(`resume ${runId}: merged ${userBranch} into ${integration}`)
  }
  writeJson(path.join(STATE, "runs", "current.json"), { run: runId, integration, user_branch: userBranch, started: new Date().toISOString(), pid: process.pid })
  journal({ kind: previous ? "build-resume" : "build-start", run: runId, integration, contracts: plan.contracts.length, only, parallel })
  log(`build ${runId}: ${plan.contracts.length} contracts, parallel ${parallel}, ladder ${ladderFor("builder").map(short).join(" > ")}${only ? `, only ${only.join(",")}` : ""}`)

  const prevState = previous ? (readJson(path.join(runDir, "report.json"), { contracts: {} }).contracts) : {}
  const state = Object.fromEntries(plan.contracts.map((c) => {
    if (prevState[c.id]?.status === "PASS") return [c.id, prevState[c.id]]
    if (only && !only.includes(c.id)) return [c.id, { status: "NOT_SELECTED" }]
    return [c.id, { status: "PENDING" }]
  }))
  const report = () => { writeJson(path.join(runDir, "report.json"), { run: runId, integration, user_branch: userBranch, contracts: state }); writeBoard() }
  report()
  log(`board: ${path.relative(ROOT, path.join(STATE, "board.html"))}`)

  const next = () => {
    const ready = plan.contracts.find((c) => state[c.id].status === "PENDING" && c.depends_on.every((d) => state[d].status === "PASS"))
    if (ready) {
      state[ready.id] = { status: "RUNNING", started: new Date().toISOString() }
      return () => buildOne(ready, { runDir, integration, integrationDir, state, report }).catch((e) => {
        state[ready.id] = { status: "ERROR", reason: String(e.stack ?? e) }
        log(`  ${ready.id}: ERROR ${e.message}`)
      }).finally(report)
    }
    // Nothing ready: anything still pending whose dependency failed is skipped.
    for (const c of plan.contracts) {
      if (state[c.id].status === "PENDING" && c.depends_on.some((d) => !["PENDING", "RUNNING", "PASS"].includes(state[d].status))) {
        state[c.id] = { status: "SKIPPED", reason: `dependency failed: ${c.depends_on.filter((d) => state[d].status !== "PASS").join(", ")}` }
      }
    }
    return null
  }
  await pool(parallel, next)

  rmSync(integrationDir, { recursive: true, force: true })
  const cur = readJson(path.join(STATE, "runs", "current.json"), {}); writeJson(path.join(STATE, "runs", "current.json"), { ...cur, finished: new Date().toISOString(), pid: null })
  journal({ kind: "build-end", run: runId, passed: Object.values(state).filter((c) => c.status === "PASS").length, total: Object.keys(state).length })
  const allPassed = Object.values(state).every((c) => c.status === "PASS")
  notify(`build ended: ${buildLine(state)}. ${allPassed ? "Tell the user it is ready to merge." : "Diagnose the failed ones, fix their contracts or gates, then build --resume."}`)
  const touched = git(["status", "--porcelain", "--", ".", ":!.codegen"])
  if (touched) log(`WARNING: the user's working tree changed during the build:\n${touched}`)
  report()
  printBuild({ run: runId, integration, user_branch: userBranch, contracts: state })
}

async function buildOne(entry, { runDir, integration, integrationDir, state, report }) {
  const { id, contract } = entry
  const wt = path.join(SANDBOXES, id)
  const branch = `${integration}-${id}`
  const logs = path.join(runDir, id)
  mkdirSync(logs, { recursive: true })
  rmSync(wt, { recursive: true, force: true })
  mkdirSync(wt, { recursive: true })
  // Export the current integration branch and give the sandbox its own history.
  const integrationHead = git(["rev-parse", integration])
  execFileSync("bash", ["-c", `git -C "${ROOT}" archive ${integrationHead} | tar -x -C "${wt}"`], { stdio: ["ignore", "ignore", "pipe"] })
  // The sandbox is the builder's project: the supervisor's CLAUDE.md, rules
  // and settings must not load into it (they would forbid editing src/ and
  // hand the builder the wrong role). The builder's role and permissions
  // travel with the claude -p call instead.
  rmSync(path.join(wt, ".claude"), { recursive: true, force: true }); rmSync(path.join(wt, "CLAUDE.md"), { force: true })
  git(["init", "-q"], wt)
  git(["add", "-A"], wt)
  git(["-c", "user.name=codegen", "-c", "user.email=codegen@localhost", "commit", "-q", "--allow-empty", "-m", `sandbox ${id} from ${integrationHead}`], wt)
  const base = git(["rev-parse", "HEAD"], wt)

  // Dependencies are not in git: install them before the baseline gate so a
  // missing node_modules never masquerades as a legitimate gate failure.
  let env
  if (existsSync(path.join(wt, "package-lock.json"))) {
    const install = await run("npm", ["ci", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: wt, timeoutSeconds: TIMEOUTS.install ?? 600, stdoutFile: path.join(logs, "npm-ci.txt"), stderrFile: path.join(logs, "npm-ci.stderr.txt") })
    if (install.code !== 0) { state[id] = { status: "INSTALL_FAILED", reason: install.stderr.slice(-800) }; log(`  ${id}: INSTALL_FAILED`); return }
  }
  // Python: a venv per sandbox with uv (system python has no pytest), so
  // `python3` in the gate and in the builder resolves to it.
  const pyproject = existsSync(path.join(wt, "pyproject.toml")), reqs = existsSync(path.join(wt, "requirements.txt"))
  if (pyproject || reqs) {
    const uvLog = { cwd: wt, timeoutSeconds: TIMEOUTS.install ?? 600, stdoutFile: path.join(logs, "uv.txt"), stderrFile: path.join(logs, "uv.stderr.txt") }
    const steps = [["venv", ".venv"], pyproject ? ["pip", "install", "-e", ".[dev]"] : ["pip", "install", "-r", "requirements.txt"], ["pip", "install", "pytest"]]
    for (const args of steps) {
      let r = await run("uv", args, uvLog)
      if (r.code !== 0 && args[3] === ".[dev]") r = await run("uv", ["pip", "install", "-e", "."], uvLog)
      if (r.code !== 0) { state[id] = { status: "INSTALL_FAILED", reason: `uv ${args.join(" ")}: ${r.stderr.slice(-800)}` }; log(`  ${id}: INSTALL_FAILED (uv ${args.join(" ")})`); return }
    }
    env = { VIRTUAL_ENV: path.join(wt, ".venv"), PATH: `${path.join(wt, ".venv", "bin")}:${process.env.PATH}` }
  }

  // The gate must fail before anyone builds; otherwise it proves nothing.
  const baseline = await runGate(id, wt, path.join(logs, "gate-baseline.txt"), env)
  if (baseline.pass) {
    state[id] = { status: "GATE_TRIVIAL", reason: "gate passes on the untouched repository" }
    journal({ kind: "contract", id, status: "GATE_TRIVIAL", title: entry.title, objective: contract.objective, attempts: 0 })
    log(`  ${id}: GATE_TRIVIAL`)
    rmSync(wt, { recursive: true, force: true })
    return
  }

  const attempts = []
  let evidence = "", structure = [], broken = false
  const map = loadStructure()
  // A gate that only reports errors in files the builder may not touch (its
  // own test file, another domain, missing types elsewhere) cannot be fixed
  // by any builder: stop at the first attempt and hand it to the supervisor.
  const gateBroken = (out) => {
    // (a) the gate's own test file does not parse or compile;
    // (b) a type checker reports errors, and every one is in a file outside scope.
    if (/\.codegen\/\S+:\d+(?::\d+)?:? *(?:ERROR|error|SyntaxError)/.test(out) || /Transform failed[\s\S]{0,300}\.codegen\//.test(out)) return true
    const ts = [...new Set([...out.matchAll(/(?:^|[\s'"(])(\/?(?:\.?[\w.@-]+\/)*[\w.@-]+\.[a-zA-Z]{1,5})\(\d+,\d+\): error TS\d+/gm)].map((m) => m[1]))]
      .map((f) => f.startsWith(wt + "/") ? f.slice(wt.length + 1) : f.replace(/^\.\//, ""))
    return ts.length > 0 && ts.every((f) => !contract.allowed_to_modify.some((p) => matches(f, p)))
  }
  const baseFiles = new Set(git(["ls-files"], wt).split("\n"))
  outer: for (const model of ladderFor("builder")) {
    git(["reset", "-q", "--hard", base], wt); git(["clean", "-qfd"], wt)
    for (let n = 1; n <= 2; n++) {
      const attempt = attempts.length + 1
      Object.assign(state[id], { model, attempt }); report()
      log(`  ${id}: attempt ${attempt} with ${model}`)
      const prompt = [
        `Execute the contract at .codegen/contracts/${id}/contract.json. Its gate is bash .codegen/contracts/${id}/gate.sh.`,
        "Read .codegen/structure.md first: every file you create or move must fit that map and the naming convention it fixes.",
        evidence ? `Previous attempt failed the independent gate. Evidence:\n${evidence}` : "",
        "Implement it now and finish with the four status lines.",
      ].filter(Boolean).join("\n\n")
      const r = await runAgent({ agent: "builder", model, prompt, cwd: wt, timeoutSeconds: TIMEOUTS.builder ?? 900, logPrefix: path.join(logs, `attempt-${attempt}`), env })
      const files = changedFiles(wt)
      const scope = checkScope(contract, files)
      let verdict, detail
      if (scope.touchedProtected.length) { verdict = "PROTECTED_TOUCHED"; detail = scope.touchedProtected.join(", ") }
      else if (scope.outside.length) { verdict = "OUT_OF_SCOPE"; detail = scope.outside.join(", ") }
      else if ((structure = checkStructure(map, files, wt, baseFiles)).length) { verdict = "STRUCTURE"; detail = structure.join("\n") }
      else if (files.length === 0) { verdict = r.rateLimited ? "RATE_LIMITED" : r.timedOut ? "TIMEOUT" : "NO_CHANGES"; detail = r.finalText.slice(0, 500) }
      else {
        const gate = await runGate(id, wt, path.join(logs, `gate-${attempt}.txt`), env)
        verdict = gate.pass ? "PASS" : "GATE_FAIL"
        detail = gate.pass ? "" : gate.output
      }
      attempts.push({ attempt, model, verdict, steps: r.steps, cost: r.cost, duration_ms: r.duration_ms, files, detail: detail.slice(-1500) })
      log(`  ${id}: ${verdict} (${r.steps} steps, ${files.length} files${r.cost != null ? `, $${r.cost.toFixed(3)}` : ""})`)
      if (verdict === "PASS") break outer
      if (verdict === "RATE_LIMITED") { log(`  ${id}: ${short(model)} is rate limited, next model`); break }
      if (verdict === "GATE_FAIL" && gateBroken(detail)) { broken = true; log(`  ${id}: the gate fails only in files outside the contract's scope; no builder can fix that, stopping`); break outer }
      evidence = `${verdict}: ${detail}`.slice(-3000)
      if (verdict === "PROTECTED_TOUCHED" || verdict === "OUT_OF_SCOPE" || verdict === "STRUCTURE") { git(["reset", "-q", "--hard", base], wt); git(["clean", "-qfd"], wt) }
    }
  }

  const last = attempts.at(-1)
  if (last?.verdict === "PASS") {
    // Take the sandbox diff and land it on a contract branch cut from the
    // integration base this sandbox started from, then merge. All git calls
    // here are synchronous, so parallel contracts land one after another.
    git(["add", "-A"], wt)
    const patch = path.join(logs, "candidate.diff")
    writeFileSync(patch, execFileSync("git", ["diff", "--cached", "--binary", base], { cwd: wt }))
    try {
      git(["checkout", "-q", "-B", branch, integrationHead], integrationDir)
      git(["apply", "--index", patch], integrationDir)
      git(["commit", "-q", "-m", `codegen(${id}): ${contract.objective ?? entry.title ?? id}\n\nmodel: ${last.model}`], integrationDir)
      git(["checkout", "-q", integration], integrationDir)
      git(["merge", "-q", "--no-edit", "-m", `codegen: merge ${id}`, branch], integrationDir)
      git(["push", "-q", "origin", `${integration}:${integration}`], integrationDir)
      git(["branch", "-q", "-D", branch], integrationDir)
      state[id] = { status: "PASS", model: last.model, attempts, files: last.files, duration_ms: Date.now() - new Date(state[id].started ?? Date.now()).getTime() }
      journal({ kind: "contract", id, status: "PASS", title: entry.title, objective: contract.objective, model: last.model, models: [...new Set(attempts.map((a) => a.model))], attempts: attempts.length, files: last.files.length })
      log(`  ${id}: merged into ${integration}`)
    } catch (e) {
      try { git(["merge", "--abort"], integrationDir) } catch {}
      try { git(["checkout", "-q", "-f", integration], integrationDir); git(["push", "-q", "origin", `${branch}:${branch}`], integrationDir) } catch {}
      state[id] = { status: "MERGE_CONFLICT", model: last.model, attempts, reason: String(e.stderr ?? e.message).slice(-800), branch, patch: path.relative(ROOT, patch) }
      journal({ kind: "contract", id, status: "MERGE_CONFLICT", title: entry.title, objective: contract.objective, model: last.model, models: [...new Set(attempts.map((a) => a.model))], attempts: attempts.length })
      log(`  ${id}: MERGE_CONFLICT, see ${path.relative(ROOT, patch)}`)
      rmSync(wt, { recursive: true, force: true })
      return
    }
  } else {
    state[id] = { status: "FAIL", attempts, reason: `${broken ? "GATE BROKEN: it fails only in files outside the contract's scope; fix the gate or the contract, not the builder. " : ""}${last ? `${last.verdict}: ${last.detail.slice(-600)}` : "no attempts"}` }
    journal({ kind: "contract", id, status: "FAIL", title: entry.title, objective: contract.objective, models: [...new Set(attempts.map((a) => a.model))], attempts: attempts.length, verdict: last?.verdict, detail: (last?.detail ?? "").split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 160) })
    log(`  ${id}: FAIL after ${attempts.length} attempts`)
    notify(`contract ${id} FAILED after ${attempts.length} attempts${broken ? " (GATE BROKEN: fails only outside the contract's scope)" : ""}; last verdict ${last?.verdict}: ${(last?.detail ?? "").split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 160) ?? ""}. Build so far: ${buildLine(state)}. The run continues. Diagnose it now (tail .codegen/runs/${path.basename(runDir)}/${id}/gate-${attempts.length}.txt) and leave its contract or gate fixed and committed; launch nothing while the run is alive.`)
    return
  }
  rmSync(wt, { recursive: true, force: true })
}

// One line of build state, the same for status and for the supervisor notices.
function buildLine(contracts) {
  const by = (st) => Object.entries(contracts).filter(([, c]) => c.status === st).map(([id]) => id)
  const failed = Object.entries(contracts).filter(([, c]) => !["PASS", "SKIPPED", "NOT_SELECTED", "PENDING", "RUNNING"].includes(c.status)).map(([id, c]) => `${id} (${c.status})`)
  return `${by("PASS").length}/${Object.keys(contracts).length} PASS` + (by("RUNNING").length ? `; running: ${by("RUNNING").join(", ")}` : "") + (failed.length ? `; failed: ${failed.join(", ")}` : "") + (by("PENDING").length ? `; pending: ${by("PENDING").length}` : "") + (by("SKIPPED").length ? `; skipped: ${by("SKIPPED").length}` : "")
}

function printBuild(r) {
  console.log(`\nBuild ${r.run} on branch ${r.integration}: ${buildLine(r.contracts)}`)
  for (const [id, c] of Object.entries(r.contracts)) {
    const extra = c.status === "RUNNING" ? ` [${short(c.model ?? "?")}, attempt ${c.attempt ?? 1}]` : c.model ? ` [${short(c.model)}, ${c.attempts?.length ?? 0} attempt(s)]` : c.reason ? `  ${String(c.reason).split("\n")[0].slice(0, 120)}` : ""
    console.log(`  ${c.status.padEnd(15)} ${id}${extra}`)
  }
  const passed = Object.values(r.contracts).filter((c) => c.status === "PASS").length
  console.log(`\n${passed}/${Object.keys(r.contracts).length} contracts passed their gate.`)
  if (passed < Object.keys(r.contracts).length) console.log(`Continue this run after fixing contracts with: node .claude/codegen.mjs build --resume [--only ids]`)
  if (passed) console.log(`Land it with: node .claude/codegen.mjs merge${passed < Object.keys(r.contracts).length ? " --partial" : ""}`)
}

// ---------- status ----------

async function status() {
  const current = readJson(path.join(STATE, "runs", "current.json"), null)
  const r = current ? readJson(path.join(STATE, "runs", current.run, "report.json"), null) : null
  if (!current) console.log("no build run yet")
  else if (!r) console.log(`run ${current.run} has no report yet`)
  if (current && r) {
  const alive = Boolean(current.pid && pidAlive(current.pid))
  const board = await writeBoard()
  if (board) console.log(`board: ${path.relative(ROOT, board)}`)
  const running = Object.values(r.contracts).some((c) => c.status === "RUNNING")
  console.log(alive ? `build process ${current.pid} is running` : running ? "build process is NOT running: it was stopped or crashed; contracts marked RUNNING are stale. Relaunch with --only." : "build finished")
  printBuild(r)
  }
  const research = path.join(STATE, "research", "status.json")
  if (existsSync(research)) printResearch(readJson(research).results)
}

// ---------- merge ----------

// Lands the current run's integration branch on the user's branch: a
// fast-forward normally (--resume keeps the integration branch ahead of the
// user's), a merge commit if the user committed meanwhile, never a half-done
// merge on conflict.
async function merge(args) {
  const current = readJson(path.join(STATE, "runs", "current.json"), null)
  if (!current) throw new Error("no run to merge")
  if (current.pid && pidAlive(current.pid)) throw new Error("the build is still running")
  const r = readJson(path.join(STATE, "runs", current.run, "report.json"), null)
  const pending = Object.entries(r?.contracts ?? {}).filter(([, c]) => c.status !== "PASS").map(([id, c]) => `${id} (${c.status})`)
  if (pending.length && !args.partial) throw new Error(`not every contract passed: ${pending.join(", ")}. Fix and --resume, or merge --partial to take what passed.`)
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"])
  if (branch !== current.user_branch) throw new Error(`checkout ${current.user_branch} first (on ${branch})`)
  // The script's own outputs (journal, board) never block a merge: they change on every event.
  if (git(["status", "--porcelain", "--", ".", ":!.codegen/board.html", ":!.codegen/board.json", ":!.codegen/journal.jsonl"])) throw new Error("working tree has uncommitted changes; commit or stash them first")
  const before = git(["rev-parse", "HEAD"])
  let how = "fast-forward"
  try { git(["merge", "--ff-only", current.integration]) }
  catch {
    // The user committed on their branch since the run started: do a real merge.
    how = "merge commit"
    try { git(["merge", "--no-edit", "-m", `codegen: land ${current.run}`, current.integration]) }
    catch (e) {
      try { git(["merge", "--abort"]) } catch {}
      throw new Error(`conflict merging ${current.integration} into ${branch}; nothing changed. Resolve by running build --resume (it merges ${branch} into the integration branch, where conflicts surface per contract) and merge again. (${String(e.stderr ?? e.message).trim().slice(-300)})`)
    }
  }
  const count = git(["rev-list", "--count", `${before}..HEAD`])
  journal({ kind: "merge", run: current.run, branch, how, commits: Number(count), pending: pending.length })
  await writeBoard()
  console.log(`landed ${current.integration} on ${branch} (${how}): ${count} commit(s), ${pending.length ? `${pending.length} contract(s) still pending` : "every contract passed"}`)
}

// ---------- main ----------

const args = parseArgs(process.argv.slice(2))
const command = args._[0]
try {
  if (command === "research") await research(args)
  else if (command === "build") await build(args)
  else if (command === "status") await status()
  else if (command === "merge") await merge(args)
  else if (command === "structure") {
    const map = loadStructure()
    if (!map) throw new Error("no .codegen/structure.md yet (see .claude/rules/structure.md)")
    const tree = git(["ls-files"]).split("\n").filter((f) => f && !/^(\.codegen|\.claude|docs|wiki|data)\//.test(f))
    const problems = checkStructure(map, tree, ROOT)
    for (const p of problems) console.log(`  ${p}`)
    console.log(`\n${problems.length} of ${tree.length} files break .codegen/structure.md`)
    process.exit(problems.length ? 1 : 0)
  }
  else if (command === "board") {
    const file = await writeBoard()
    if (!file) throw new Error("board could not be written")
    console.log(`wrote ${path.relative(ROOT, file)}`)
    if (args.watch) {
      console.log("refreshing every 10 s; stop with Ctrl-C")
      for (;;) { await new Promise((r) => setTimeout(r, 10000)); await writeBoard() }
    }
  }
  else {
    console.log("usage: node .claude/codegen.mjs research [--only ids] [--reject ids] | build [--parallel N] [--only ids] [--resume] | status | structure | board [--watch] | merge [--partial]")
    process.exit(2)
  }
} catch (e) {
  console.error(`codegen: ${e.message}`)
  process.exit(1)
}
