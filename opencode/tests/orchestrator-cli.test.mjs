import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { approvalRecord } from "../.opencode/codegen/lib/goal.mjs"

const execFile = promisify(execFileCallback)
const here = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(here, "..")
const fixture = path.join(here, "fixtures/orchestrator-basic")

// Fake `opencode`: the planner writes the fixture plan with the real HEAD, the
// builder applies a canned solution for the contract found in its cwd and logs
// start/end times so parallelism is observable. FAKE_FAIL_FIRST names a
// contract whose first attempt writes a wrong implementation.
const fakeOpenCode = `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const argv = process.argv
const agent = argv[argv.indexOf("--agent") + 1]
const model = argv[argv.indexOf("--model") + 1]
const prompt = argv[argv.length - 1]
const sleepMs = Number(process.env.FAKE_SLEEP_MS || 600)
function log(record) { fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ model, ...record }) + "\\n") }
// Distinct models this fake has already seen for an agent (and contract), in
// order: the rung of the current model. FAKE_*_RUNGS says how many rungs
// fail ("*" = every rung), so escalation is observable per configuration.
function rungOf(filter) {
  const seen = []
  for (const line of (fs.existsSync(process.env.FAKE_LOG) ? fs.readFileSync(process.env.FAKE_LOG, "utf8") : "").split("\\n").filter(Boolean)) {
    const entry = JSON.parse(line)
    if (filter(entry) && !seen.includes(entry.model)) seen.push(entry.model)
  }
  return seen.includes(model) ? seen.indexOf(model) + 1 : seen.length + 1
}
function failingRung(value, rung) { return value === "*" || rung <= Number(value || 0) }
function done(text) { if (text) console.log(JSON.stringify({type:"text",part:{text}})); console.log(JSON.stringify({type:"step_finish",part:{cost:0.001,tokens:{input:5,output:5,reasoning:0,cache:{read:0,write:0}}}})) }
if (agent === "planner") {
  const output = prompt.match(/Write the complete plan to (\\S+)\\./)[1]
  // A repair plan (the prompt says so) comes from FAKE_REPAIR_PLAN_TEMPLATE and
  // is based on the HEAD of the cwd, the integration worktree.
  const repairing = /This is a repair plan/.test(prompt)
  const plan = JSON.parse(fs.readFileSync(repairing ? process.env.FAKE_REPAIR_PLAN_TEMPLATE : process.env.FAKE_PLAN_TEMPLATE, "utf8"))
  plan.base_revision = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim()
  // FAKE_PLAN_INVALID_FIRST: the first plan uses a wildcard the validator
  // rejects; FAKE_PLAN_UNCOVERED_FIRST: the first plan forgets to cover the
  // Goal's must requirement. The retry (prompt carries the evidence) is clean.
  const retry = /This is a retry/.test(prompt)
  if (process.env.FAKE_PLAN_INVALID_FIRST && !retry) plan.phases[0].contracts[0].allowed_to_modify = ["lib/*.py"]
  if (process.env.FAKE_PLAN_UNCOVERED_FIRST && !retry) for (const phase of plan.phases) for (const c of phase.contracts) c.requirements[0].covers = ["ACC-1"]
  // FAKE_PLAN_TOUCH_MANIFEST: the first contract may also modify package.json (a risk floor).
  if (process.env.FAKE_PLAN_TOUCH_MANIFEST) plan.phases[0].contracts[0].allowed_to_modify.push("package.json")
  // FAKE_PLAN_INVALID_RUNGS: the first N planner configurations always write the rejected wildcard (no progress; "*" = all).
  if (failingRung(process.env.FAKE_PLAN_INVALID_RUNGS, rungOf((entry) => entry.agent === "planner"))) plan.phases[0].contracts[0].allowed_to_modify = ["lib/*.py"]
  // FAKE_PLAN_TRIVIAL_CHECK: the first contract's check passes on the baseline.
  if (process.env.FAKE_PLAN_TRIVIAL_CHECK) plan.phases[0].contracts[0].verification.checks[0].command = "true"
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(plan, null, 2))
  log({ agent, prompt, retry, repairing, cwd: process.cwd() })
  done()
} else if (agent === "builder") {
  const contract = JSON.parse(fs.readFileSync(".codegen-contract/contract.json", "utf8"))
  const retry = /This is a retry/.test(prompt)
  // A composed repair contract carries a repair block; its solution is the parent
  // contract's correct one. FAKE_REPAIR_MODE: what every repair or rebuild
  // Builder does (pass, subtle, blocked). FAKE_TOUCH_INTEGRATION names a
  // contract whose Builder also commits a change of its file on the
  // integration branch, so its own commit conflicts at integration.
  const repairing = Boolean(contract.repair) || /repairs an integration failure/.test(prompt)
  const target = contract.repair ? contract.repair.parent_contract_id : contract.contract_id
  const evidence = (prompt.match(/attempt at (\\S+) before/) || [])[1] || null
  const evidenceExists = evidence ? fs.existsSync(evidence) : null
  const start = Date.now()
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs)
  // FAKE_FAIL_FIRST: wrong solution on the first attempt. FAKE_FAIL_RUNGS: the
  // first N builder configurations write the same wrong solution on every
  // attempt (no progress; "*" = all). FAKE_FAIL_SEQUENCE
  // "<contract>:<mode>,<mode>,...": one mode per attempt, scope (also writes a
  // file outside the contract), gate (wrong solution), or pass.
  const attempt = evidence ? Number((evidence.match(/evidence-(\\d+)\\.json$/) || [])[1]) + 1 : 1
  const rung = rungOf((entry) => entry.agent === "builder" && entry.contract_id === contract.contract_id)
  const [sequenceId, sequenceModes] = (process.env.FAKE_FAIL_SEQUENCE || ":").split(":")
  const sequence = sequenceId === contract.contract_id ? sequenceModes.split(",") : []
  const wrong = failingRung(process.env.FAKE_FAIL_RUNGS, rung) || (process.env.FAKE_FAIL_FIRST === contract.contract_id && !retry)
  const mode = sequence[attempt - 1] || (repairing ? (process.env.FAKE_REPAIR_MODE || "pass") : wrong ? "gate" : "pass")
  if (mode === "scope") fs.writeFileSync("lib/extra.py", "# outside the contract\\n")
  const suffix = { gate: "-wrong", subtle: "-subtle" }[mode] || ""
  if (mode !== "blocked") fs.copyFileSync(path.join(process.env.FAKE_SOLUTIONS, target + suffix + ".py"), contract.allowed_to_modify[0])
  // A failing rung changes the file every time (a Builder that keeps editing) while the same check keeps failing.
  if (wrong && mode === "gate") fs.appendFileSync(contract.allowed_to_modify[0], "# attempt " + attempt + "\\n")
  if (process.env.FAKE_TOUCH_INTEGRATION === contract.contract_id && !repairing) {
    const integration = path.resolve(process.cwd(), "../../integration")
    fs.writeFileSync(path.join(integration, contract.allowed_to_modify[0]), "# touched outside the run\\n")
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qam", "outside the run"], { cwd: integration })
  }
  log({ agent, contract_id: contract.contract_id, cwd: process.cwd(), start, end: Date.now(), retry, repairing, attempt, rung, mode, evidence, evidence_exists: evidenceExists, checks: contract.verification.checks.map((c) => c.command) })
  done(mode === "blocked" ? "BLOCKED: the interaction needs a product decision" : null)
} else if (agent === "gate-designer") {
  // Makes the trivial check real: the contract's unit test.
  const contract = JSON.parse(fs.readFileSync(".codegen-contract/contract.json", "utf8"))
  fs.writeFileSync(".codegen-contract/checks/C1.sh", "#!/usr/bin/env bash\\nset -euo pipefail\\npython3 -m unittest tests/test_" + contract.contract_id + ".py\\n")
  log({ agent, contract_id: contract.contract_id, prompt })
  done()
} else {
  log({ agent, prompt })
  done()
}
`

