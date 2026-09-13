#!/usr/bin/env node
// Minimal code-generation loop for OpenCode.
//
//   node .opencode/codegen.mjs research [--only q1,q2] [--reject q3,q4] [--wait]
//   node .opencode/codegen.mjs build [--parallel N (default 4; the supervisor passes 8)] [--only c1,c2] [--resume] [--wait]
//   research and build detach from the terminal that launched them (a TUI shell
//   kills long commands); --wait keeps them in the foreground.
//   node .opencode/codegen.mjs status
//   node .opencode/codegen.mjs structure          lists tracked files that break .codegen/structure.md
//   node .opencode/codegen.mjs merge [--partial]     fast-forward the run's integration branch into the user's branch
//   node .opencode/codegen.mjs board [--watch]     writes .codegen/board.html (also written on every state change)
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
// Models come from .opencode/models.json, cheapest first, edited by hand: if a
// model keeps failing you, move it down there.
//
// This file owns the commands and the state files. lib/agent.mjs runs processes,
// agents and the model ladder; lib/sandbox.mjs prepares, judges and lands one
// contract's sandbox; lib/board.mjs draws.

import { spawnSync, spawn, execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  statSync,
  readdirSync,
} from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { supervisorActivity } from "./lib/opencode-db.mjs"
import {
  loadModels,
  ladderFor as ladder,
  short,
  git as gitIn,
  run,
  runAgent,
  pool,
  climb,
} from "./lib/agent.mjs"
import {
  exportSandbox,
  cloneSandbox,
  venvEnv,
  resetSandbox,
  installDeps,
  runGate,
  gateBroken,
  changedFiles,
  checkScope,
  loadStructure as loadStructureIn,
  inMap,
  checkStructure,
  landContract,
} from "./lib/sandbox.mjs"

// node:sqlite (used by the board) is still flagged experimental in Node 22.
process.removeAllListeners("warning")
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.warn(w)
})

const ROOT = process.cwd()
const STATE = path.join(ROOT, ".codegen")
// Each contract builds in a sandbox next to the repository (see sandbox.mjs).
const SANDBOXES = path.join(path.dirname(ROOT), `.${path.basename(ROOT)}-codegen-sandboxes`)
let MODELS, TIMEOUTS, STEP_CAP
try {
  ;({ models: MODELS, timeouts: TIMEOUTS, stepCap: STEP_CAP } = loadModels(ROOT))
} catch (e) {
  console.error(`codegen: ${e.message}`)
  process.exit(1)
}
const ladderFor = (role, exclude) => ladder(MODELS, role, exclude)
const git = (args, cwd = ROOT) => gitIn(args, cwd)
const loadStructure = () => loadStructureIn(STATE)

// ---------- helpers ----------

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next
        i++
      } else args[key] = true
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

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
}

