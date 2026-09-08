#!/usr/bin/env node

// Certification of one model + provider + role + harness combination.
//
//   certify.mjs check [--minimum-status qualified]
//   certify.mjs status
//   certify.mjs run --role <role> --configuration <id> [--with a,b] [--display inline] [--timeout <s>]
//
// `run` copies a fixture into a throwaway Git repository, executes the real
// runner for the role with the pinned configuration, validates the artifact
// deterministically, and records the verdict under admission.roles in
// config/model-pools.json. Only this process writes a qualified entry, and it
// only runs inside the harness repository; installed projects never see it.

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { resolveDisplay, runAgentProcess } from "../lib/agent-run.mjs"
import { certificationSummary, checkRelease, recordCertification, roleSchemaHash } from "../lib/certification.mjs"
import { exists, isInstalledProject, loadRegistry, newRunId, parseArguments } from "../lib/cli.mjs"
import { materializeGate } from "../lib/gate.mjs"
import { ROLES } from "../lib/model-selection.mjs"
import { validateDecision, validateOpinion } from "../lib/opinions.mjs"
import { runProcess } from "../lib/process.mjs"
import { summarizeEvents } from "../lib/run-metrics.mjs"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(scriptDirectory, "../../..")
const registryFile = path.join(systemRoot, ".opencode/codegen/config/model-pools.json")
const fixtures = path.join(systemRoot, "tests/fixtures")

const GOAL_INTENT =
  "Add a function safe_divide(dividend, divisor) to calculator.py that returns the float division and raises ValueError with the exact message 'divisor must not be zero' when the divisor is zero. Keep the public function signature. The acceptance criterion is that tests/test_calculator.py passes. Everything needed is in this repository; no external research and no product decisions are pending."

// The Researcher is certified on a question answerable from official sources,
// unlike the fixture's ORM question, which has no ORM to inspect.
const RESEARCH_QUESTION = {
  id: "RQ-1",
  question: "According to the official Node.js release schedule, on which date does Node.js 22 reach End-of-Life, and on which date did it enter Active LTS?",
  why_needed: "Certification of the Researcher role needs a bounded question with an authoritative public answer.",
  required: true,
  status: "pending",
  allowed_source_types: ["official", "independent"],
  budget: { max_sources: 3, max_minutes: 10 },
}

const OPEN_QUESTION = {
  id: "OQ-1",
  question: "Application check or database constraint?",
  blocking: true,
  options: ["application-check", "database-constraint"],
}

function usage() {
  return "usage: certify.mjs check | status | run --role <role> --configuration <id> [--with a,b] [--display inline|tui] [--timeout <seconds>]"
}