async function project(goalFixture = path.join(fixture, ".codegen-goal/goal.json")) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orchestrator-test-"))
  const bin = path.join(directory, "bin-fake")
  await mkdir(bin)
  await writeFile(path.join(bin, "opencode"), fakeOpenCode, { mode: 0o755 })
  for (const entry of ["lib", "tests"]) await cp(path.join(fixture, entry), path.join(directory, entry), { recursive: true })
  await mkdir(path.join(directory, ".codegen-goal"))
  await cp(goalFixture, path.join(directory, ".codegen-goal/goal.json"))
  await writeFile(path.join(directory, ".gitignore"), "bin-fake/\nfake.log\nmetalog.jsonl\n__pycache__/\n.codegen-goal/\n.codegen-plan/\n")
  const git = (...args) => execFile("git", args, { cwd: directory })
  await git("init", "-q", "-b", "main")
  await git("-c", "user.name=t", "-c", "user.email=t@localhost", "add", ".")
  await git("-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "baseline")
  return { directory, bin, git }
}

function orchestrate(tree, args, env = {}) {
  return execFile(process.execPath, [path.join(systemRoot, ".opencode/codegen/scripts/orchestrate.mjs"), ...args], {
    cwd: tree.directory,
    env: {
      ...process.env,
      PATH: `${tree.bin}${path.delimiter}${process.env.PATH}`,
      FAKE_LOG: path.join(tree.directory, "fake.log"),
      CODEGEN_METALOG: path.join(tree.directory, "metalog.jsonl"),
      FAKE_PLAN_TEMPLATE: path.join(fixture, "plan-template.json"),
      FAKE_REPAIR_PLAN_TEMPLATE: path.join(fixture, "plan-repair.json"),
      FAKE_SOLUTIONS: path.join(fixture, "solutions"),
      PYTHONDONTWRITEBYTECODE: "1",
      ...env,
    },
    maxBuffer: 16 * 1024 * 1024,
  }).then(
    (result) => ({ code: 0, ...result }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  )
}

// The planned route pauses for plan review: the first call plans and stops,
// the second builds the reviewed plan.
async function planThenBuild(tree, runId, args = [], env = {}) {
  const planned = await orchestrate(tree, ["--run-id", `${runId}-plan`, ...args], env)
  assert.equal(planned.code, 0, planned.stderr)
  const review = JSON.parse(planned.stdout)
  assert.equal(review.status, "PLAN_REVIEW_REQUIRED")
  const built = await orchestrate(tree, ["--run-id", runId, "--plan", review.plan_path, ...args], env)
  return { review, built }
}

async function readLog(tree) {
  return (await readFile(path.join(tree.directory, "fake.log"), "utf8")).trim().split("\n").map(JSON.parse)
}

async function events(tree, runId) {
  return (await readFile(path.join(tree.directory, ".codegen-run", runId, "events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line).event)
}

test("planned route: plan review pause, parallel wave, dependent wave, integration branch, final gate, coverage ledger", async () => {
  const tree = await project()
  try {
    // Builders sleep long enough for the overlap assertion to hold on a loaded machine.
    const { review, built } = await planThenBuild(tree, "r1", ["--concurrency", "2"], { FAKE_SLEEP_MS: "2000" })

    // The pause: plan and PLAN.md exist, no worktree does, the Planner ran once.
    assert.equal(review.route, "planned")
    assert.equal(review.planner_calls, 1)
    assert.equal(review.plan_path, ".codegen-plan/r1-plan.json")
    assert.equal(review.plan_markdown, ".codegen-plan/r1-plan.md")
    const markdown = await readFile(path.join(tree.directory, review.plan_markdown), "utf8")
    assert.ok(markdown.includes("`REQ-1` [must] All unit tests pass — **covered**"), markdown)
    await assert.rejects(access(path.join(tree.directory, ".codegen-run/r1-plan/integration")))
    assert.deepEqual(review.waves, [])

    assert.equal(built.code, 0, built.stderr)
    const state = JSON.parse(built.stdout)
    assert.equal(state.status, "COMPLETED")
    assert.equal(state.route, "planned")
    assert.equal(state.planner_calls, 0)
    assert.equal(state.plan_reviewed, true)
    assert.deepEqual(state.waves.map((wave) => wave.phases), [["core"], ["compose"]])
    assert.deepEqual(state.waves.map((wave) => wave.status), ["COMPLETED", "COMPLETED"])
    assert.ok(state.waves.flatMap((wave) => wave.contracts).every((c) => c.status === "PASSED" && c.result_commit))
    assert.equal(state.final_gate.result, "PASS")
    assert.deepEqual(state.final_gate.changed_files, ["lib/alpha.py", "lib/beta.py", "lib/gamma.py"])
    assert.deepEqual(state.final_gate.checks.map((check) => [check.contract_id, check.exit_code]), [
      ["alpha", 0], ["beta", 0], ["gamma", 0], [null, 0],
    ])
    assert.deepEqual(state.final_gate.checks[0].check_results, [{ check_id: "C1", result: "PASS" }])

    // The ledger closes the loop against the Goal.
    assert.deepEqual(state.goal_coverage.summary, { verified: 2, failed: 0, not_verified: 0, pending_human: 0 })
    assert.equal(state.goal_coverage.requirements[0].status, "VERIFIED")
    assert.deepEqual(state.goal_coverage.requirements[0].claims.map((claim) => [claim.contract_id, claim.status]), [["alpha", "VERIFIED"], ["beta", "VERIFIED"], ["gamma", "VERIFIED"]])

    // Wave 1 builders overlapped in time; gamma started only after both ended.
    const log = (await readLog(tree)).filter((entry) => entry.agent === "builder")
    const byId = Object.fromEntries(log.map((entry) => [entry.contract_id, entry]))
    assert.ok(byId.alpha.start < byId.beta.end && byId.beta.start < byId.alpha.end, "wave-1 builders did not overlap")
    assert.ok(byId.gamma.start >= Math.max(byId.alpha.end, byId.beta.end))
    assert.ok(byId.alpha.cwd.endsWith("/.codegen-run/r1/worktrees/alpha"))
    assert.deepEqual(byId.alpha.checks, ["bash .codegen-contract/checks/C1.sh"])

    // The integration branch carries the three results and nothing else.
    const { stdout: files } = await tree.git("ls-tree", "-r", "--name-only", "codegen/r1")
    assert.ok(!files.includes(".codegen-contract"))
    const { stdout: gamma } = await tree.git("show", "codegen/r1:lib/gamma.py")
    assert.ok(gamma.includes("return beta(alpha(value))"))
    const { stdout: count } = await tree.git("rev-list", "--count", "main..codegen/r1")
    assert.equal(count.trim(), "3")

    // The user's checkout is untouched.
    const { stdout: status } = await tree.git("status", "--porcelain")
    assert.equal(status.trim(), "")
    assert.ok((await readFile(path.join(tree.directory, "lib/alpha.py"), "utf8")).includes("NotImplementedError"))
    await assert.rejects(access(path.join(tree.directory, ".codegen-run/r1/worktrees/alpha")))

    const sequence = await events(tree, "r1")
    for (const event of ["GOAL_LOADED", "ROUTED", "PLAN_VALIDATED", "DAG_READY", "WAVE_READY", "GATE_READY", "BUILDER_DISPATCHED", "CONTRACT_PASSED", "INTEGRATED", "WAVE_COMPLETED", "FINAL_GATE_PASS", "GOAL_COVERAGE", "RUN_COMPLETED"]) {
      assert.ok(sequence.includes(event), `missing event ${event}`)
    }
    assert.ok(!sequence.includes("GATE_DESIGN_REQUESTED"))
    assert.ok(!sequence.includes("PLAN_REQUESTED"))
    assert.ok((await events(tree, "r1-plan")).includes("PLAN_REQUESTED"))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("serial concurrency and retry with per-check evidence after a failed gate", async () => {
  const tree = await project()
  try {
    const { built } = await planThenBuild(tree, "r2", ["--concurrency", "1", "--keep-worktrees", "true"], { FAKE_FAIL_FIRST: "beta" })
    assert.equal(built.code, 0, built.stderr)
    const state = JSON.parse(built.stdout)
    assert.equal(state.status, "COMPLETED")
    const beta = state.waves[0].contracts.find((c) => c.contract_id === "beta")
    assert.deepEqual(beta.attempts.map((attempt) => attempt.result), ["GATE_FAIL", "PASS"])
    assert.equal(beta.attempts[1].evidence, ".codegen-contract/evidence-1.json")

    const log = (await readLog(tree)).filter((entry) => entry.agent === "builder")
    const betaRuns = log.filter((entry) => entry.contract_id === "beta")
    assert.deepEqual(betaRuns.map((entry) => [entry.retry, entry.evidence_exists]), [[false, null], [true, true]])
    const alpha = log.find((entry) => entry.contract_id === "alpha")
    assert.ok(alpha.end <= betaRuns[0].start || betaRuns[1].end <= alpha.start, "builders overlapped with concurrency 1")

    const evidence = JSON.parse(await readFile(path.join(tree.directory, ".codegen-run/r2/worktrees/beta/.codegen-contract/evidence-1.json"), "utf8"))
    assert.equal(evidence.result, "GATE_FAIL")
    assert.equal(evidence.verification[0].check_id, "C1")
    assert.deepEqual(evidence.verification[0].covers, ["R1"])
    assert.match(evidence.verification[0].output, /AssertionError/)
    const sequence = await events(tree, "r2")
    assert.ok(sequence.includes("RETRY"))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("direct route: the Planner is capped at one contract, the run has one wave, and it never pauses", async () => {
  const tree = await project(path.join(fixture, "goal-direct.json"))
  try {
    const result = await orchestrate(tree, ["--run-id", "r4"], { FAKE_PLAN_TEMPLATE: path.join(fixture, "plan-direct.json") })
    assert.equal(result.code, 0, result.stderr)
    const state = JSON.parse(result.stdout)
    assert.equal(state.status, "COMPLETED")
    assert.equal(state.route, "direct")
    assert.equal(state.planner_calls, 1)
    assert.equal(state.plan_reviewed, false)
    assert.equal(state.plan_markdown, ".codegen-plan/r4.md")
    assert.equal(state.waves.length, 1)
    assert.deepEqual(state.final_gate.changed_files, ["lib/alpha.py"])
    assert.equal(state.goal_coverage.summary.verified, 2)
    const planner = (await readLog(tree)).find((entry) => entry.agent === "planner")
    assert.match(planner.prompt, /write one phase with one contract if the change fits in one/)
    assert.match(planner.prompt, /requirement \(must\) REQ-1: All unit tests pass/)
    assert.equal(state.triage.route_effective, "direct")
    assert.equal(state.triage.risk_effective, "low")
    assert.deepEqual(state.triage.contradictions, [])
    assert.equal(state.waves[0].contracts[0].risk_effective, "low")
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("direct route: a plan that needs more than one contract is re-routed to planned and pauses for review", async () => {
  const tree = await project(path.join(fixture, "goal-direct.json"))
  try {
    const goalPath = path.join(tree.directory, ".codegen-goal/goal.json")
    const goal = JSON.parse(await readFile(goalPath, "utf8"))
    // The fixture is sealed; a changed Goal has to be sealed again or the digest refuses it.
    const widened = { ...goal, in_scope: ["lib/alpha.py", "lib/beta.py", "lib/gamma.py"] }
    await writeFile(goalPath, JSON.stringify({ ...widened, approval: approvalRecord(widened) }))
    const result = await orchestrate(tree, ["--run-id", "r5"])
    assert.equal(result.code, 0, result.stderr)
    const state = JSON.parse(result.stdout)
    assert.equal(state.status, "PLAN_REVIEW_REQUIRED")
    assert.equal(state.planner_calls, 1)
    assert.equal(state.route, "planned")
    assert.equal(state.triage.route_goal, "direct")
    assert.deepEqual(state.triage.contradictions.map((item) => [item.label, item.claimed, item.effective]), [["change_shape", "localized", "multi-component"]])
    assert.equal(state.waves.length, 0)
    const names = await events(tree, "r5")
    assert.ok(names.includes("TRIAGE_CONTRADICTED"))
    assert.ok(!names.includes("PLAN_RETRY"), "re-routing costs no planner retry")
    const markdown = await readFile(path.join(tree.directory, state.plan_markdown), "utf8")
    assert.ok(markdown.includes("- Route: Goal `direct` → effective `planned`"), markdown)

    // The reviewed plan builds as a planned run: three contracts, two waves.
    const built = await orchestrate(tree, ["--run-id", "r5b", "--plan", state.plan_path])
    assert.equal(built.code, 0, built.stderr)
    const done = JSON.parse(built.stdout)
    assert.equal(done.status, "COMPLETED")
    assert.equal(done.route, "planned")
    assert.equal(done.waves.length, 2)
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("direct route: a path with a risk floor raises the effective risk, pauses for review, and governs builder admission", async () => {
  const tree = await project(path.join(fixture, "goal-direct.json"))
  try {
    const env = { FAKE_PLAN_TEMPLATE: path.join(fixture, "plan-direct.json"), FAKE_PLAN_TOUCH_MANIFEST: "1" }
    const paused = await orchestrate(tree, ["--run-id", "r12"], env)
    assert.equal(paused.code, 0, paused.stderr)
    const review = JSON.parse(paused.stdout)
    assert.equal(review.status, "PLAN_REVIEW_REQUIRED")
    assert.equal(review.route, "direct")
    assert.equal(review.triage.risk_goal, "low")
    assert.equal(review.triage.risk_effective, "medium")
    assert.deepEqual(review.triage.contradictions.map((item) => [item.label, item.claimed, item.effective]), [["risk", "low", "medium"]])
    assert.match(review.triage.contradictions[0].evidence, /package\.json, dependency manifest or lockfile/)

    const built = await orchestrate(tree, ["--run-id", "r12b", "--plan", review.plan_path], env)
    assert.equal(built.code, 0, built.stderr)
    const state = JSON.parse(built.stdout)
    assert.equal(state.status, "COMPLETED")
    const alpha = state.waves[0].contracts[0]
    assert.equal(alpha.risk_effective, "medium", "the effective risk is what the builder is admitted against")
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("direct route: a Gate the Goal said existed but the Gate Designer had to write is recorded as a triage contradiction", async () => {
  const tree = await project(path.join(fixture, "goal-direct.json"))
  try {
    const result = await orchestrate(tree, ["--run-id", "r13"], { FAKE_PLAN_TEMPLATE: path.join(fixture, "plan-direct.json"), FAKE_PLAN_TRIVIAL_CHECK: "1" })
    assert.equal(result.code, 0, result.stderr)
    const state = JSON.parse(result.stdout)
    assert.equal(state.status, "COMPLETED", JSON.stringify(state.stop_reason))
    assert.equal(state.gate_designer_calls, 1)
    assert.deepEqual(state.triage.contradictions.map((item) => [item.label, item.claimed, item.effective]), [["existing_gate", true, false]])
    assert.match(state.triage.contradictions[0].evidence, /check-passes-on-baseline:C1/)
    const names = await events(tree, "r13")
    assert.ok(names.includes("GATE_DESIGN_REQUESTED"))
    assert.ok(names.includes("TRIAGE_CONTRADICTED"))
    const designer = (await readLog(tree)).find((entry) => entry.agent === "gate-designer")
    assert.match(designer.prompt, /checks\/C1\.sh passes on the untouched baseline/)
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("a deliberated goal the user has not approved stops for approval", async () => {
  const tree = await project(path.join(fixture, "goal-direct.json"))
  try {
    const goalPath = path.join(tree.directory, ".codegen-goal/goal.json")
    const goal = JSON.parse(await readFile(goalPath, "utf8"))
    const { approval, ...open } = goal
    await writeFile(goalPath, JSON.stringify({ ...open, status: "DECIDED" }))
    const result = await orchestrate(tree, ["--run-id", "r6"])
    assert.equal(result.code, 1)
    const state = JSON.parse(result.stdout)
    assert.equal(state.status, "APPROVAL_REQUIRED")
    assert.match(state.stop_reason, /approve it first/)
    assert.equal(state.planner_calls, 0)
    await assert.rejects(readFile(path.join(tree.directory, "fake.log")))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("a goal that still needs deliberation stops before planning, naming what keeps it open", async () => {
  const tree = await project(path.join(here, "fixtures/goal-research/goal.json"))
  try {
    const result = await orchestrate(tree, ["--run-id", "r3"])
    assert.equal(result.code, 1)
    const state = JSON.parse(result.stdout)
    assert.equal(state.status, "APPROVAL_REQUIRED")
    assert.match(state.stop_reason, /deliberate first \(external-research-required, required-research-pending\)/)
    assert.equal(state.planner_calls, 0)
    await assert.rejects(readFile(path.join(tree.directory, "fake.log")))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("a plan the validator rejects is re-requested with evidence, and a plan that repeats the errors stops the run", async () => {
  const tree = await project()
  try {
    const result = await orchestrate(tree, ["--run-id", "r7"], { FAKE_PLAN_INVALID_FIRST: "1" })
    assert.equal(result.code, 0, result.stderr)
    const state = JSON.parse(result.stdout)
    assert.equal(state.status, "PLAN_REVIEW_REQUIRED")
    assert.equal(state.planner_calls, 2)
    assert.equal(state.plan_path, ".codegen-plan/r7-2.json")
    const names = await events(tree, "r7")
    assert.ok(names.includes("PLAN_RETRY"))
    const evidence = JSON.parse(await readFile(path.join(tree.directory, ".codegen-plan/r7-1.evidence.json"), "utf8"))
    assert.ok(evidence.errors.some((e) => e.includes("allowed_to_modify: lib/*.py")))
    const planners = (await readLog(tree)).filter((entry) => entry.agent === "planner")
    assert.deepEqual(planners.map((entry) => entry.retry), [false, true])
    assert.ok(planners[1].prompt.includes("rejected by the deterministic validator"))

    // A planner that reproduces its own errors makes no progress: the next
    // configuration of the list gets the evidence, and the plan is reviewed.
    const escalated = await orchestrate(tree, ["--run-id", "r8"], { FAKE_PLAN_INVALID_RUNGS: "1" })
    assert.equal(escalated.code, 0, escalated.stderr)
    const reviewed = JSON.parse(escalated.stdout)
    assert.equal(reviewed.status, "PLAN_REVIEW_REQUIRED")
    assert.equal(reviewed.planner_calls, 3)
    assert.equal(reviewed.escalations.length, 1)
    assert.equal(reviewed.escalations[0].role, "planner")
    assert.match(reviewed.escalations[0].reason, /no progress: attempt 2 reproduced the validation errors of attempt 1/)
    const plannerModels = (await readLog(tree)).filter((entry) => entry.agent === "planner").slice(-3).map((entry) => entry.model)
    assert.equal(plannerModels[0], plannerModels[1])
    assert.notEqual(plannerModels[1], plannerModels[2], "the third call went to the next rung")
    assert.ok((await events(tree, "r8")).includes("ESCALATED"))
    const escalationEvidence = JSON.parse(await readFile(path.join(tree.directory, reviewed.escalations[0].evidence), "utf8"))
    assert.equal(escalationEvidence.escalated_from, reviewed.escalations[0].from)
    const metalog = (await readFile(path.join(tree.directory, "metalog.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.deepEqual(metalog.filter((entry) => entry.kind === "stop").map((entry) => [entry.role, entry.configuration_id]), [["planner", reviewed.escalations[0].from]])

    // When every planner reproduces the errors, the run stops with the list exhausted.
    const stopped = await orchestrate(tree, ["--run-id", "r8b"], { FAKE_PLAN_INVALID_RUNGS: "*" })
    assert.equal(stopped.code, 1)
    const failed = JSON.parse(stopped.stdout)
    assert.equal(failed.status, "PLAN_FAILED")
    assert.match(failed.stop_reason, /no progress: .*; no other planner admitted/)
    assert.ok(failed.escalations.length >= 2)
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("a plan that leaves a must requirement uncovered is rejected and re-requested with the coverage error", async () => {
  const tree = await project()
  try {
    const result = await orchestrate(tree, ["--run-id", "r10"], { FAKE_PLAN_UNCOVERED_FIRST: "1" })
    assert.equal(result.code, 0, result.stderr)
    const state = JSON.parse(result.stdout)
    assert.equal(state.status, "PLAN_REVIEW_REQUIRED")
    assert.equal(state.planner_calls, 2)
    const evidence = JSON.parse(await readFile(path.join(tree.directory, ".codegen-plan/r10-1.evidence.json"), "utf8"))
    assert.ok(evidence.errors.some((e) => e.includes("Goal requirement REQ-1 (must) is not covered")), evidence.errors.join("\n"))
    await assert.rejects(access(path.join(tree.directory, ".codegen-plan/r10-1.md")), "no PLAN.md for a rejected plan")
    await access(path.join(tree.directory, ".codegen-plan/r10-2.md"))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("a reviewed plan whose base revision is no longer HEAD is refused", async () => {
  const tree = await project()
  try {
    const planned = await orchestrate(tree, ["--run-id", "r11-plan"])
    assert.equal(JSON.parse(planned.stdout).status, "PLAN_REVIEW_REQUIRED")
    await writeFile(path.join(tree.directory, "README.md"), "moved on\n")
    await tree.git("-c", "user.name=t", "-c", "user.email=t@localhost", "add", ".")
    await tree.git("-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "moved on")
    const built = await orchestrate(tree, ["--run-id", "r11", "--plan", ".codegen-plan/r11-plan.json"])
    assert.equal(built.code, 1)
    assert.equal(JSON.parse(built.stdout).status, "PLAN_STALE")
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("a project that ignores .codegen-contract still gets sealed contracts committed in the worktree", async () => {
  const tree = await project()
  try {
    await writeFile(path.join(tree.directory, ".gitignore"), "bin-fake/\nfake.log\n__pycache__/\n.codegen-goal/\n.codegen-plan/\n.codegen-contract/\n.codegen-run/\n")
    await tree.git("-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qam", "ignore contract dir")
    const { built } = await planThenBuild(tree, "r9", ["--concurrency", "2"])
    assert.equal(built.code, 0, built.stderr)
    const state = JSON.parse(built.stdout)
    assert.equal(state.status, "COMPLETED")
    assert.ok(state.waves.flatMap((wave) => wave.contracts).every((c) => c.status === "PASSED"))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("a Builder that reproduces its previous attempt is escalated: the next rung gets the evidence on a reset worktree and passes", async () => {
  const tree = await project(path.join(fixture, "goal-direct.json"))
  try {
    const result = await orchestrate(tree, ["--run-id", "r14"], { FAKE_PLAN_TEMPLATE: path.join(fixture, "plan-direct.json"), FAKE_FAIL_RUNGS: "1" })
    assert.equal(result.code, 0, result.stderr)
    const state = JSON.parse(result.stdout)
    assert.equal(state.status, "COMPLETED")
    const alpha = state.waves[0].contracts[0]
    assert.equal(alpha.status, "PASSED")
    assert.deepEqual(alpha.attempts.map((item) => [item.attempt, item.rung, item.result, item.repeats]), [[1, 1, "GATE_FAIL", null], [2, 1, "GATE_FAIL", 1], [3, 2, "PASS", null]])
    assert.equal(alpha.escalations.length, 1)
    assert.equal(alpha.escalations[0].from, alpha.attempts[0].configuration_id)
    assert.equal(alpha.escalations[0].to, alpha.attempts[2].configuration_id)
    assert.match(alpha.escalations[0].reason, /no progress: attempt 2 reproduced attempt 1 \(GATE_FAIL\)/)
    assert.equal(alpha.escalations[0].evidence, ".codegen-contract/evidence-rung-2.json")
    assert.deepEqual(state.final_gate.changed_files, ["lib/alpha.py"], "the failing rung's edits were reset before the next rung started")
    const builders = (await readLog(tree)).filter((entry) => entry.agent === "builder")
    assert.deepEqual(builders.map((entry) => entry.rung), [1, 1, 2])
    assert.equal(builders[0].model, builders[1].model)
    assert.notEqual(builders[1].model, builders[2].model)
    assert.ok(builders[2].evidence_exists, "the next rung read the escalation evidence")
    const names = await events(tree, "r14")
    assert.ok(names.includes("RETRY") && names.includes("ESCALATED") && names.includes("CONTRACT_PASSED"))
    const metalog = (await readFile(path.join(tree.directory, "metalog.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    const stops = metalog.filter((entry) => entry.kind === "stop")
    assert.deepEqual(stops.map((entry) => [entry.role, entry.configuration_id, entry.rank]), [["builder", alpha.escalations[0].from, 1]])
    const calls = metalog.filter((entry) => entry.kind === "call" && entry.role === "builder")
    assert.deepEqual(calls.map((entry) => entry.outcome), ["failure", "failure", "success"])
    assert.ok(calls.every((entry) => Array.isArray(entry.ladder) && entry.ladder.length > 1 && entry.rank >= 1))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("when every Builder rung reproduces its attempts the contract fails with the list exhausted", async () => {
  const tree = await project(path.join(fixture, "goal-direct.json"))
  try {
    const result = await orchestrate(tree, ["--run-id", "r16"], { FAKE_PLAN_TEMPLATE: path.join(fixture, "plan-direct.json"), FAKE_FAIL_RUNGS: "*", FAKE_SLEEP_MS: "0" })
    assert.equal(result.code, 1)
    const state = JSON.parse(result.stdout)
    const alpha = state.waves[0].contracts[0]
    assert.equal(alpha.status, "BUILD_FAILED")
    assert.match(alpha.stop, /no progress: .*; no other builder admitted/)
    const rungs = new Set(alpha.attempts.map((item) => item.configuration_id))
    assert.equal(alpha.escalations.length, rungs.size - 1)
    assert.ok(rungs.size >= 5, "every admitted rung was tried")
    assert.ok(alpha.attempts.every((item) => item.result === "GATE_FAIL"))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("a Builder whose attempts keep changing the outcome is retried past two attempts and can still pass", async () => {
  const tree = await project(path.join(fixture, "goal-direct.json"))
  try {
    const result = await orchestrate(tree, ["--run-id", "r15"], { FAKE_PLAN_TEMPLATE: path.join(fixture, "plan-direct.json"), FAKE_FAIL_SEQUENCE: "alpha:scope,gate,pass" })
    assert.equal(result.code, 0, result.stderr)
    const state = JSON.parse(result.stdout)
    assert.equal(state.status, "COMPLETED")
    const alpha = state.waves[0].contracts[0]
    assert.equal(alpha.status, "PASSED")
    assert.deepEqual(alpha.attempts.map((item) => [item.attempt, item.result, item.repeats]), [[1, "SCOPE_FAIL", null], [2, "GATE_FAIL", null], [3, "PASS", null]])
    assert.deepEqual(alpha.attempts[0].summary.outside_scope, ["lib/extra.py"])
    assert.deepEqual(state.final_gate.changed_files, ["lib/alpha.py"], "the file outside the contract was restored before the retry")
    const builders = (await readLog(tree)).filter((entry) => entry.agent === "builder")
    assert.deepEqual(builders.map((entry) => entry.mode), ["scope", "gate", "pass"])
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- Group D

test("D1: an integration conflict keeps its paths, the rest of the wave integrates, and the contract is rebuilt on the new head", async () => {
  const tree = await project()
  try {
    const { built } = await planThenBuild(tree, "d1", ["--concurrency", "1", "--keep-worktrees", "true"], { FAKE_TOUCH_INTEGRATION: "beta" })
    assert.equal(built.code, 0, built.stderr)
    const state = JSON.parse(built.stdout)
    assert.equal(state.status, "COMPLETED")
    const wave1 = state.waves[0]
    assert.equal(wave1.status, "COMPLETED")
    const beta = wave1.contracts.find((c) => c.contract_id === "beta")
    assert.deepEqual(beta.conflict.paths, ["lib/beta.py"])
    assert.equal(beta.conflict.original_commit, beta.result_commit)
    assert.equal(beta.integration_head, null, "the conflicting commit never reached the branch")
    const alpha = wave1.contracts.find((c) => c.contract_id === "alpha")
    assert.ok(alpha.integration_head, "alpha integrated despite beta's conflict")
    // The rebuild: same contract, fresh worktree from the head, conflict as evidence, integrated by the orchestrator.
    const rebuild = state.waves.find((wave) => wave.kind === "rebuild")
    assert.deepEqual(rebuild.phases, ["core"])
    assert.equal(rebuild.status, "COMPLETED")
    const rebuilt = rebuild.contracts[0]
    assert.equal(rebuilt.contract_id, "beta")
    assert.equal(rebuilt.kind, "rebuild")
    assert.equal(rebuilt.parent_contract_id, "beta")
    assert.ok(rebuilt.worktree.endsWith("/worktrees/beta.rebuild-1"))
    assert.equal(rebuilt.base, alpha.integration_head)
    assert.equal(rebuilt.evidence, ".codegen-contract/repair-evidence.json")
    assert.ok(rebuilt.integration_head)
    const evidence = JSON.parse(await readFile(path.join(rebuilt.worktree, ".codegen-contract/repair-evidence.json"), "utf8"))
    assert.equal(evidence.kind, "integration-conflict")
    assert.deepEqual(evidence.conflicting_paths, ["lib/beta.py"])
    assert.match(evidence.original_patch, /return value \+ 3/)
    assert.deepEqual(state.repairs.map((item) => [item.kind, item.contract_id, item.status]), [["rebuild", "beta", "INTEGRATED"]])
    assert.deepEqual(state.integration_sequence.map((item) => item.contract_id), ["alpha", "beta", "gamma"])
    // Gamma built on the rebuilt head; the final gate passed on the whole.
    assert.equal(state.final_gate.result, "PASS")
    assert.equal(state.final_gate_rounds.length, 0)
    const { stdout: beta_py } = await tree.git("show", "codegen/d1:lib/beta.py")
    assert.ok(beta_py.includes("return value + 3"))
    const builders = (await readLog(tree)).filter((entry) => entry.agent === "builder")
    assert.deepEqual(builders.map((entry) => [entry.contract_id, entry.repairing]), [["alpha", false], ["beta", false], ["beta", true], ["gamma", false]])
    assert.ok(builders[2].cwd.endsWith("/worktrees/beta.rebuild-1"))
    const sequence = await events(tree, "d1")
    for (const event of ["INTEGRATION_CONFLICT", "REBUILD_REQUESTED", "INTEGRATED", "FINAL_GATE_PASS"]) assert.ok(sequence.includes(event), `missing ${event}`)
    assert.ok(!sequence.includes("REPLAN_REQUESTED"))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("D2: a final gate failure is attributed by replay, repaired by a composed contract, and the final gate passes again", async () => {
  const tree = await project()
  try {
    const { built } = await planThenBuild(tree, "d2", ["--concurrency", "1", "--keep-worktrees", "true"], {
      FAKE_PLAN_TEMPLATE: path.join(fixture, "plan-interaction.json"),
      FAKE_FAIL_SEQUENCE: "beta:subtle",
    })
    assert.equal(built.code, 0, built.stderr)
    const state = JSON.parse(built.stdout)
    assert.equal(state.status, "COMPLETED")
    // Round 1 failed: alpha's interaction check broke once beta was integrated; the plan command too.
    assert.equal(state.final_gate_rounds.length, 1)
    const round = state.final_gate_rounds[0]
    assert.equal(round.disposition, "REPAIR")
    assert.equal(round.culprit_id, "beta")
    assert.ok(JSON.parse(round.signature).reasons.includes("contract-gate-failed:alpha"))
    const diagnosed = (await readFile(path.join(tree.directory, ".codegen-run/d2/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).find((e) => e.event === "FINAL_GATE_DIAGNOSED")
    assert.equal(diagnosed.kind, "contract-gate")
    assert.deepEqual(diagnosed.replay.map((step) => [step.contract_id, step.pass]), [["alpha", true], ["beta", false], ["gamma", false]])
    // The composed repair contract: culprit first, union of paths, failing check as change, the rest preserved.
    const repairWave = state.waves.find((wave) => wave.kind === "repair")
    const repair = repairWave.contracts[0]
    assert.equal(repair.contract_id, "beta.repair-1")
    assert.equal(repair.parent_contract_id, "beta")
    assert.equal(repair.status, "PASSED")
    const sealed = JSON.parse(await readFile(path.join(repair.worktree, ".codegen-contract/contract.json"), "utf8"))
    assert.deepEqual(sealed.allowed_to_modify, ["lib/beta.py", "lib/alpha.py"])
    assert.deepEqual(sealed.forbidden, ["tests/**", "lib/gamma.py"])
    assert.deepEqual(sealed.requirements.map((r) => [r.id, r.kind]), [["beta.R1", "preserve"], ["alpha.R1", "preserve"], ["alpha.R2", "change"]])
    assert.deepEqual(sealed.verification.checks.map((c) => c.id), ["beta.C1", "alpha.C1", "alpha.C2"])
    assert.deepEqual(repair.gate_readiness.baseline.map((b) => [b.check_id, b.expected, b.exit_code === 0]), [["beta.C1", "pass", true], ["alpha.C1", "pass", true], ["alpha.C2", "fail", false]])
    assert.equal(sealed.repair.failing_contract_id, "alpha")
    assert.deepEqual(sealed.repair.failing_checks, ["C2"])
    const evidence = JSON.parse(await readFile(path.join(repair.worktree, ".codegen-contract/repair-evidence.json"), "utf8"))
    assert.equal(evidence.kind, "final-gate")
    assert.equal(evidence.culprit_id, "beta")
    assert.match(evidence.culprit_patch, /value \+ 4/)
    assert.equal(state.derived_work[0].routing.disposition, "DIRECT_REPAIR")
    assert.deepEqual(state.repairs.map((item) => [item.kind, item.contract_id, item.parent_contract_id, item.status]), [["final-gate", "beta.repair-1", "beta", "INTEGRATED"]])
    // Round 2 passed; the ledger reads the last final gate; the branch holds the repair.
    assert.equal(state.final_gate.result, "PASS")
    assert.deepEqual(state.final_gate.checks.map((check) => [check.contract_id, check.exit_code]), [["alpha", 0], ["beta", 0], ["gamma", 0], ["beta.repair-1", 0], [null, 0]])
    assert.deepEqual(state.goal_coverage.summary, { verified: 2, failed: 0, not_verified: 0, pending_human: 0 })
    assert.deepEqual(state.integration_sequence.map((item) => item.contract_id), ["alpha", "beta", "gamma", "beta.repair-1"])
    const { stdout: count } = await tree.git("rev-list", "--count", "main..codegen/d2")
    assert.equal(count.trim(), "4")
    const builders = (await readLog(tree)).filter((entry) => entry.agent === "builder")
    assert.deepEqual(builders.map((entry) => [entry.contract_id, entry.mode]), [["alpha", "pass"], ["beta", "subtle"], ["gamma", "pass"], ["beta.repair-1", "pass"]])
    const sequence = await events(tree, "d2")
    for (const event of ["FINAL_GATE_FAIL", "FINAL_GATE_DIAGNOSED", "REPAIR_CONTRACT", "FINAL_GATE_PASS", "RUN_COMPLETED"]) assert.ok(sequence.includes(event), `missing ${event}`)
    assert.ok(!sequence.includes("REPLAN_REQUESTED"))
    await assert.rejects(access(path.join(tree.directory, ".codegen-run/d2/diagnosis")), "the diagnosis worktree is removed")
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("D2: when the composed repair is blocked the Planner writes a repair plan, the run pauses for review, and resumes on the integration head", async () => {
  const tree = await project()
  try {
    const env = { FAKE_PLAN_TEMPLATE: path.join(fixture, "plan-interaction.json"), FAKE_FAIL_SEQUENCE: "beta:subtle", FAKE_REPAIR_MODE: "blocked" }
    const { built } = await planThenBuild(tree, "d3", ["--concurrency", "1"], env)
    assert.equal(built.code, 0, built.stderr)
    const paused = JSON.parse(built.stdout)
    assert.equal(paused.status, "PLAN_REVIEW_REQUIRED")
    assert.equal(paused.pending_plan.round, 1)
    assert.equal(paused.pending_plan.plan_path, ".codegen-run/d3/integration/.codegen-plan/d3-repair-1.json")
    assert.equal(paused.pending_plan.plan_markdown, ".codegen-run/d3/integration/.codegen-plan/d3-repair-1.md")
    assert.match(paused.stop_reason, /--resume d3/)
    const repairContract = paused.waves.find((wave) => wave.kind === "repair").contracts[0]
    assert.equal(repairContract.status, "REPLAN_REQUIRED")
    assert.equal(paused.repairs[0].status, "REPLAN_REQUIRED")
    const headBefore = paused.integration_head
    // The Planner worked inside the integration worktree with the repair evidence and the Goal.
    const planners = (await readLog(tree)).filter((entry) => entry.agent === "planner")
    assert.equal(planners.length, 2)
    assert.equal(planners[1].repairing, true)
    assert.ok(planners[1].cwd.endsWith("/.codegen-run/d3/integration"))
    assert.match(planners[1].prompt, /Read the evidence at \.codegen-plan\/d3-repair-1\.evidence\.json/)
    const evidence = JSON.parse(await readFile(path.join(tree.directory, ".codegen-run/d3/integration/.codegen-plan/d3-repair-1.evidence.json"), "utf8"))
    assert.equal(evidence.kind, "repair")
    assert.equal(evidence.integration_head, headBefore)
    assert.deepEqual(evidence.approved_footprint, ["lib/alpha.py", "lib/beta.py", "lib/gamma.py"])
    assert.match(evidence.reason, /beta\.repair-1 failed: CONTRACT_BLOCKED/)
    const markdown = await readFile(path.join(tree.directory, paused.pending_plan.plan_markdown), "utf8")
    assert.ok(markdown.includes("`beta-fix`"), markdown)
    // The user's checkout and the integration branch are untouched by the pause.
    assert.equal((await tree.git("status", "--porcelain")).stdout.trim(), "")
    assert.equal((await tree.git("rev-parse", "codegen/d3")).stdout.trim(), headBefore)

    // Resume: the repair plan builds on the integration head, integrates, and the final gate passes.
    const resumed = await orchestrate(tree, ["--resume", "d3", "--concurrency", "1", "--keep-worktrees", "true"], env)
    assert.equal(resumed.code, 0, resumed.stderr)
    const state = JSON.parse(resumed.stdout)
    assert.equal(state.status, "COMPLETED")
    assert.equal(state.resumed, 1)
    assert.equal(state.pending_plan, null)
    assert.deepEqual(state.repair_plans.map((item) => [item.round, item.plan_id, item.reviewed]), [[1, "repair-beta", true]])
    const fixWave = state.waves.find((wave) => wave.kind === "repair-plan")
    assert.deepEqual(fixWave.phases, ["fix"])
    assert.equal(fixWave.base, headBefore)
    assert.equal(fixWave.contracts[0].contract_id, "beta-fix")
    assert.equal(fixWave.contracts[0].status, "PASSED")
    assert.deepEqual(state.integration_sequence.map((item) => item.contract_id), ["alpha", "beta", "gamma", "beta-fix"])
    assert.equal(state.final_gate_rounds.length, 1)
    assert.equal(state.final_gate.result, "PASS")
    assert.deepEqual(state.goal_coverage.summary, { verified: 2, failed: 0, not_verified: 0, pending_human: 0 })
    assert.ok(state.goal_coverage.requirements[0].claims.some((claim) => claim.contract_id === "beta-fix" && claim.status === "VERIFIED"), "the repair plan's contract appears in the ledger")
    const { stdout: beta_py } = await tree.git("show", "codegen/d3:lib/beta.py")
    assert.ok(beta_py.includes("return value + 3"))
    const sequence = await events(tree, "d3")
    for (const event of ["FINAL_GATE_FAIL", "REPAIR_CONTRACT", "REPLAN_REQUESTED", "PLAN_REQUESTED", "RUN_STOPPED", "RUN_RESUMED", "FINAL_GATE_PASS", "RUN_COMPLETED"]) assert.ok(sequence.includes(event), `missing ${event}`)
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("resume refuses a run that is not paused for a repair plan or whose branch moved", async () => {
  const tree = await project(path.join(fixture, "goal-direct.json"))
  try {
    const done = await orchestrate(tree, ["--run-id", "d4"], { FAKE_PLAN_TEMPLATE: path.join(fixture, "plan-direct.json") })
    assert.equal(done.code, 0, done.stderr)
    const refused = await orchestrate(tree, ["--resume", "d4"])
    assert.equal(refused.code, 1)
    assert.equal(JSON.parse(refused.stdout).status, "RESUME_FAILED")
    const missing = await orchestrate(tree, ["--resume", "nope"])
    assert.equal(JSON.parse(missing.stdout).status, "RESUME_FAILED")
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})
