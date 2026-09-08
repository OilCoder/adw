import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const execFile = promisify(execFileCallback)
const here = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(here, "..")
const fixtures = path.join(here, "fixtures/goal-research")

// Fake advisors answer by model family from FAKE_POSITIONS (json map); the
// fake reconciler writes a decision that cites the opinion files it was given.
const fakeOpenCode = `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const argv = process.argv
const model = argv[argv.indexOf("--model") + 1]
const agent = argv[argv.indexOf("--agent") + 1]
const prompt = argv[argv.length - 1]
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ model, agent }) + "\\n")
const question = "Application check or database constraint?"
const options = ["application-check", "database-constraint"]
if (agent === "advisor") {
  const [, output, opinionId] = prompt.match(/Write the opinion to (\\S+) with opinion_id "([^"]+)"/)
  const family = opinionId.split("-").pop()
  const positions = JSON.parse(process.env.FAKE_POSITIONS)
  const position = positions[family] ?? positions.default
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify({ schema_version: 1, opinion_id: opinionId, question_id: "OQ-1", question, options, position, ...(position === "OTHER" ? { alternative: "unique index plus retry" } : {}), rationale: family + " says " + position, evidence: ["src/users/service.ts"], risks: [family + " risk"], confidence: "high" }))
} else if (agent === "reconciler") {
  const [, output, decisionId] = prompt.match(/Write the proposed decision to (\\S+) with decision_id "([^"]+)"/)
  const files = prompt.match(/Opinion files: (.+)\\./)[1].split(", ")
  const opinions = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")))
  const chosen = "database-constraint"
  const rejected = opinions.filter((o) => o.position !== chosen).map((o) => ({ position: o.position === "OTHER" ? "OTHER:" + o.alternative : o.position, opinion_ids: [o.opinion_id], why_rejected: "weaker under concurrency" }))
  fs.writeFileSync(output, JSON.stringify({ schema_version: 1, decision_id: decisionId, question_id: "OQ-1", question, status: "PROPOSED", method: "reconciled", chosen, rationale: "Race-free", opinion_ids: opinions.map((o) => o.opinion_id), rejected }))
}
console.log(JSON.stringify({type:"step_finish",part:{cost:0.01,tokens:{input:10,output:10,reasoning:0,cache:{read:0,write:0}}}}))
`

async function worktree() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opinions-cli-"))
  const bin = path.join(directory, "bin")
  await mkdir(bin)
  await writeFile(path.join(bin, "opencode"), fakeOpenCode, { mode: 0o755 })
  const goal = JSON.parse(await readFile(path.join(fixtures, "goal.json"), "utf8"))
  goal.open_questions = [
    { id: "OQ-1", question: "Application check or database constraint?", blocking: true, options: ["application-check", "database-constraint"] },
    { id: "OQ-2", question: "Which error code?", blocking: false },
  ]
  await mkdir(path.join(directory, ".codegen-goal"))
  await writeFile(path.join(directory, ".codegen-goal/goal.json"), JSON.stringify(goal))
  await writeFile(path.join(directory, ".gitignore"), "bin/\nfake.log\n.codegen-goal/\n.codegen-opinions/\n")
  const git = (...args) => execFile("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { cwd: directory })
  await git("init", "-q", "-b", "main")
  await git("add", ".")
  await git("commit", "-q", "-m", "baseline")
  return { directory, bin }
}

function run(tree, args, positions) {
  return execFile(process.execPath, [path.join(systemRoot, ".opencode/codegen/scripts/run-opinions.mjs"), ...args], {
    cwd: tree.directory,
    env: { ...process.env, PATH: `${tree.bin}${path.delimiter}${process.env.PATH}`, FAKE_LOG: path.join(tree.directory, "fake.log"), CODEGEN_METALOG: path.join(tree.directory, "metalog.jsonl"), FAKE_POSITIONS: JSON.stringify(positions) },
  }).then(
    (result) => ({ code: 0, ...result }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  )
}

test("unanimous advisors from distinct families produce a proposal without a reconciler call", async () => {
  const tree = await worktree()
  try {
    const result = await run(tree, ["--question", "OQ-1"], { default: "database-constraint" })
    assert.equal(result.code, 0, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.result, "DECISION_PROPOSED")
    assert.equal(summary.reconciliation.status, "UNANIMOUS")
    const families = summary.attempts.map((attempt) => [attempt.role, attempt.configuration.family])
    assert.equal(families.length, 2)
    assert.ok(families.every(([role]) => role === "advisor"))
    assert.equal(new Set(families.map(([, family]) => family)).size, 2)
    const decision = JSON.parse(await readFile(path.join(tree.directory, summary.decision), "utf8"))
    assert.equal(decision.method, "unanimous")
    assert.equal(decision.chosen, "database-constraint")
    const markdown = await readFile(path.join(tree.directory, ".codegen-opinions/OQ-1/DECISION.md"), "utf8")
    assert.ok(markdown.startsWith("# Decision: Application check"))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("divergent advisors go to a reconciler from a third family", async () => {
  const tree = await worktree()
  try {
    const result = await run(tree, ["--question", "OQ-1"], { gpt: "database-constraint", mimo: "OTHER", default: "application-check" })
    assert.equal(result.code, 0, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.result, "DECISION_PROPOSED")
    assert.equal(summary.reconciliation.status, "DIVERGENT")
    const roles = summary.attempts.map((attempt) => attempt.role)
    assert.deepEqual(roles, ["advisor", "advisor", "reconciler"])
    const families = summary.attempts.map((attempt) => attempt.configuration.family)
    assert.equal(new Set(families).size, 3)
    const decision = JSON.parse(await readFile(path.join(tree.directory, summary.decision), "utf8"))
    assert.equal(decision.method, "reconciled")
    assert.equal(decision.rejected.length, 1)
    assert.ok(decision.rejected[0].position.startsWith("OTHER:"))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("questions without a closed option set are refused before any model call", async () => {
  const tree = await worktree()
  try {
    const result = await run(tree, ["--question", "OQ-2"], {})
    assert.equal(result.code, 2)
    assert.match(result.stderr, /no closed option set/)
    await assert.rejects(readFile(path.join(tree.directory, "fake.log")))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})
