import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const execFile = promisify(execFileCallback)
const here = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(here, "..")
const fixtures = path.join(here, "fixtures/goal-research")

// A fake `opencode` binary that writes the fixture named by FAKE_OUTPUT_FIXTURE
// to the output path it finds in the prompt, or reports an empty Zen balance.
const fakeOpenCode = `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const argv = process.argv
const model = argv[argv.indexOf("--model") + 1]
const agent = argv[argv.indexOf("--agent") + 1]
const prompt = argv[argv.length - 1]
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ model, agent, prompt, exa: process.env.OPENCODE_ENABLE_EXA ?? null }) + "\\n")
if (process.env.FAKE_ZEN_EMPTY && model.startsWith("opencode-go/")) {
  console.log(JSON.stringify({type:"error",error:{name:"APIError",data:{statusCode:402,message:"Insufficient credit balance. Add credits to continue.",isRetryable:false}}}))
  process.exit(1)
}
const target = prompt.match(/(?:report|Goal) to (\\S+?)(?: with|\\.\\n|\\.$|$)/m)[1]
fs.mkdirSync(path.dirname(target), { recursive: true })
if (process.env.FAKE_OUTPUT_FIXTURE) fs.copyFileSync(process.env.FAKE_OUTPUT_FIXTURE, target)
console.log(JSON.stringify({type:"step_finish",part:{cost:0.01,tokens:{input:10,output:10,reasoning:0,cache:{read:0,write:0}}}}))
`

async function worktree() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "goal-research-cli-"))
  const bin = path.join(directory, "bin")
  await mkdir(bin)
  await writeFile(path.join(bin, "opencode"), fakeOpenCode, { mode: 0o755 })
  await mkdir(path.join(directory, ".codegen-goal"), { recursive: true })
  await cp(path.join(fixtures, "goal.json"), path.join(directory, ".codegen-goal/goal.json"))
  // Runners refuse to start without a Git HEAD; the Goal itself stays untracked.
  await writeFile(path.join(directory, ".gitignore"), "bin/\nfake.log\n.codegen-goal/\n.codegen-research/\n")
  const git = (...args) => execFile("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { cwd: directory })
  await git("init", "-q", "-b", "main")
  await git("add", ".")
  await git("commit", "-q", "-m", "baseline")
  return { directory, bin }
}

function run(script, args, { directory, bin }, env = {}) {
  return execFile("node", [path.join(systemRoot, ".opencode/codegen/scripts", script), ...args], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_LOG: path.join(directory, "fake.log"),
      ...env,
    },
  }).then(
    (result) => ({ code: 0, ...result }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  )
}

