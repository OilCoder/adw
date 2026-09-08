import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const execFile = promisify(execFileCallback)
const here = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(here, "..")
const fixtures = path.join(here, "fixtures")

// One fake `opencode` for the whole deliberative route: the researcher copies
// the fixture report, advisors answer from FAKE_POSITIONS, the reconciler
// cites the opinions it was given, and the goal-manager revises the Goal from
// the evidence named in its prompt (FAKE_REVISION_* injects bad revisions).
const fakeOpenCode = `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const argv = process.argv
const agent = argv[argv.indexOf("--agent") + 1]
const prompt = argv[argv.length - 1]
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ agent, attach: argv.includes("--attach") }) + "\\n")
function done() { console.log(JSON.stringify({type:"step_finish",part:{cost:0.01,tokens:{input:10,output:10,reasoning:0,cache:{read:0,write:0}}}})) }
if (agent === "researcher") {
  const target = prompt.match(/report to (\\S+) with/)[1]
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(process.env.FAKE_REPORT, target)
} else if (agent === "advisor") {
  const [, output, opinionId] = prompt.match(/Write the opinion to (\\S+) with opinion_id "([^"]+)"/)
  const family = opinionId.split("-").pop()
  const positions = JSON.parse(process.env.FAKE_POSITIONS || "{}")
  const position = positions[family] ?? "database-constraint"
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify({ schema_version: 1, opinion_id: opinionId, question_id: "OQ-1", question: "Application check or database constraint?", options: ["application-check", "database-constraint"], position, rationale: family + " says " + position, evidence: ["src/users/service.ts"], risks: ["r"], confidence: "high" }))
} else if (agent === "reconciler") {
  const [, output, decisionId] = prompt.match(/Write the proposed decision to (\\S+) with decision_id "([^"]+)"/)
  const files = prompt.match(/Opinion files: (.+)\\./)[1].split(", ")
  const opinions = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")))
  const chosen = "database-constraint"
  const rejected = opinions.filter((o) => o.position !== chosen).map((o) => ({ position: o.position, opinion_ids: [o.opinion_id], why_rejected: "weaker" }))
  fs.writeFileSync(output, JSON.stringify({ schema_version: 1, decision_id: decisionId, question_id: "OQ-1", question: "Application check or database constraint?", status: "PROPOSED", method: "reconciled", chosen, rationale: "Race-free", opinion_ids: opinions.map((o) => o.opinion_id), rejected }))
} else if (agent === "goal-manager") {
  const goalPath = prompt.match(/Revise the existing Goal at (\\S+):/)[1]
  const goal = JSON.parse(fs.readFileSync(goalPath, "utf8"))
  for (const m of prompt.matchAll(/(\\S+) \\((RR-[^,]+), answers (RQ-[^,]+), (\\w+)\\)/g)) {
    const q = goal.research_questions.find((item) => item.id === m[3])
    q.status = "completed"
    goal.decisions.push({ id: "D-" + m[3], question: q.question, decision: "Use the database constraint", rationale: "per report", research_report_ids: [m[2]] })
  }
  for (const m of prompt.matchAll(/(\\S+) \\((DEC-\\S+) on (OQ-\\S+) chose "([^"]+)"\\)/g)) {
    const decision = JSON.parse(fs.readFileSync(m[1], "utf8"))
    const q = goal.open_questions.find((item) => item.id === m[3])
    q.blocking = false
    if (!process.env.FAKE_REVISION_SKIP_DECISION) goal.decisions.push({ id: "D-" + m[3], question: decision.question, decision: decision.chosen, rationale: decision.rationale, research_report_ids: [], opinion_ids: decision.opinion_ids })
  }
  const guidance = prompt.match(/User guidance for this revision: (.+)/)
  if (guidance) {
    for (const q of goal.open_questions.filter((item) => item.blocking)) {
      q.blocking = false
      goal.decisions.push({ id: "D-user-" + q.id, question: q.question, decision: guidance[1], rationale: "user answer", research_report_ids: [] })
    }
  }
  goal.status = process.env.FAKE_REVISION_SEALED ? "SEALED" : "DECIDED"
  fs.writeFileSync(goalPath, JSON.stringify(goal, null, 2))
}
done()
`