let LOG_FILE = null
function log(line) {
  const text = `${new Date().toISOString().slice(11, 19)} ${line}`
  console.log(text)
  if (LOG_FILE) appendFileSync(LOG_FILE, text + "\n")
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// .codegen/journal.jsonl: one line per thing that happened, read by the board.
function journal(event) {
  mkdirSync(STATE, { recursive: true })
  appendFileSync(
    path.join(STATE, "journal.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n",
  )
}

// Wakes the supervisor. The TUI is a chat turn: nobody is awake between
// turns, so the script sends the news into the supervisor's session through
// the local OpenCode server (the user's `opencode --port`). No server, no
// session: nothing happens and the board still shows the state.
function notify(text) {
  let session = null
  try {
    session = supervisorActivity(ROOT)?.sessionId ?? null
  } catch {}
  const port = process.env.OPENCODE_PORT ?? 4096
  // Delivered only if a TUI actually listens on that port: a TUI started
  // without --port (or on another port) would swallow the message silently.
  const listening =
    session &&
    spawnSync("bash", ["-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`], { stdio: "ignore", timeout: 2000 })
      .status === 0
  journal({
    kind: "notify",
    text,
    delivered: Boolean(listening),
    port,
    reason: !session
      ? "no supervisor session"
      : !listening
        ? `nothing listens on ${port}; start the TUI with OPENCODE_PORT=${port} opencode --port ${port}`
        : undefined,
  })
  if (!listening) return
  const child = spawn(
    "opencode",
    ["run", "--attach", `http://127.0.0.1:${port}`, "--session", session, `[codegen] ${text}`],
    { cwd: ROOT, detached: true, stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, PWD: ROOT } },
  )
  child.unref()
}

// Re-runs this command detached so the TUI's bash tool returns at once.
function detach(command) {
  const child = spawn(process.execPath, [process.argv[1], command, ...process.argv.slice(3), "--wait"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  })
  child.unref()
  console.log(
    `${command} started in background (pid ${child.pid}); follow with: node .opencode/codegen.mjs status`,
  )
}

// Sandboxes are exports of committed content: the harness and the plan must
// be in git or the builder finds no agent and no contract.
function sealAndCheckTracked() {
  // wiki/ is the supervisor's other folder; it has no git of its own, so the seal commits it too
  const sealed = [".codegen", ".opencode", "opencode.json", ".gitignore"].concat(
    existsSync(path.join(ROOT, "wiki")) ? ["wiki"] : [],
  )
  const dirty = git(["status", "--porcelain", "--", ...sealed, ":!.codegen/journal.jsonl"])
  if (dirty) {
    git(["add", ...sealed])
    git(["commit", "-q", "-m", "codegen: seal plan and harness"])
    journal({
      kind: "seal",
      contracts: readJson(path.join(STATE, "plan.json"), { contracts: [] }).contracts.length,
    })
    log(`sealed ${sealed.includes("wiki") ? ".codegen, wiki" : ".codegen"} and the harness into a commit`)
  }
}

// .codegen/board.html: the dependency graph and a board by state, rewritten
// on every state change so a browser tab can follow the run.
async function writeBoard() {
  // lib/board.mjs is imported fresh whenever it changes on disk (and it does the
  // same with board-html.mjs and board.css), so a build that runs for hours
  // picks up a new board without a restart.
  const boardFile = path.join(ROOT, ".opencode", "lib", "board.mjs")
  let renderBoard
  let boardJson
  let goQuota
  let openaiQuota
  try {
    ;({ renderBoard, boardJson, goQuota, openaiQuota } = await import(
      `${pathToFileURL(boardFile).href}?v=${statSync(boardFile).mtimeMs}`
    ))
  } catch (e) {
    console.error(`board: ${e.message}`)
    return null
  }
  const plan = readJson(path.join(STATE, "plan.json"), { contracts: [] })
  const current = readJson(path.join(STATE, "runs", "current.json"), null)
  const report = current ? readJson(path.join(STATE, "runs", current.run, "report.json"), null) : null
  const research = readJson(path.join(STATE, "research", "status.json"), null)
  const alive = Boolean(current?.pid && pidAlive(current.pid))
  const researchRun = readJson(path.join(STATE, "runs", "current-research.json"), null)
  const researchAlive = Boolean(researchRun?.pid && pidAlive(researchRun.pid))
  const journalFile = path.join(STATE, "journal.jsonl")
  const events = existsSync(journalFile)
    ? readFileSync(journalFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return null
          }
        })
        .filter(Boolean)
    : []
  const file = path.join(STATE, "board.html")
  // Research reports and contract files travel into the page (the board opens
  // as a local file and cannot read them itself); the Go and OpenAI quotas are one HTTP
  // call each with a cache, never fatal.
  const reports = {}
  const researchDir = path.join(STATE, "research")
  if (existsSync(researchDir))
    for (const f of readdirSync(researchDir))
      if (f.endsWith(".md") && !f.includes(".rejected-"))
        reports[f.slice(0, -3)] = readFileSync(path.join(researchDir, f), "utf8")
  const contractFiles = Object.fromEntries(
    plan.contracts
      .map((c) => [c.id, readJson(path.join(STATE, "contracts", c.id, "contract.json"), null)])
      .filter(([, v]) => v),
  )
  const [quota, openai] = await Promise.all([goQuota(), openaiQuota()])
  const args = {
    root: ROOT,
    sandboxes: SANDBOXES,
    reports,
    contractFiles,
    quota,
    openai,
    plan,
    report,
    current,
    research,
    alive,
    researchRun,
    researchAlive,
    events,
    models: MODELS,
    ladders: { builder: ladderFor("builder"), researcher: ladderFor("researcher") },
  }
  writeFileSync(file, await renderBoard(args))
  // board.json next to the HTML: same facts, for project-garden and scripts.
  // "merged" asks git whether the integration branch is already in the user's branch.
  // Only meaningful once something landed on the integration branch: a fresh
  // branch is trivially an ancestor of the user's branch.
  let merged = null
  const landed = Object.values(report?.contracts ?? {}).some((c) => c.status === "PASS")
  if (landed && current?.integration && current?.user_branch) {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", current.integration, current.user_branch], {
        cwd: ROOT,
        stdio: "ignore",
      })
      merged = true
    } catch {
      merged = false
    }
  }
  if (boardJson) writeJson(path.join(STATE, "board.json"), boardJson({ ...args, merged }))
  return file
}

// ---------- research ----------

