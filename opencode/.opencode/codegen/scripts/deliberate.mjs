#!/usr/bin/env node
// Deliberates an open Goal: runs the Researcher on pending questions within
// the research budget, the advisors and reconciler on blocking questions with
// a closed option set, then asks the Goal Manager to fold reports and proposed
// decisions into the Goal. The user still seals the Goal afterwards.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { loadRegistry, newRunId, parseArguments, requireGitHead, resolveInsideProject, resolveMinimumStatus, resolveSourceVerification, runsDirectory, exists } from "../lib/cli.mjs"
import { deliberationPlan, readyForApproval, verifyRevision } from "../lib/deliberation.mjs"
import { validateGoal } from "../lib/goal.mjs"
import { validateDecision } from "../lib/opinions.mjs"
import { runProcess } from "../lib/process.mjs"
import { reportAnswers, unverifiedFindings, validateResearchReport } from "../lib/research-report.mjs"

function reportEntry(question, report, file) {
  return {
    question_id: question.id,
    report_id: report.report_id,
    path: file,
    status: report.status,
    answers: reportAnswers(report),
    unverified_findings: unverifiedFindings(report),
  }
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(scriptDirectory, "../../..")

async function spawnRunner(script, flags, directory) {
  const args = [path.join(scriptDirectory, script), "--directory", directory]
  for (const [key, value] of Object.entries(flags)) {
    if (value !== null && value !== undefined) args.push(`--${key}`, String(value))
  }
  const result = await runProcess(process.execPath, args, { cwd: directory, timeoutSeconds: 3600 })
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`${script} produced no JSON summary (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"))
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const directory = path.resolve(args.directory ?? process.cwd())
  await requireGitHead(directory)
  const minimumStatus = await resolveMinimumStatus(args, systemRoot)
  const sourceVerification = await resolveSourceVerification(args, systemRoot)
  await loadRegistry(systemRoot)
  const goalFile = resolveInsideProject(directory, args.goal ?? ".codegen-goal/goal.json", "Goal")
  if (!(await exists(goalFile.absolute))) throw new Error(`Goal does not exist: ${goalFile.relative}`)
  const goal = await readJson(goalFile.absolute)
  const validation = validateGoal(goal)
  if (!validation.valid) throw new Error(`Goal is invalid: ${validation.errors.join("; ")}`)
  const runId = newRunId()
  const artifacts = runsDirectory(systemRoot, "deliberation", runId)
  await mkdir(artifacts, { recursive: true })
  const display = args.display ?? process.env.CODEGEN_DISPLAY ?? null
  const timeout = args.timeout ?? null
  const summary = { result: null, goal: goalFile.relative, goal_id: goal.goal_id, run_id: runId, plan: null, research: [], opinions: [], revision: null, verification: null, ready_for_approval: false, user_action: null, artifacts }
  async function finish(result, exitCode) {
    summary.result = result
    await writeFile(path.join(artifacts, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    process.exitCode = exitCode
  }
  if (goal.status === "SEALED") return finish("ALREADY_SEALED", 1)

  // Evidence already on disk.
  const reports = []
  for (const question of goal.research_questions) {
    const file = path.join(directory, ".codegen-research", `${question.id}.json`)
    if (!(await exists(file))) continue
    const report = await readJson(file)
    if (validateResearchReport(report, question).valid) reports.push(reportEntry(question, report, path.relative(directory, file)))
  }
  const decisions = []
  for (const question of goal.open_questions) {
    const file = path.join(directory, ".codegen-opinions", question.id, "decision.json")
    if (!(await exists(file))) continue
    const decision = await readJson(file)
    if (validateDecision(decision, { question }).valid) decisions.push({ question_id: question.id, decision_id: decision.decision_id, path: path.relative(directory, file), chosen: decision.chosen, opinion_ids: decision.opinion_ids ?? [], question: decision.question })
  }
  const plan = deliberationPlan(goal, { reports: reports.map((r) => r.question_id), decisions: decisions.map((d) => d.question_id) })
  summary.plan = plan
  if (plan.status === "USER_DECISION_REQUIRED") return finish("USER_DECISION_REQUIRED", 1)
  if (plan.status === "BUDGET_BLOCKED") return finish("BUDGET_BLOCKED", 1)
  if (plan.status === "NOTHING_TO_DELIBERATE") {
    summary.ready_for_approval = readyForApproval(goal)
    return finish("NOTHING_TO_DELIBERATE", summary.ready_for_approval ? 0 : 1)
  }

  // 1. Research, one runner per question, in budget order.
  for (const questionId of plan.research) {
    const run = await spawnRunner("run-researcher.mjs", { question: questionId, goal: goalFile.relative, "minimum-status": minimumStatus, "source-verification": sourceVerification, timeout, display }, directory)
    summary.research.push({ question_id: questionId, result: run.result, output: run.output ?? null, answers: run.answers ?? false, unverified_findings: run.unverified_findings ?? [], fabricated: run.verification?.fabricated ?? [], user_action: run.user_action ?? null })
    if (run.user_action) {
      summary.user_action = run.user_action
      return finish("USER_ACTION_REQUIRED", 1)
    }
    if (run.validation?.valid) {
      const question = goal.research_questions.find((item) => item.id === questionId)
      const report = await readJson(path.join(directory, run.output))
      reports.push(reportEntry(question, report, run.output))
    }
  }

  // 2. Opinions and reconciliation, one runner per blocking question.
  for (const questionId of plan.opinions) {
    const run = await spawnRunner("run-opinions.mjs", { question: questionId, goal: goalFile.relative, "minimum-status": minimumStatus, advisors: args.advisors ?? null, timeout, display }, directory)
    summary.opinions.push({ question_id: questionId, result: run.result, decision: run.decision ?? null, user_action: run.user_action ?? null })
    if (run.user_action) {
      summary.user_action = run.user_action
      return finish("USER_ACTION_REQUIRED", 1)
    }
    if (run.decision) {
      const decision = await readJson(path.join(directory, run.decision))
      decisions.push({ question_id: questionId, decision_id: decision.decision_id, path: run.decision, chosen: decision.chosen, opinion_ids: decision.opinion_ids ?? [], question: decision.question })
    }
  }
  if (reports.length === 0 && decisions.length === 0) return finish("NO_EVIDENCE", 1)

  // 3. The Goal Manager folds the evidence into the Goal; the result is checked
  //    against the evidence, never taken from the model's summary.
  const revision = await spawnRunner(
    "run-goal.mjs",
    { revise: goalFile.relative, reports: reports.map((r) => r.path).join(","), decisions: decisions.map((d) => d.path).join(","), "minimum-status": minimumStatus, timeout, display },
    directory,
  )
  summary.revision = { result: revision.result, backup: revision.backup ?? null, user_action: revision.user_action ?? null, validation: revision.validation ?? null }
  if (revision.user_action) {
    summary.user_action = revision.user_action
    return finish("USER_ACTION_REQUIRED", 1)
  }
  if (!revision.validation?.valid) return finish("REVISION_INVALID", 1)
  const revised = await readJson(goalFile.absolute)
  summary.verification = verifyRevision(goal, revised, { reports, decisions })
  summary.ready_for_approval = summary.verification.ready_for_approval
  if (!summary.verification.ok) return finish("REVISION_INVALID", 1)
  return finish(summary.ready_for_approval ? "DECIDED" : "STILL_OPEN", summary.ready_for_approval ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 2
})