async function git(directory, args) {
  const result = await runProcess("git", ["-c", "user.name=OpenCode Certification", "-c", "user.email=certify@localhost", ...args], {
    cwd: directory,
    timeoutSeconds: 60,
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

// The throwaway project carries the OpenCode layer the agents need: agents,
// instructions, schemas, and the provider configuration. Tools stay out; the
// runners never call them.
async function project(fixtureName, { extraIgnores = [] } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `certify-${fixtureName}-`))
  await cp(path.join(fixtures, fixtureName), directory, { recursive: true })
  // Test-only helpers (canned solutions, plan templates) never reach the model.
  for (const entry of ["solutions", "plan-template.json", "plan-direct.json", "goal-direct.json"]) {
    await rm(path.join(directory, entry), { recursive: true, force: true })
  }
  await mkdir(path.join(directory, ".opencode/codegen"), { recursive: true })
  for (const entry of ["agents", "instructions"]) {
    await cp(path.join(systemRoot, ".opencode", entry), path.join(directory, ".opencode", entry), { recursive: true })
  }
  await cp(path.join(systemRoot, ".opencode/codegen/schema"), path.join(directory, ".opencode/codegen/schema"), { recursive: true })
  await cp(path.join(systemRoot, "opencode.json"), path.join(directory, "opencode.json"))
  await writeFile(
    path.join(directory, ".gitignore"),
    ["__pycache__/", ".codegen-goal/", ".codegen-plan/", ".codegen-research/", ".codegen-opinions/", ".codegen-run/", ...extraIgnores, ""].join("\n"),
  )
  await git(directory, ["init", "-q", "-b", "main"])
  await git(directory, ["add", "."])
  await git(directory, ["commit", "-q", "-m", "certification baseline"])
  return directory
}

// Produced artifacts are copied next to the certification summary so the
// evidence survives the throwaway project.
async function keep(directory, artifacts, relativePaths) {
  for (const relative of relativePaths) {
    const source = path.join(directory, relative)
    if (await exists(source)) await cp(source, path.join(artifacts, "produced", relative), { recursive: true })
  }
}

async function runner(script, flags, directory, timeoutSeconds) {
  const args = [path.join(scriptDirectory, script), "--directory", directory]
  for (const [key, value] of Object.entries(flags)) {
    if (value !== null && value !== undefined) args.push(`--${key}`, String(value))
  }
  const started = Date.now()
  const result = await runProcess(process.execPath, args, { cwd: directory, timeoutSeconds: timeoutSeconds + 120 })
  let summary = null
  try {
    summary = JSON.parse(result.stdout)
  } catch {
    summary = null
  }
  return { summary, exitCode: result.exitCode, stderr: result.stderr, duration_s: Math.round((Date.now() - started) / 1000) }
}

function metricsOf(summary) {
  const attempts = summary?.attempts ?? []
  const totals = { input_tokens: 0, output_tokens: 0, reported_cost: 0, steps: 0 }
  for (const attempt of attempts) {
    const metrics = attempt.metrics ?? attempt
    totals.input_tokens += metrics.input_tokens ?? 0
    totals.output_tokens += metrics.output_tokens ?? 0
    totals.reported_cost += metrics.reported_cost ?? 0
    totals.steps += metrics.steps ?? 0
  }
  return totals
}

// Each role certification returns { result, detail, summary, records }: the
// records list every (configuration, role) pair the run validated, so an
// opinions run can certify two advisors and a reconciler at once.
const CERTIFICATIONS = {
  "goal-manager": async ({ configurationId, display, timeout, artifacts }) => {
    const directory = await project("builder-basic")
    try {
      const draft = await runner(
        "run-goal.mjs",
        { intent: GOAL_INTENT, "minimum-status": "candidate", configuration: configurationId, display, timeout },
        directory,
        timeout,
      )
      await keep(directory, artifacts, [".codegen-goal"])
      const result = draft.summary?.result
      if (!draft.summary?.validation?.valid || result === "SEALED") {
        return { result: "FAIL", detail: `draft returned ${result ?? draft.stderr.trim()}`, summary: draft.summary }
      }
      // The Goal must be approvable as drafted: no pending required research
      // and no blocking questions for an intent that supplies everything.
      const approve = await runner("run-goal.mjs", { approve: ".codegen-goal/goal.json" }, directory, 60)
      if (approve.summary?.result !== "SEALED" || approve.summary.routing?.status !== "ROUTED") {
        return { result: "FAIL", detail: `approval failed: ${approve.summary?.routing?.reasons?.join(", ") ?? approve.stderr.trim()}`, summary: draft.summary }
      }
      return {
        result: "PASS",
        detail: `draft ${result}, approved to route ${approve.summary.routing.route}`,
        summary: draft.summary,
        records: [{ configurationId, role: "goal-manager" }],
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },

  planner: async ({ configurationId, display, timeout, artifacts }) => {
    const directory = await project("orchestrator-basic")
    try {
      const goal = JSON.parse(await readFile(path.join(directory, ".codegen-goal/goal.json"), "utf8"))
      const run = await runner(
        "run-planner.mjs",
        { objective: goal.objective, goal: ".codegen-goal/goal.json", output: ".codegen-plan/plan.json", "minimum-status": "candidate", configuration: configurationId, display, timeout },
        directory,
        timeout,
      )
      await keep(directory, artifacts, [".codegen-plan"])
      const pass = run.summary?.result === "PASS"
      return {
        result: pass ? "PASS" : "FAIL",
        detail: pass ? `plan valid with ${run.summary.validation.execution_waves?.length ?? "?"} waves` : `${run.summary?.result ?? run.stderr.trim()}: ${(run.summary?.validation?.errors ?? []).join("; ")}`,
        summary: run.summary,
        records: pass ? [{ configurationId, role: "planner" }] : [],
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },

  "gate-designer": async ({ configurationId, display, timeout, registry, artifacts }) => {
    const directory = await project("orchestrator-basic")
    try {
      // A check that passes on the baseline judges nothing; the designer must
      // turn it into one that fails until alpha is implemented. The contract
      // is sealed exactly as the orchestrator seals it.
      await rm(path.join(directory, ".codegen-goal"), { recursive: true, force: true })
      await mkdir(path.join(directory, ".codegen-contract"))
      const sealed = await materializeGate(directory, {
        contract_id: "alpha",
        objective: "Implement alpha in lib/alpha.py",
        work_class: "localized-low-risk-code-change",
        risk: "low",
        read: ["lib/alpha.py", "tests/test_alpha.py"],
        allowed_to_modify: ["lib/alpha.py"],
        forbidden: ["tests/**", "lib/beta.py", "lib/gamma.py"],
        requirements: [{ id: "R1", statement: "alpha(value) returns value * 2 for integers and floats", kind: "change", verification: "automated" }],
        verification: { checks: [{ id: "C1", covers: ["R1"], command: "true" }], invariants: ["Only lib/alpha.py changes"] },
        budgets: { max_builder_attempts: 1, max_contract_revisions: 0, max_unplanned_scope_expansion: 0 },
        response: ["status", "changed files"],
      })
      await writeFile(path.join(directory, ".codegen-contract/contract.json"), `${JSON.stringify(sealed, null, 2)}\n`)
      await git(directory, ["add", "."])
      await git(directory, ["commit", "-q", "-m", "certification: contract with a trivial gate"])
      const configuration = registry.configurations.find((item) => item.configuration_id === configurationId)
      const run = await runner(
        "run-gate-designer.mjs",
        {
          contract: ".codegen-contract/contract.json",
          "work-class": "localized-low-risk-code-change",
          risk: "low",
          "minimum-status": "candidate",
          configuration: configurationId,
          // The certified designer must not share the family it would exclude at runtime.
          "exclude-family": configuration.family === "minimax" ? "qwen" : "minimax",
          display,
          timeout,
        },
        directory,
        timeout,
      )
      await keep(directory, artifacts, [".codegen-contract"])
      const pass = run.summary?.result === "GATE_READY" && run.summary.readiness_after?.ready === true
      return {
        result: pass ? "PASS" : "FAIL",
        detail: pass ? `gate fails on baseline: ${run.summary.changed_files.join(", ")}` : `${run.summary?.result ?? run.stderr.trim()} ${(run.summary?.readiness_after?.reasons ?? []).join(", ")}`,
        summary: run.summary,
        records: pass ? [{ configurationId, role: "gate-designer" }] : [],
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },

  builder: async ({ configurationId, display, timeout, artifacts }) => {
    const directory = await project("builder-basic")
    try {
      const negative = await runProcess("bash", [".codegen-contract/gate.sh"], { cwd: directory, timeoutSeconds: 300 })
      if (negative.exitCode === 0) throw new Error("Builder fixture is invalid: the gate passes before implementation")
      const run = await runner(
        "run-builder.mjs",
        { contract: ".codegen-contract/contract.json", "work-class": "localized-low-risk-code-change", risk: "low", "minimum-status": "candidate", configuration: configurationId, display, timeout },
        directory,
        timeout,
      )
      await keep(directory, artifacts, ["calculator.py"])
      const pass = run.summary?.result === "PASS"
      return {
        result: pass ? "PASS" : "FAIL",
        detail: pass ? `gate passed after changing ${run.summary.attempts.at(-1).changed_files.join(", ")}` : `${run.summary?.result ?? run.stderr.trim()} ${run.summary?.outside_scope?.join(", ") ?? ""}`,
        summary: run.summary,
        records: pass ? [{ configurationId, role: "builder" }] : [],
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },

  researcher: async ({ configurationId, display, timeout, artifacts }) => {
    const directory = await project("goal-research")
    try {
      const goal = JSON.parse(await readFile(path.join(directory, "goal.json"), "utf8"))
      goal.research_questions = [RESEARCH_QUESTION]
      await mkdir(path.join(directory, ".codegen-goal"), { recursive: true })
      await writeFile(path.join(directory, ".codegen-goal/goal.json"), `${JSON.stringify(goal, null, 2)}\n`)
      await rm(path.join(directory, "report.json"), { force: true })
      const run = await runner(
        "run-researcher.mjs",
        { question: "RQ-1", "minimum-status": "candidate", configuration: configurationId, display, timeout },
        directory,
        timeout,
      )
      await keep(directory, artifacts, [".codegen-research"])
      const pass = run.summary?.result === "COMPLETE"
      return {
        result: pass ? "PASS" : "FAIL",
        detail: pass ? "report COMPLETE with validated citations" : `${run.summary?.result ?? run.stderr.trim()}: ${(run.summary?.validation?.errors ?? []).join("; ")}`,
        summary: run.summary,
        records: pass ? [{ configurationId, role: "researcher" }] : [],
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },

  // One opinions run certifies every advisor whose opinion validated and the
  // reconciler if the advisors diverged and its decision validated.
  advisor: async ({ configurationId, withConfigurations, display, timeout, artifacts }) => {
    if (withConfigurations.length < 2) {
      throw new Error("advisor certification needs --with <second-advisor>,<reconciler>")
    }
    const directory = await project("goal-research")
    try {
      const goal = JSON.parse(await readFile(path.join(directory, "goal.json"), "utf8"))
      goal.open_questions = [OPEN_QUESTION]
      await mkdir(path.join(directory, ".codegen-goal"), { recursive: true })
      await writeFile(path.join(directory, ".codegen-goal/goal.json"), `${JSON.stringify(goal, null, 2)}\n`)
      await rm(path.join(directory, "report.json"), { force: true })
      const run = await runner(
        "run-opinions.mjs",
        { question: "OQ-1", advisors: 2, "minimum-status": "candidate", configurations: [configurationId, ...withConfigurations].join(","), display, timeout },
        directory,
        timeout * 3,
      )
      await keep(directory, artifacts, [".codegen-opinions"])
      const pass = run.summary?.result === "DECISION_PROPOSED"
      const records = []
      for (const attempt of run.summary?.attempts ?? []) {
        if (attempt.role === "advisor" && attempt.validation?.valid) records.push({ configurationId: attempt.configuration.configuration_id, role: "advisor" })
        if (attempt.role === "reconciler" && pass) records.push({ configurationId: attempt.configuration.configuration_id, role: "reconciler" })
      }
      const own = records.some((record) => record.configurationId === configurationId && record.role === "advisor")
      return {
        result: pass && own ? "PASS" : "FAIL",
        detail: `${run.summary?.result ?? run.stderr.trim()} (${run.summary?.reconciliation?.status ?? "?"}); validated ${records.map((r) => `${r.role}:${r.configurationId}`).join(", ") || "nothing"}`,
        summary: run.summary,
        records: pass ? records : [],
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },

  // The reconciler is exercised directly on two divergent fixture opinions.
  reconciler: async ({ configurationId, display, timeout, registry, artifacts, runId }) => {
    const directory = await project("goal-research")
    try {
      const goal = JSON.parse(await readFile(path.join(directory, "goal.json"), "utf8"))
      goal.open_questions = [OPEN_QUESTION]
      await mkdir(path.join(directory, ".codegen-goal"), { recursive: true })
      await writeFile(path.join(directory, ".codegen-goal/goal.json"), `${JSON.stringify(goal, null, 2)}\n`)
      const base = JSON.parse(await readFile(path.join(fixtures, "opinions/opinion.json"), "utf8"))
      const opinions = [
        { ...base, opinion_id: "OQ-1-claude" },
        {
          ...base,
          opinion_id: "OQ-1-gpt",
          position: "application-check",
          rationale: "Keeps the error mapping in one service layer and avoids coupling tests to database drivers",
          evidence: ["src/users/service.ts"],
          risks: ["Concurrent registrations can slip through between check and insert"],
          confidence: "medium",
        },
      ]
      for (const opinion of opinions) {
        if (!validateOpinion(opinion, OPEN_QUESTION).valid) throw new Error("reconciler fixture opinion is invalid")
      }
      const outputDirectory = ".codegen-opinions/OQ-1"
      await mkdir(path.join(directory, outputDirectory), { recursive: true })
      for (const opinion of opinions) {
        await writeFile(path.join(directory, outputDirectory, `${opinion.opinion_id}.json`), `${JSON.stringify(opinion, null, 2)}\n`)
      }
      const configuration = registry.configurations.find((item) => item.configuration_id === configurationId)
      const decisionOutput = `${outputDirectory}/decision.json`
      const prompt = [
        `Reconcile the divergent opinions on open question OQ-1 from .codegen-goal/goal.json: ${OPEN_QUESTION.question}`,
        `Listed options: ${OPEN_QUESTION.options.map((option) => `"${option}"`).join(", ")}.`,
        `Opinion files: ${opinions.map((opinion) => `${outputDirectory}/${opinion.opinion_id}.json`).join(", ")}.`,
        `Write the proposed decision to ${decisionOutput} with decision_id "DEC-OQ-1", method "reconciled", citing every opinion and explaining each rejected position.`,
      ].join("\n")
      const started = Date.now()
      const run = await runAgentProcess({
        directory,
        args: ["run", "--format", "json", "--model", configuration.opencode_model, "--agent", "reconciler", prompt],
        timeoutSeconds: timeout,
        display,
        title: `reconciler · certification · ${configuration.family}`,
      })
      await keep(directory, artifacts, [".codegen-opinions"])
      const metrics = summarizeEvents(run.stdout)
      const attempt = { configuration: { configuration_id: configurationId, model: configuration.opencode_model }, exit_code: run.exitCode, metrics }
      const summary = { result: null, attempts: [attempt], duration_s: Math.round((Date.now() - started) / 1000) }
      if (run.exitCode !== 0 || !(await exists(path.join(directory, decisionOutput)))) {
        summary.result = run.exitCode === 0 ? "DECISION_NOT_WRITTEN" : "RUN_FAILED"
        return { result: "FAIL", detail: `${summary.result}: ${run.stderr.trim().slice(-400)}`, summary }
      }
      let validation
      try {
        const decision = JSON.parse(await readFile(path.join(directory, decisionOutput), "utf8"))
        validation = validateDecision(decision, { question: OPEN_QUESTION, opinions })
        summary.chosen = decision.chosen
      } catch (error) {
        validation = { valid: false, errors: [`Decision is not valid JSON: ${error.message}`] }
      }
      summary.result = validation.valid ? "DECISION_PROPOSED" : "DECISION_INVALID"
      summary.validation = validation
      return {
        result: validation.valid ? "PASS" : "FAIL",
        detail: validation.valid ? `decision proposed: ${summary.chosen}` : validation.errors.join("; "),
        summary,
        records: validation.valid ? [{ configurationId, role: "reconciler" }] : [],
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
}

async function run(args) {
  if (await isInstalledProject(systemRoot)) {
    throw new Error("MAINTENANCE_ONLY: certification runs only inside the harness repository")
  }
  const role = args.role
  const configurationId = args.configuration
  if (!ROLES.includes(role) || !configurationId) throw new Error(usage())
  const registry = await loadRegistry(systemRoot)
  const configuration = registry.configurations.find((item) => item.configuration_id === configurationId)
  if (!configuration) throw new Error(`Unknown configuration: ${configurationId}`)
  if (!configuration.enabled || configuration.status === "deprecated") {
    throw new Error(`Configuration ${configurationId} is ${configuration.enabled ? configuration.status : "disabled"} and cannot be certified`)
  }
  const withConfigurations = (args.with ?? "").split(",").map((value) => value.trim()).filter(Boolean)
  const display = resolveDisplay({ display: args.display ?? process.env.CODEGEN_DISPLAY ?? "inline" })
  const timeout = Number(args.timeout ?? 900)
  const runId = newRunId()
  const artifacts = runsDirectory(systemRoot, "certification", role, configurationId.replaceAll("/", "__"), runId)
  await mkdir(artifacts, { recursive: true })
  const version = await runProcess("opencode", ["--version"], { timeoutSeconds: 30 })

  process.stderr.write(`certifying ${configurationId} (${configuration.opencode_model}) as ${role}\n`)
  const started = Date.now()
  const outcome = await CERTIFICATIONS[role]({ configurationId, withConfigurations, display, timeout, registry, artifacts, runId })
  const certifiedAt = new Date().toISOString()
  const evidence = {
    run_id: runId,
    fixture: role,
    result: outcome.result,
    detail: outcome.detail,
    duration_s: Math.round((Date.now() - started) / 1000),
    opencode_version: version.stdout.trim() || null,
    // The shape this evidence was gathered against; stale evidence is told
    // apart by it.
    schema_hash: await roleSchemaHash(role),
    metrics: metricsOf(outcome.summary),
  }

  // Record every validated pair; the requested pair records a failure too.
  const fresh = await loadRegistry(systemRoot)
  const records = outcome.result === "PASS" ? outcome.records : []
  const recorded = []
  for (const record of records) {
    recorded.push({ ...record, entry: recordCertification(fresh, { ...record, result: "PASS", certifiedAt, evidence }) })
  }
  if (outcome.result !== "PASS") {
    recorded.push({ configurationId, role, entry: recordCertification(fresh, { configurationId, role, result: "FAIL", certifiedAt, evidence }) })
  }
  await writeFile(registryFile, `${JSON.stringify(fresh, null, 2)}\n`)

  const report = { result: outcome.result, role, configuration_id: configurationId, model: configuration.opencode_model, detail: outcome.detail, evidence, recorded, runner_summary: outcome.summary, artifacts }
  await writeFile(path.join(artifacts, "summary.json"), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ ...report, runner_summary: undefined }, null, 2)}\n`)
  process.exitCode = outcome.result === "PASS" ? 0 : 1
}

async function check(args) {
  const registry = await loadRegistry(systemRoot)
  const release = checkRelease(registry, { minimumStatus: args["minimum-status"] ?? "qualified" })
  process.stdout.write(`${JSON.stringify(release, null, 2)}\n`)
  process.exitCode = release.ok ? 0 : 1
}

async function status() {
  const registry = await loadRegistry(systemRoot)
  const rows = certificationSummary(registry)
  for (const row of rows) {
    process.stdout.write(`${row.role.padEnd(14)} ${row.status.padEnd(10)} ${row.configuration_id.padEnd(36)} ${row.certified_at ?? "-"} ${row.run_id ?? ""}\n`)
  }
  const release = checkRelease(registry)
  process.stdout.write(`release: ${release.ok ? "COMPLETE" : `INCOMPLETE (${release.missing.length} missing)`}\n`)
  process.exitCode = release.ok ? 0 : 1
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArguments(rest)
  if (command === "check") return check(args)
  if (command === "status") return status()
  if (command === "run") return run(args)
  throw new Error(usage())
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 2
})