async function research(args) {
  const questions = readJson(path.join(STATE, "research", "questions.json"))
  const statusFile = path.join(STATE, "research", "status.json")
  const previous = readJson(statusFile, { results: {} }).results
  const running = readJson(path.join(STATE, "runs", "current-research.json"), null)
  if (running?.pid && pidAlive(running.pid))
    throw new Error(
      `research ${running.run} is still running (pid ${running.pid}); wait for it or kill it first`,
    )
  const reject = args.reject ? String(args.reject).split(",") : []
  for (const id of reject) {
    const r = previous[id]
    if (!r?.model) throw new Error(`cannot reject ${id}: no report recorded`)
    if (r.status === "PARTIAL" || (r.rejected?.length ?? 0) >= 2)
      throw new Error(
        `cannot reject ${id}: ${r.status === "PARTIAL" ? "it is PARTIAL" : "already rejected twice"}; the question is too big for one sitting. Split it into new ids by what is missing and run those.`,
      )
  }
  const only = args.only ? String(args.only).split(",") : reject.length ? reject : null
  const selected = questions.filter((q) => !only || only.includes(q.id))
  if (selected.length === 0) throw new Error("no questions selected")
  if (!args.wait) return detach("research")
  // --reject: the supervisor judged these reports useless. Their model counts
  // as failed for the question, the report is set aside, and the question
  // reruns starting at the next rung.
  for (const id of reject) {
    const r = previous[id]
    const file = path.join(STATE, "research", `${id}.md`)
    if (existsSync(file)) {
      let n = (r.rejected?.length ?? 0) + 1
      while (existsSync(path.join(STATE, "research", `${id}.rejected-${n}.md`))) n++
      execFileSync("mv", [file, path.join(STATE, "research", `${id}.rejected-${n}.md`)])
    }
    previous[id] = {
      ...r,
      status: "REJECTED",
      report: null,
      rejected: [...new Set([...(r.rejected ?? []), r.model])],
    }
    journal({ kind: "reject", id, model: r.model })
  }
  if (reject.length) writeJson(statusFile, { run: readJson(statusFile, {}).run ?? null, results: previous })
  const runId = `${stamp()}-research`
  const runDir = path.join(STATE, "runs", runId)
  mkdirSync(runDir, { recursive: true })
  LOG_FILE = path.join(runDir, "log.txt")
  const results = {}
  writeJson(path.join(STATE, "runs", "current-research.json"), {
    run: runId,
    pid: process.pid,
    started: new Date().toISOString(),
    questions: selected.map((q) => q.id),
  })
  journal({
    kind: "research-start",
    run: runId,
    questions: selected.map((q) => ({ id: q.id, question: q.question })),
  })
  writeBoard()

  log(
    `research ${runId}: ${selected.length} questions, ladder ${ladderFor("researcher").map(short).join(" > ")}${reject.length ? ` (questions skip models that already failed them)` : ""}`,
  )
  const queue = [...selected]
  await pool(selected.length, () => {
    const q = queue.shift()
    if (!q) return null
    return () => researchOne(q, { runDir, runId, previous, results })
  })
  writeJson(path.join(runDir, "report.json"), { run: runId, results })
  writeJson(statusFile, { run: runId, results: { ...previous, ...results } })
  writeJson(path.join(STATE, "runs", "current-research.json"), {
    run: runId,
    pid: null,
    finished: new Date().toISOString(),
  })
  writeBoard()
  const tally = Object.values(results).reduce((t, r) => ((t[r.status] = (t[r.status] ?? 0) + 1), t), {})
  const oneShot = Object.entries(results).filter(([, r]) => r.one_shot)
  const notDone = Object.entries(results).filter(([, r]) => r.status !== "DONE")
  notify(
    `research run ended: ${Object.entries(tally)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")}${
      oneShot.length
        ? `; written in one go, never re-read (judge harder): ${oneShot.map(([id]) => id).join(", ")}`
        : ""
    }${notDone.length ? `; not DONE: ${notDone.map(([id, r]) => `${id} (${r.status})`).join(", ")}` : ""}. Judge the new reports and continue.`,
  )
  printResearch(results)
}