async function project({ openQuestions = [], goalOverrides = {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deliberate-cli-"))
  const bin = path.join(directory, "bin")
  await mkdir(bin)
  await writeFile(path.join(bin, "opencode"), fakeOpenCode, { mode: 0o755 })
  const goal = { ...JSON.parse(await readFile(path.join(fixtures, "goal-research/goal.json"), "utf8")), open_questions: openQuestions, ...goalOverrides }
  await mkdir(path.join(directory, ".codegen-goal"))
  await writeFile(path.join(directory, ".codegen-goal/goal.json"), JSON.stringify(goal, null, 2))
  await writeFile(path.join(directory, ".gitignore"), "bin/\nfake.log\n.codegen-goal/\n.codegen-research/\n.codegen-opinions/\n")
  const git = (...args) => execFile("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { cwd: directory })
  await git("init", "-q", "-b", "main")
  await git("add", ".")
  await git("commit", "-q", "-m", "baseline")
  return { directory, bin }
}

function run(script, args, { directory, bin }, env = {}) {
  return execFile(process.execPath, [path.join(systemRoot, ".opencode/codegen/scripts", script), "--source-verification", "offline", ...args], {
    cwd: directory,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_LOG: path.join(directory, "fake.log"), CODEGEN_METALOG: path.join(directory, "metalog.jsonl"), FAKE_REPORT: path.join(fixtures, "goal-research/report.json"), ...env },
    maxBuffer: 16 * 1024 * 1024,
  }).then(
    (result) => ({ code: 0, ...result }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  )
}

async function agents(tree) {
  return (await readFile(path.join(tree.directory, "fake.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).agent)
}

const blockingWithOptions = { id: "OQ-1", question: "Application check or database constraint?", blocking: true, options: ["application-check", "database-constraint"] }

test("deliberate: research, unanimous opinions, and a verified revision leave the Goal ready for approval", async () => {
  const tree = await project({ openQuestions: [blockingWithOptions] })
  try {
    const result = await run("deliberate.mjs", [], tree)
    assert.equal(result.code, 0, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.result, "DECIDED")
    assert.deepEqual(summary.plan.research, ["RQ-1"])
    assert.deepEqual(summary.plan.opinions, ["OQ-1"])
    assert.equal(summary.research[0].result, "COMPLETE")
    assert.equal(summary.opinions[0].result, "DECISION_PROPOSED")
    assert.equal(summary.revision.result, "DECIDED")
    assert.equal(summary.ready_for_approval, true)
    assert.deepEqual(await agents(tree), ["researcher", "advisor", "advisor", "goal-manager"], "unanimous advisors need no reconciler")
    await access(path.join(tree.directory, summary.revision.backup))
    const goal = JSON.parse(await readFile(path.join(tree.directory, ".codegen-goal/goal.json"), "utf8"))
    assert.equal(goal.status, "DECIDED")
    assert.equal(goal.research_questions[0].status, "completed")
    assert.equal(goal.open_questions[0].blocking, false)
    assert.ok(goal.decisions.some((d) => (d.opinion_ids ?? []).length === 2))

    // The user now seals it, deterministically, and the Router accepts it.
    const approved = await run("run-goal.mjs", ["--approve", ".codegen-goal/goal.json"], tree)
    assert.equal(approved.code, 0, approved.stderr)
    const sealed = JSON.parse(approved.stdout)
    assert.equal(sealed.result, "SEALED")
    assert.equal(sealed.routing.status, "ROUTED")
    assert.ok(sealed.routing.reasons.includes("deliberation-recorded"))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("deliberate: divergent advisors go to the reconciler before the revision", async () => {
  const tree = await project({ openQuestions: [blockingWithOptions] })
  try {
    const result = await run("deliberate.mjs", [], tree, { FAKE_POSITIONS: JSON.stringify({ default: "database-constraint", mimo: "application-check" }) })
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.result, "DECIDED", result.stderr)
    const called = await agents(tree)
    assert.ok(called.includes("reconciler"), called.join(","))
    assert.equal(called.at(-1), "goal-manager")
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("deliberate: a blocking question without options is the user's decision; no model runs", async () => {
  const tree = await project({ openQuestions: [{ id: "OQ-9", question: "Which colour?", blocking: true }] })
  try {
    const result = await run("deliberate.mjs", [], tree)
    assert.equal(result.code, 1)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.result, "USER_DECISION_REQUIRED")
    assert.deepEqual(summary.plan.user_decisions, ["OQ-9"])
    await assert.rejects(readFile(path.join(tree.directory, "fake.log")))

    // The user's answer is folded in through a revision with guidance.
    const revised = await run("run-goal.mjs", ["--revise", ".codegen-goal/goal.json", "--intent", "Use blue"], tree)
    assert.equal(revised.code, 0, revised.stderr)
    const goal = JSON.parse(await readFile(path.join(tree.directory, ".codegen-goal/goal.json"), "utf8"))
    assert.equal(goal.open_questions[0].blocking, false)
    assert.ok(goal.decisions.some((d) => d.decision === "Use blue"))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("deliberate: a revision that drops a proposed decision or seals the Goal is rejected", async () => {
  const tree = await project({ openQuestions: [blockingWithOptions] })
  try {
    const dropped = await run("deliberate.mjs", [], tree, { FAKE_REVISION_SKIP_DECISION: "1" })
    assert.equal(dropped.code, 1)
    const summary = JSON.parse(dropped.stdout)
    assert.equal(summary.result, "REVISION_INVALID")
    assert.ok(summary.verification.errors.some((e) => e.includes("not recorded")), JSON.stringify(summary.verification))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
  const sealedTree = await project({ openQuestions: [blockingWithOptions] })
  try {
    const sealed = await run("deliberate.mjs", [], sealedTree, { FAKE_REVISION_SEALED: "1" })
    assert.equal(sealed.code, 1)
    const summary = JSON.parse(sealed.stdout)
    assert.equal(summary.result, "REVISION_INVALID")
    assert.equal(summary.revision.result, "SEALED_WITHOUT_APPROVAL")
  } finally {
    await rm(sealedTree.directory, { recursive: true, force: true })
  }
})

test("deliberate: nothing open means nothing to deliberate", async () => {
  const tree = await project({ goalOverrides: { research_questions: [], routing: { change_shape: "localized", risk: "low", existing_gate: true, architecture_uncertainty: false, external_research_required: false } } })
  try {
    const result = await run("deliberate.mjs", [], tree)
    assert.equal(result.code, 0, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.result, "NOTHING_TO_DELIBERATE")
    assert.equal(summary.ready_for_approval, true)
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})