test("run-researcher runs one admitted configuration, validates, and renders the report", async () => {
  const tree = await worktree()
  try {
    const result = await run("run-researcher.mjs", ["--question", "RQ-1", "--minimum-status", "candidate", "--source-verification", "offline"], tree, {
      FAKE_OUTPUT_FIXTURE: path.join(fixtures, "report.json"),
    })
    assert.equal(result.code, 0, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.result, "COMPLETE")
    assert.equal(summary.user_action, null)
    assert.equal(summary.verification.mode, "offline")
    assert.equal(summary.answers, true)
    const stored = JSON.parse(await readFile(path.join(tree.directory, ".codegen-research/RQ-1.json"), "utf8"))
    assert.equal(stored.verification.mode, "offline")
    assert.equal(summary.attempts.length, 1)
    assert.equal(summary.attempts[0].configuration.provider, "opencode-go")
    assert.equal(summary.markdown, ".codegen-research/RQ-1.md")
    const markdown = await readFile(path.join(tree.directory, ".codegen-research/RQ-1.md"), "utf8")
    assert.ok(markdown.startsWith("# Research: Does the ORM support"))
    assert.ok(markdown.includes("**Source verification:** `offline`"))
    assert.ok(markdown.includes("> Unique constraints raise IntegrityError when a duplicate value is inserted."))
    const log = JSON.parse((await readFile(path.join(tree.directory, "fake.log"), "utf8")).trim())
    assert.equal(log.agent, "researcher")
    assert.ok(log.prompt.includes("verbatim quote"))
    assert.equal(log.exa, "1")
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("run-researcher rejects a report that does not answer the Goal question", async () => {
  const tree = await worktree()
  try {
    const mismatched = path.join(tree.directory, "mismatched.json")
    const report = JSON.parse(await readFile(path.join(fixtures, "report.json"), "utf8"))
    await writeFile(mismatched, JSON.stringify({ ...report, question_id: "RQ-9" }))
    const result = await run("run-researcher.mjs", ["--question", "RQ-1", "--minimum-status", "candidate", "--source-verification", "offline"], tree, {
      FAKE_OUTPUT_FIXTURE: mismatched,
    })
    assert.equal(result.code, 1)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.result, "REPORT_INVALID")
    assert.ok(summary.validation.errors.includes("question_id does not match Goal"))
    assert.equal(summary.markdown, null)
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("run-researcher refuses questions that are not pending and does not call the model", async () => {
  const tree = await worktree()
  try {
    const goalPath = path.join(tree.directory, ".codegen-goal/goal.json")
    const goal = JSON.parse(await readFile(goalPath, "utf8"))
    goal.research_questions[0].status = "completed"
    await writeFile(goalPath, JSON.stringify(goal))
    const result = await run("run-researcher.mjs", ["--question", "RQ-1", "--minimum-status", "candidate"], tree)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /is completed, not pending/)
    await assert.rejects(readFile(path.join(tree.directory, "fake.log")))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("run-goal stops and requests a recharge when the Zen balance is exhausted", async () => {
  const tree = await worktree()
  try {
    await rm(path.join(tree.directory, ".codegen-goal"), { recursive: true })
    await mkdir(path.join(tree.directory, ".codegen-research"))
    await cp(path.join(fixtures, "report.json"), path.join(tree.directory, ".codegen-research/RQ-1.json"))
    const result = await run(
      "run-goal.mjs",
      ["--intent", "Reject duplicate emails", "--reports", ".codegen-research/RQ-1.json", "--minimum-status", "candidate"],
      tree,
      { FAKE_OUTPUT_FIXTURE: path.join(fixtures, "goal.json"), FAKE_ZEN_EMPTY: "1" },
    )
    assert.equal(result.code, 1, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.result, "ZEN_BALANCE_EXHAUSTED")
    assert.match(summary.user_action, /Recharge the Zen balance/)
    assert.equal(summary.attempts.length, 1)
    assert.equal(summary.attempts[0].configuration.provider, "opencode-go")
    assert.equal(summary.markdown, null)
    assert.equal(summary.routing, null)
    assert.deepEqual(summary.research_reports, [
      { path: ".codegen-research/RQ-1.json", report_id: "RR-1", question_id: "RQ-1", status: "COMPLETE", answers: true, unverified_findings: [] },
    ])
    const calls = (await readFile(path.join(tree.directory, "fake.log"), "utf8")).trim().split("\n").map(JSON.parse)
    assert.equal(calls.length, 1)
    assert.ok(calls.every((call) => call.agent === "goal-manager"))
    assert.ok(calls[0].prompt.includes("RR-1, answers RQ-1"))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("run-goal rejects a model-sealed Goal unless the user approved sealing", async () => {
  const tree = await worktree()
  try {
    await rm(path.join(tree.directory, ".codegen-goal"), { recursive: true })
    const goal = JSON.parse(await readFile(path.join(fixtures, "goal.json"), "utf8"))
    const sealedFixture = path.join(tree.directory, "sealed.json")
    await writeFile(
      sealedFixture,
      JSON.stringify({
        ...goal,
        status: "SEALED",
        research_questions: goal.research_questions.map((item) => ({ ...item, status: "completed" })),
        decisions: [
          { id: "DEC-1", question: "q", decision: "d", rationale: "r", research_report_ids: ["RR-1"] },
        ],
      }),
    )
    const rejected = await run("run-goal.mjs", ["--intent", "x", "--minimum-status", "candidate"], tree, {
      FAKE_OUTPUT_FIXTURE: sealedFixture,
    })
    assert.equal(rejected.code, 1)
    const summary = JSON.parse(rejected.stdout)
    assert.equal(summary.result, "SEALED_WITHOUT_APPROVAL")
    assert.equal(summary.routing, null)
    assert.equal(summary.markdown, null)

    await rm(path.join(tree.directory, ".codegen-goal"), { recursive: true })
    const approved = await run(
      "run-goal.mjs",
      ["--intent", "x", "--minimum-status", "candidate", "--allow-sealed", "true"],
      tree,
      { FAKE_OUTPUT_FIXTURE: sealedFixture },
    )
    assert.equal(approved.code, 0, approved.stderr)
    const approvedSummary = JSON.parse(approved.stdout)
    assert.equal(approvedSummary.result, "SEALED")
    assert.equal(approvedSummary.routing.route, "planned")
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("run-goal refuses to overwrite an existing Goal and rejects invalid research evidence", async () => {
  const tree = await worktree()
  try {
    const existing = await run("run-goal.mjs", ["--intent", "x", "--minimum-status", "candidate"], tree)
    assert.equal(existing.code, 2)
    assert.match(existing.stderr, /Goal output already exists/)

    await writeFile(path.join(tree.directory, "bad.json"), JSON.stringify({ schema_version: 1 }))
    const invalid = await run(
      "run-goal.mjs",
      ["--intent", "x", "--output", ".codegen-goal/other.json", "--reports", "bad.json", "--minimum-status", "candidate"],
      tree,
    )
    assert.equal(invalid.code, 2)
    assert.match(invalid.stderr, /Research report bad.json is invalid/)
    await assert.rejects(readFile(path.join(tree.directory, "fake.log")))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("run-goal --approve seals the drafted Goal deterministically without a model call", async () => {
  const tree = await worktree()
  try {
    const goalPath = path.join(tree.directory, ".codegen-goal/goal.json")
    const goal = JSON.parse(await readFile(goalPath, "utf8"))
    goal.status = "DECIDED"
    goal.research_questions = goal.research_questions.map((item) => ({ ...item, status: "completed" }))
    goal.decisions = [{ id: "DEC-1", question: "q", decision: "d", rationale: "r", research_report_ids: ["RR-1"] }]
    await writeFile(goalPath, JSON.stringify(goal))

    const result = await run("run-goal.mjs", ["--approve", ".codegen-goal/goal.json"], tree)
    assert.equal(result.code, 0, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.result, "SEALED")
    assert.equal(summary.previous_status, "DECIDED")
    assert.equal(summary.routing.status, "ROUTED")
    assert.equal(JSON.parse(await readFile(goalPath, "utf8")).status, "SEALED")
    assert.ok((await readFile(path.join(tree.directory, ".codegen-goal/GOAL.md"), "utf8")).startsWith("# "))
    await assert.rejects(readFile(path.join(tree.directory, "fake.log")))

    // A Goal that still needs research cannot be approved into a sealed state.
    goal.status = "DRAFT"
    goal.research_questions = goal.research_questions.map((item) => ({ ...item, status: "pending" }))
    await writeFile(goalPath, JSON.stringify(goal))
    const refused = await run("run-goal.mjs", ["--approve", ".codegen-goal/goal.json"], tree)
    assert.equal(refused.code, 2)
    assert.match(refused.stderr, /required pending research/)
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("runners refuse to start without a Git HEAD", async () => {
  const tree = await worktree()
  try {
    await rm(path.join(tree.directory, ".git"), { recursive: true, force: true })
    const result = await run("run-researcher.mjs", ["--question", "RQ-1", "--minimum-status", "candidate"], tree, {
      FAKE_OUTPUT_FIXTURE: path.join(fixtures, "report.json"),
    })
    assert.equal(result.code, 2)
    assert.match(result.stderr, /GIT_HEAD_REQUIRED/)
    await assert.rejects(readFile(path.join(tree.directory, "fake.log")))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})
