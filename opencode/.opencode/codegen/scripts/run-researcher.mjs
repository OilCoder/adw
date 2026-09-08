#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { classifyExecution, selectExecutionPlan } from "../lib/builder-runner.mjs"
import {
  exists,
  loadRegistry,
  newRunId,
  parseArguments,
  requireGitHead,
  resolveInsideProject,
  resolveMinimumStatus,
  resolvePinnedConfiguration,
  resolveSourceVerification,
  runsDirectory,
} from "../lib/cli.mjs"
import { validateGoal } from "../lib/goal.mjs"
import { resolveDisplay, runAgentProcess } from "../lib/agent-run.mjs"
import { runProcess } from "../lib/process.mjs"
import { renderResearchMarkdown, reportAnswers, unverifiedFindings, validateResearchReport } from "../lib/research-report.mjs"
import { applyVerification, offlineVerification, verifySources } from "../lib/source-verification.mjs"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(scriptDirectory, "../../..")

// The Researcher runs one configuration admitted for its role once. Routes
// prefer Go and admit Zen-only capacity when Go cannot meet the request.
// After the model returns, the runner validates the report's shape, then
// fetches every source and searches every finding's quote: fabricated
// sources reject the report; unverifiable ones are marked, never trusted.
async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (!args.question) {
    throw new Error(
      "usage: run-researcher.mjs --question <id> [--goal .codegen-goal/goal.json] [--output .codegen-research/<id>.json] [--source-verification fetch|offline]",
    )
  }
  const directory = path.resolve(args.directory ?? process.cwd())
  await requireGitHead(directory)
  const minimumStatus = await resolveMinimumStatus(args, systemRoot)
  const configurationId = await resolvePinnedConfiguration(args, systemRoot)
  const sourceVerification = await resolveSourceVerification(args, systemRoot)
  const goalFile = resolveInsideProject(directory, args.goal ?? ".codegen-goal/goal.json", "Goal")
  const output = resolveInsideProject(
    directory,
    args.output ?? `.codegen-research/${args.question}.json`,
    "Researcher output",
  )
  if (await exists(output.absolute)) {
    throw new Error(`Researcher output already exists: ${output.relative}`)
  }

  const goal = JSON.parse(await readFile(goalFile.absolute, "utf8"))
  const goalValidation = validateGoal(goal)
  if (!goalValidation.valid) {
    throw new Error(`Goal is invalid: ${goalValidation.errors.join("; ")}`)
  }
  const question = goal.research_questions.find((item) => item.id === args.question)
  if (!question) throw new Error(`Goal does not define research question ${args.question}`)
  if (question.status !== "pending") {
    throw new Error(`Research question ${question.id} is ${question.status}, not pending`)
  }
  if (goal.budgets.max_research_calls < 1) {
    throw new Error("Goal budget does not allow research calls")
  }

  const registry = await loadRegistry(systemRoot)
  const plan = selectExecutionPlan(registry, "researcher", {
    workClass: "research-synthesis",
    risk: goal.routing.risk,
    minimumStatus,
    configurationId,
    requiredContext: Number(args["required-context"] ?? 0),
    requiresTools: true,
    requiresCodeEditing: false,
  })
  if (plan.status !== "READY") {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    process.exitCode = 2
    return
  }

  await mkdir(path.dirname(output.absolute), { recursive: true })
  const runId = newRunId()
  const artifacts = runsDirectory(systemRoot, "researcher", runId)
  await mkdir(artifacts, { recursive: true })
  const display = resolveDisplay(args)
  const prompt = [
    `Research question ${question.id} from ${goalFile.relative}: ${question.question}`,
    `Why it is needed: ${question.why_needed}`,
    `Allowed source types: ${question.allowed_source_types.join(", ")}.`,
    `Budget: at most ${question.budget.max_sources} sources and ${question.budget.max_minutes} minutes.`,
    `Write the complete report to ${output.relative} with question_id "${question.id}" and the question text copied verbatim.`,
    "Cite only sources you actually retrieved, and give every finding a verbatim quote (at most 300 characters) copied from one of its sources: the system fetches each source and searches for that quote. A source that does not exist rejects the report; a quote that cannot be found leaves the finding unverified. If blocked, write a BLOCKED report instead of guessing.",
  ].join("\n")

  const configuration = plan.primary
  const run = await runAgentProcess({
    directory,
    args: ["run", "--format", "json", "--model", configuration.model, "--agent", "researcher", prompt],
    timeoutSeconds: Number(args.timeout ?? question.budget.max_minutes * 60),
    // Keep hosted Exa available if the selected Go model needs it.
    env: { OPENCODE_ENABLE_EXA: process.env.OPENCODE_ENABLE_EXA ?? "1" },
    display,
    title: `researcher · ${question.id}`,
  })
  const written = await exists(output.absolute)
  const classification = classifyExecution({
    exitCode: run.exitCode,
    signal: run.signal,
    eventsText: run.stdout,
    stderr: run.stderr,
    changedFiles: written ? [output.relative] : [],
  })
  const attempt = {
    configuration,
    exit_code: run.exitCode,
    signal: run.signal,
    changed_files: written ? [output.relative] : [],
    ...classification,
  }

  let result = classification.classification
  let validation = null
  let report = null
  let verification = null
  if (result === "SUCCESS" && !written) result = "REPORT_NOT_WRITTEN"
  if (result === "SUCCESS") {
    try {
      report = JSON.parse(await readFile(output.absolute, "utf8"))
      validation = validateResearchReport(report, question)
      result = validation.valid ? report.status : "REPORT_INVALID"
    } catch (error) {
      validation = { valid: false, errors: [`Report is not valid JSON: ${error.message}`] }
      result = "REPORT_INVALID"
    }
  }
  // Verification by retrieval. The verdicts are written into the report so
  // the Goal Manager and the user see what could and could not be checked.
  if (validation?.valid) {
    verification = sourceVerification === "offline" ? offlineVerification(report) : await verifySources(report)
    if (verification.fabricated.length > 0) {
      validation = { valid: false, errors: verification.fabricated.map((item) => `fabricated source ${item}`) }
      result = "REPORT_INVALID"
    } else {
      report = applyVerification(report, verification)
      await writeFile(output.absolute, `${JSON.stringify(report, null, 2)}\n`)
    }
  }
  let markdown = null
  if (validation?.valid) {
    markdown = output.absolute.replace(/\.json$/, ".md")
    await writeFile(markdown, renderResearchMarkdown(report))
  }

  const summary = {
    result,
    question_id: question.id,
    output: output.relative,
    markdown: markdown ? path.relative(directory, markdown) : null,
    user_action: classification.user_action,
    attempts: [attempt],
    validation,
    verification: verification
      ? { mode: verification.mode, sources: verification.sources.map(({ id, status, http_status, detail }) => ({ id, status, http_status, detail })), findings: verification.findings, fabricated: verification.fabricated }
      : null,
    answers: validation?.valid ? reportAnswers(report) : false,
    unverified_findings: validation?.valid ? unverifiedFindings(report) : [],
    artifacts,
  }
  await writeFile(path.join(artifacts, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.exitCode = result === "COMPLETE" ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 2
})