// One question up the researcher ladder: one attempt per rung, skipping the
// models that already failed it (rejected reports, timeouts, no report). A
// group rung is its members one after another (no race: the supervisor judges
// reports, so one report per rung is enough).
async function researchOne(q, { runDir, runId, previous, results }) {
  const output = path.join("research", `${q.id}.md`)
  const outputAbs = path.join(STATE, output)
  let attempt = 0
  const rejected = previous[q.id]?.rejected ?? []
  const exhausted = [...rejected]
  const tryOne = async (model) => {
    attempt++
    log(`  ${q.id}: attempt ${attempt} with ${model}`)
    const prompt = [
      `Research question ${q.id}: ${q.question}`,
      q.context ? `Context: ${q.context}` : "",
      `Write the report to .codegen/${output}`,
    ]
      .filter(Boolean)
      .join("\n")
    const r = await runAgent({
      agent: "researcher",
      model,
      prompt,
      cwd: ROOT,
      timeoutSeconds: TIMEOUTS.researcher ?? 600,
      silenceSeconds: TIMEOUTS.silence ?? 90,
      logPrefix: path.join(runDir, `${q.id}.${attempt}`),
    })
    const text = existsSync(outputAbs) ? readFileSync(outputAbs, "utf8") : ""
    const written = text.trim().length > 200
    // DONE only when the model closed with it, in time, within its step cap
    // and with the summary the supervisor reads; anything else with a file
    // is PARTIAL, for the supervisor to accept or split.
    const closed =
      !r.timedOut &&
      r.steps < STEP_CAP.researcher &&
      /^## Summary for contracts/m.test(text) &&
      /^DONE\b/.test(r.finalText.trim().split("\n").at(-1))
    const status = written
      ? closed
        ? "DONE"
        : "PARTIAL"
      : r.silent
        ? "NO_RESPONSE"
        : r.timedOut
          ? "TIMEOUT"
          : "NO_REPORT"
    results[q.id] = {
      status,
      model,
      attempt,
      steps: r.steps,
      one_shot: written && r.oneShot,
      report: written ? `.codegen/${output}` : null,
      final: r.finalText.slice(-400),
      run: runId,
      at: new Date().toISOString(),
      rejected: exhausted,
    }
    log(`  ${q.id}: ${status} (${r.steps} steps${written && r.oneShot ? ", written in one go" : ""})`)
    if (written) return "stop"
    // A model that never answered did not fail the question: not remembered.
    if (!r.silent) exhausted.push(model)
  }
  await climb({
    ladder: ladderFor("researcher", rejected),
    attempt: async (rung) => {
      for (const model of Array.isArray(rung) ? rung : [rung])
        if ((await tryOne(model)) === "stop") return "stop"
    },
  })
  // Models that failed without a report stay skipped for this question in later runs.
  results[q.id] ??= {
    status: "NO_MODELS",
    model: null,
    attempt: 0,
    steps: 0,
    report: null,
    final: "",
    run: runId,
    at: new Date().toISOString(),
    rejected: exhausted,
  }
  if (results[q.id].status !== "DONE" && results[q.id].status !== "PARTIAL") {
    results[q.id].rejected = exhausted
    log(
      `  ${q.id}: ${results[q.id].status}${exhausted.length ? ` (tried ${exhausted.map(short).join(", ")})` : ""}`,
    )
  }
  const res = results[q.id]
  journal({
    kind: "research",
    id: q.id,
    question: q.question,
    status: res.status,
    model: res.model,
    models: res.report ? exhausted.concat([res.model]) : exhausted,
    steps: res.steps,
    one_shot: res.one_shot,
    report: res.report,
  })
  if (res.status !== "DONE")
    notify(
      `research ${q.id}: ${res.status} with ${short(res.model) ?? "no model"}${res.report ? `, report at ${res.report}` : ", no report"}${res.final ? `. Last words: ${res.final.replace(/\s+/g, " ").trim().slice(-160)}` : ""}. Accept it or split it into new ids; the other questions keep running.`,
    )
  writeBoard()
}

function printResearch(results) {
  console.log("\nResearch summary")
  for (const [id, r] of Object.entries(results)) {
    console.log(
      `  ${r.status.padEnd(9)} ${id}  ${r.report ?? "(no report)"}  [${short(r.model)}]${r.one_shot ? "  written in one go" : ""}${r.rejected?.length ? `  skipped: ${r.rejected.map(short).join(", ")}` : ""}`,
    )
    if (r.status === "PARTIAL" && r.final)
      console.log(`            last words: ${r.final.replace(/\s+/g, " ").trim().slice(-300)}`)
  }
}

// ---------- build ----------

function loadPlan() {
  const plan = readJson(path.join(STATE, "plan.json"))
  const map = loadStructure()
  if (!map)
    throw new Error("plan: write .codegen/structure.md first (see .opencode/instructions/structure.md)")
  const ids = new Set()
  for (const c of plan.contracts) {
    if (!c.id || ids.has(c.id)) throw new Error(`plan: duplicate or missing id ${c.id}`)
    ids.add(c.id)
    c.depends_on ??= []
    for (const d of c.depends_on)
      if (!plan.contracts.some((x) => x.id === d)) throw new Error(`plan: ${c.id} depends on unknown ${d}`)
    const dir = path.join(STATE, "contracts", c.id)
    c.contract = readJson(path.join(dir, "contract.json"))
    if (!existsSync(path.join(dir, "gate.sh"))) throw new Error(`plan: ${c.id} has no gate.sh`)
    if (!Array.isArray(c.contract.allowed_to_modify) || c.contract.allowed_to_modify.length === 0)
      throw new Error(`plan: ${c.id} has empty allowed_to_modify`)
    const heavy = (c.contract.read ?? []).filter((p) => /\*\*|idea\.md$|\.codegen\/research\//.test(p))
    if (heavy.length || (c.contract.read ?? []).length > 5)
      throw new Error(
        `plan: ${c.id} read list is too big for a cheap model (${heavy.join(", ") || `${c.contract.read.length} files`}): at most 5 concrete files, never a glob, the idea or a research report; quote what the builder needs in the contract instead`,
      )
    for (const p of c.contract.allowed_to_modify)
      if (!inMap(p.replace(/\/\*\*$/, "/x"), map) && !inMap(p, map))
        throw new Error(`plan: ${c.id} allows ${p}, which is outside .codegen/structure.md`)
  }
  return plan
}

async function build(args) {
  const only = args.only ? String(args.only).split(",") : null
  const parallel = Number(args.parallel ?? 4)
  const plan = loadPlan()
  const live = readJson(path.join(STATE, "runs", "current.json"), null)
  if (live?.pid && pidAlive(live.pid))
    throw new Error(`build ${live.run} is still running (pid ${live.pid}); wait for it or kill it first`)
  if (!args.wait) return detach("build")
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
    try {
      git(
        ["merge", "-q", "--no-edit", "-m", `codegen: bring ${userBranch} into ${integration}`, "FETCH_HEAD"],
        integrationDir,
      )
    } catch (e) {
      throw new Error(
        `cannot merge ${userBranch} into ${integration}: ${String(e.stderr ?? e.message).slice(-400)}`,
      )
    }
    git(["push", "-q", "origin", `${integration}:${integration}`], integrationDir)
    log(`resume ${runId}: merged ${userBranch} into ${integration}`)
  }
  writeJson(path.join(STATE, "runs", "current.json"), {
    run: runId,
    integration,
    user_branch: userBranch,
    started: new Date().toISOString(),
    pid: process.pid,
  })
  journal({
    kind: previous ? "build-resume" : "build-start",
    run: runId,
    integration,
    contracts: plan.contracts.length,
    only,
    parallel,
  })
  log(
    `build ${runId}: ${plan.contracts.length} contracts, parallel ${parallel}, ladder ${ladderFor("builder").map(short).join(" > ")}${only ? `, only ${only.join(",")}` : ""}`,
  )

  const prevState = previous ? readJson(path.join(runDir, "report.json"), { contracts: {} }).contracts : {}
  const state = Object.fromEntries(
    plan.contracts.map((c) => {
      if (prevState[c.id]?.status === "PASS") return [c.id, prevState[c.id]]
      if (only && !only.includes(c.id)) return [c.id, { status: "NOT_SELECTED" }]
      return [c.id, { status: "PENDING" }]
    }),
  )
  const report = () => {
    writeJson(path.join(runDir, "report.json"), {
      run: runId,
      integration,
      user_branch: userBranch,
      contracts: state,
    })
    writeBoard()
  }
  report()
  log(`board: ${path.relative(ROOT, path.join(STATE, "board.html"))}`)

  const next = () => {
    const ready = plan.contracts.find(
      (c) => state[c.id].status === "PENDING" && c.depends_on.every((d) => state[d].status === "PASS"),
    )
    if (ready) {
      state[ready.id] = { status: "RUNNING", started: new Date().toISOString() }
      return () =>
        buildOne(ready, { runDir, integration, integrationDir, state, report })
          .catch((e) => {
            state[ready.id] = { status: "ERROR", reason: String(e.stack ?? e) }
            log(`  ${ready.id}: ERROR ${e.message}`)
          })
          .finally(report)
    }
    // Nothing ready: anything still pending whose dependency failed is skipped.
    for (const c of plan.contracts) {
      if (
        state[c.id].status === "PENDING" &&
        c.depends_on.some((d) => !["PENDING", "RUNNING", "PASS"].includes(state[d].status))
      ) {
        state[c.id] = {
          status: "SKIPPED",
          reason: `dependency failed: ${c.depends_on.filter((d) => state[d].status !== "PASS").join(", ")}`,
        }
      }
    }
    return null
  }
  await pool(parallel, next)

  rmSync(integrationDir, { recursive: true, force: true })
  const cur = readJson(path.join(STATE, "runs", "current.json"), {})
  writeJson(path.join(STATE, "runs", "current.json"), {
    ...cur,
    finished: new Date().toISOString(),
    pid: null,
  })
  journal({
    kind: "build-end",
    run: runId,
    passed: Object.values(state).filter((c) => c.status === "PASS").length,
    total: Object.keys(state).length,
  })
  const allPassed = Object.values(state).every((c) => c.status === "PASS")
  notify(
    `build ended: ${buildLine(state)}. ${allPassed ? "Tell the user it is ready to merge." : "Diagnose the failed ones, fix their contracts or gates, then build --resume."}`,
  )
  const touched = git(["status", "--porcelain", "--", ".", ":!.codegen"])
  if (touched) log(`WARNING: the user's working tree changed during the build:\n${touched}`)
  report()
  printBuild({ run: runId, integration, user_branch: userBranch, contracts: state })
}

// One contract: sandbox, dependencies, baseline gate, the builder ladder
// (two attempts per rung, the gate output of a failed attempt as evidence for
// the next), then land the diff or record why not.
async function buildOne(entry, { runDir, integration, integrationDir, state, report }) {
  const { id, contract } = entry
  const wt = path.join(SANDBOXES, id)
  const branch = `${integration}-${id}`
  const logs = path.join(runDir, id)
  mkdirSync(logs, { recursive: true })
  rmSync(wt, { recursive: true, force: true })
  mkdirSync(wt, { recursive: true })
  const { integrationHead, base } = exportSandbox({ root: ROOT, integration, wt, id })
  const record = (status, extra = {}) =>
    journal({ kind: "contract", id, status, title: entry.title, objective: contract.objective, ...extra })

  const deps = await installDeps(wt, logs, TIMEOUTS.install ?? 600)
  if (deps.failed !== undefined) {
    state[id] = { status: "INSTALL_FAILED", reason: deps.failed }
    log(`  ${id}: INSTALL_FAILED${deps.step}`)
    return
  }
  const env = deps.env

  // The gate must fail before anyone builds; otherwise it proves nothing.
  const baseline = await runGate(id, wt, path.join(logs, "gate-baseline.txt"), env, TIMEOUTS.gate ?? 300)
  if (baseline.pass) {
    state[id] = { status: "GATE_TRIVIAL", reason: "gate passes on the untouched repository" }
    record("GATE_TRIVIAL", { attempts: 0 })
    log(`  ${id}: GATE_TRIVIAL`)
    rmSync(wt, { recursive: true, force: true })
    return
  }

  const attempts = []
  let evidence = "",
    broken = false,
    winner = null,
    won = null
  const map = loadStructure()
  const baseFiles = new Set(git(["ls-files"], wt).split("\n"))
  // One attempt of one model in one sandbox: run the builder, judge the tree.
  const tryOne = async ({ model, dir, attempt, signal }) => {
    const prompt = [
      `Execute the contract at .codegen/contracts/${id}/contract.json. Its gate is bash .codegen/contracts/${id}/gate.sh.`,
      "Read .codegen/structure.md first: every file you create or move must fit that map and the naming convention it fixes.",
      evidence ? `Previous attempt failed the independent gate. Evidence:\n${evidence}` : "",
      "Implement it now and finish with the four status lines.",
    ]
      .filter(Boolean)
      .join("\n\n")
    const dirEnv = dir === wt ? env : venvEnv(dir)
    const r = await runAgent({
      agent: "builder",
      model,
      prompt,
      cwd: dir,
      timeoutSeconds: TIMEOUTS.builder ?? 900,
      silenceSeconds: TIMEOUTS.silence ?? 90,
      signal,
      logPrefix: path.join(logs, `attempt-${attempt}`),
      env: dirEnv,
    })
    const files = r.aborted ? [] : changedFiles(dir)
    const scope = checkScope(contract, files)
    let verdict, detail, structure
    if (r.aborted) {
      verdict = "LOST"
      detail = "another model passed the gate first"
    } else if (scope.touchedProtected.length) {
      verdict = "PROTECTED_TOUCHED"
      detail = scope.touchedProtected.join(", ")
    } else if (scope.outside.length) {
      verdict = "OUT_OF_SCOPE"
      detail = scope.outside.join(", ")
    } else if ((structure = checkStructure(map, files, dir, baseFiles)).length) {
      verdict = "STRUCTURE"
      detail = structure.join("\n")
    } else if (files.length === 0) {
      verdict = r.silent ? "NO_RESPONSE" : r.timedOut ? "TIMEOUT" : "NO_CHANGES"
      detail = r.finalText.slice(0, 500)
    } else {
      const gate = await runGate(
        id,
        dir,
        path.join(logs, `gate-${attempt}.txt`),
        dirEnv,
        TIMEOUTS.gate ?? 300,
      )
      verdict = gate.pass ? "PASS" : "GATE_FAIL"
      detail = gate.pass ? "" : gate.output
    }
    return { attempt, model, verdict, steps: r.steps, files, detail: detail.slice(-1500) }
  }
  const judge = (a, dir, racing = false) => {
    log(
      `  ${id}: ${a.verdict} (${a.steps} steps, ${a.files.length} files${racing ? `, ${short(a.model)}` : ""})`,
    )
    if (a.verdict === "PASS") {
      winner = dir
      won = a
      return "stop"
    }
    if (a.verdict === "GATE_FAIL" && gateBroken(a.detail, dir, contract)) {
      broken = true
      log(
        `  ${id}: the gate fails only in files outside the contract's scope; no builder can fix that, stopping`,
      )
      return "stop"
    }
  }
  await climb({
    ladder: ladderFor("builder"),
    attemptsPerRung: 2,
    onRung: () => resetSandbox(wt, base),
    attempt: async (rung) => {
      if (Array.isArray(rung)) {
        // A race: every model of the group at once, each in its own copy of the
        // sandbox; the first PASS wins and the others are killed (LOST). Attempts
        // are recorded in the group's order, not in finishing order.
        const first = attempts.length + 1
        Object.assign(state[id], { model: rung, attempt: first })
        report()
        log(`  ${id}: attempt ${first} racing ${short(rung)}`)
        const abort = new AbortController()
        const racers = rung.map((model, i) => {
          const dir = `${wt}-${i + 1}`
          cloneSandbox(wt, dir)
          return tryOne({ model, dir, attempt: first + i, signal: abort.signal }).then((a) => {
            if (a.verdict === "PASS" && !winner) {
              winner = dir
              abort.abort()
            }
            return { a, dir }
          })
        })
        const results = await Promise.all(racers)
        let outcome
        for (const { a, dir } of results) {
          attempts.push(a)
          if (a.verdict === "PASS" && dir !== winner) {
            log(
              `  ${id}: PASS too, not landed (${a.steps} steps, ${a.files.length} files, ${short(a.model)})`,
            )
            continue
          }
          const j = judge(a, dir, true)
          outcome ??= j
        }
        if (outcome === "stop") return "stop"
        const lost =
          results.find(({ a }) => a.verdict === "GATE_FAIL") ?? results.find(({ a }) => a.verdict !== "LOST")
        if (lost) evidence = `${lost.a.verdict}: ${lost.a.detail}`.slice(-3000)
        for (const { dir } of results) if (dir !== winner) rmSync(dir, { recursive: true, force: true })
        return
      }
      const attempt = attempts.length + 1
      Object.assign(state[id], { model: rung, attempt })
      report()
      log(`  ${id}: attempt ${attempt} with ${rung}`)
      const a = await tryOne({ model: rung, dir: wt, attempt })
      attempts.push(a)
      const j = judge(a, wt)
      if (j) return j
      if (a.verdict === "NO_RESPONSE") {
        log(`  ${id}: ${short(rung)} never answered, next model`)
        return "next"
      }
      evidence = `${a.verdict}: ${a.detail}`.slice(-3000)
      if (a.verdict === "PROTECTED_TOUCHED" || a.verdict === "OUT_OF_SCOPE" || a.verdict === "STRUCTURE")
        resetSandbox(wt, base)
    },
  })

  const last = won ?? attempts.at(-1)
  const models = [...new Set(attempts.filter((a) => a.verdict !== "LOST").map((a) => a.model))]
  if (last?.verdict !== "PASS") {
    state[id] = {
      status: "FAIL",
      attempts,
      reason: `${broken ? "GATE BROKEN: it fails only in files outside the contract's scope; fix the gate or the contract, not the builder. " : ""}${last ? `${last.verdict}: ${last.detail.slice(-600)}` : "no attempts"}`,
    }
    const lastLine = (last?.detail ?? "").split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 160)
    record("FAIL", { models, attempts: attempts.length, verdict: last?.verdict, detail: lastLine })
    log(`  ${id}: FAIL after ${attempts.length} attempts`)
    notify(
      `contract ${id} FAILED after ${attempts.length} attempts${broken ? " (GATE BROKEN: fails only outside the contract's scope)" : ""}; last verdict ${last?.verdict}: ${lastLine ?? ""}. Build so far: ${buildLine(state)}. The run continues. Diagnose it now (tail .codegen/runs/${path.basename(runDir)}/${id}/gate-${attempts.length}.txt) and leave its contract or gate fixed and committed; launch nothing while the run is alive.`,
    )
    return
  }
  const patch = path.join(logs, "candidate.diff")
  const landing = landContract({
    id,
    wt: winner ?? wt,
    base,
    patch,
    branch,
    integration,
    integrationHead,
    integrationDir,
    message: `codegen(${id}): ${contract.objective ?? entry.title ?? id}\n\nmodel: ${last.model}`,
  })
  if (!landing.landed) {
    state[id] = {
      status: "MERGE_CONFLICT",
      model: last.model,
      attempts,
      reason: landing.reason,
      branch,
      patch: path.relative(ROOT, patch),
    }
    record("MERGE_CONFLICT", { model: last.model, models, attempts: attempts.length })
    log(`  ${id}: MERGE_CONFLICT, see ${path.relative(ROOT, patch)}`)
    for (const d of new Set([wt, winner ?? wt])) rmSync(d, { recursive: true, force: true })
    return
  }
  state[id] = {
    status: "PASS",
    model: last.model,
    attempts,
    files: last.files,
    duration_ms: Date.now() - new Date(state[id].started ?? Date.now()).getTime(),
  }
  record("PASS", { model: last.model, models, attempts: attempts.length, files: last.files.length })
  log(`  ${id}: merged into ${integration}`)
  for (const d of new Set([wt, winner ?? wt])) rmSync(d, { recursive: true, force: true })
}

// One line of build state, the same for status and for the supervisor notices.
function buildLine(contracts) {
  const by = (st) =>
    Object.entries(contracts)
      .filter(([, c]) => c.status === st)
      .map(([id]) => id)
  const failed = Object.entries(contracts)
    .filter(([, c]) => !["PASS", "SKIPPED", "NOT_SELECTED", "PENDING", "RUNNING"].includes(c.status))
    .map(([id, c]) => `${id} (${c.status})`)
  return (
    `${by("PASS").length}/${Object.keys(contracts).length} PASS` +
    (by("RUNNING").length ? `; running: ${by("RUNNING").join(", ")}` : "") +
    (failed.length ? `; failed: ${failed.join(", ")}` : "") +
    (by("PENDING").length ? `; pending: ${by("PENDING").length}` : "") +
    (by("SKIPPED").length ? `; skipped: ${by("SKIPPED").length}` : "")
  )
}

function printBuild(r) {
  console.log(`\nBuild ${r.run} on branch ${r.integration}: ${buildLine(r.contracts)}`)
  for (const [id, c] of Object.entries(r.contracts)) {
    const extra =
      c.status === "RUNNING"
        ? ` [${short(c.model ?? "?")}, attempt ${c.attempt ?? 1}]`
        : c.model
          ? ` [${short(c.model)}, ${c.attempts?.length ?? 0} attempt(s)]`
          : c.reason
            ? `  ${String(c.reason).split("\n")[0].slice(0, 120)}`
            : ""
    console.log(`  ${c.status.padEnd(15)} ${id}${extra}`)
  }
  const passed = Object.values(r.contracts).filter((c) => c.status === "PASS").length
  console.log(`\n${passed}/${Object.keys(r.contracts).length} contracts passed their gate.`)
  if (passed < Object.keys(r.contracts).length)
    console.log(
      `Continue this run after fixing contracts with: node .opencode/codegen.mjs build --resume [--only ids]`,
    )
  if (passed)
    console.log(
      `Land it with: node .opencode/codegen.mjs merge${passed < Object.keys(r.contracts).length ? " --partial" : ""}`,
    )
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
    console.log(
      alive
        ? `build process ${current.pid} is running`
        : running
          ? "build process is NOT running: it was stopped or crashed; contracts marked RUNNING are stale. Relaunch with --only."
          : "build finished",
    )
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
  const pending = Object.entries(r?.contracts ?? {})
    .filter(([, c]) => c.status !== "PASS")
    .map(([id, c]) => `${id} (${c.status})`)
  if (pending.length && !args.partial)
    throw new Error(
      `not every contract passed: ${pending.join(", ")}. Fix and --resume, or merge --partial to take what passed.`,
    )
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"])
  if (branch !== current.user_branch) throw new Error(`checkout ${current.user_branch} first (on ${branch})`)
  // The supervisor may have written wiki/ or .codegen/ after the build sealed them: seal again.
  sealAndCheckTracked()
  // The script's own outputs (journal, board) never block a merge: they change on every event.
  if (
    git([
      "status",
      "--porcelain",
      "--",
      ".",
      ":!.codegen/board.html",
      ":!.codegen/board.json",
      ":!.codegen/journal.jsonl",
    ])
  )
    throw new Error("working tree has uncommitted changes; commit or stash them first")
  const before = git(["rev-parse", "HEAD"])
  let how = "fast-forward"
  try {
    git(["merge", "--ff-only", current.integration])
  } catch {
    // The user committed on their branch since the run started: do a real merge.
    how = "merge commit"
    try {
      git(["merge", "--no-edit", "-m", `codegen: land ${current.run}`, current.integration])
    } catch (e) {
      try {
        git(["merge", "--abort"])
      } catch {}
      throw new Error(
        `conflict merging ${current.integration} into ${branch}; nothing changed. Resolve by running build --resume (it merges ${branch} into the integration branch, where conflicts surface per contract) and merge again. (${String(
          e.stderr ?? e.message,
        )
          .trim()
          .slice(-300)})`,
      )
    }
  }
  const count = git(["rev-list", "--count", `${before}..HEAD`])
  journal({ kind: "merge", run: current.run, branch, how, commits: Number(count), pending: pending.length })
  await writeBoard()
  console.log(
    `landed ${current.integration} on ${branch} (${how}): ${count} commit(s), ${pending.length ? `${pending.length} contract(s) still pending` : "every contract passed"}`,
  )
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
    if (!map) throw new Error("no .codegen/structure.md yet (see .opencode/instructions/structure.md)")
    const tree = git(["ls-files"])
      .split("\n")
      .filter((f) => f && !/^(\.codegen|\.opencode|docs|wiki|data)\//.test(f) && f !== "opencode.json")
    const problems = checkStructure(map, tree, ROOT)
    for (const p of problems) console.log(`  ${p}`)
    console.log(`\n${problems.length} of ${tree.length} files break .codegen/structure.md`)
    process.exit(problems.length ? 1 : 0)
  } else if (command === "board") {
    const file = await writeBoard()
    if (!file) throw new Error("board could not be written")
    console.log(`wrote ${path.relative(ROOT, file)}`)
    if (args.watch) {
      console.log("refreshing every 10 s; stop with Ctrl-C")
      for (;;) {
        await new Promise((r) => setTimeout(r, 10000))
        await writeBoard()
      }
    }
  } else {
    console.log(
      "usage: node .opencode/codegen.mjs research [--only ids] [--reject ids] [--wait] | build [--parallel N] [--only ids] [--resume] [--wait] | status | structure | board [--watch] | merge [--partial]",
    )
    process.exit(2)
  }
} catch (e) {
  console.error(`codegen: ${e.message}`)
  process.exit(1)
}
