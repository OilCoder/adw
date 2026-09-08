#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { runExecutionPlan } from "../lib/builder-runner.mjs"
import {
  exists,
  loadRegistry,
  newRunId,
  parseArguments,
  requireGitHead,
  resolveInsideProject,
  resolvePinnedConfiguration,
  runsDirectory,
} from "../lib/cli.mjs"
import { readyForApproval } from "../lib/deliberation.mjs"
import { routeGoal } from "../lib/goal-routing.mjs"
import { approvalRecord, goalDigest, renderGoalMarkdown, sealApprovedGoal, validateGoal } from "../lib/goal.mjs"
import { validateDecision } from "../lib/opinions.mjs"
import { resolveDisplay, runAgentProcess } from "../lib/agent-run.mjs"
import { recordCall, selectConfiguration } from "../lib/select-configuration.mjs"
import { runProcess } from "../lib/process.mjs"
import { reportAnswers, unverifiedFindings, validateResearchReport } from "../lib/research-report.mjs"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(scriptDirectory, "../../..")

const USAGE =
  "usage: run-goal.mjs --intent <text> [--reports a.json,b.json] [--output .codegen-goal/goal.json] [--allow-sealed true] | --revise <goal.json> [--reports ...] [--decisions ...] [--intent <user guidance>] | --approve <goal.json> --digest <goal_digest of the summary the user approved>"

// Approval is deterministic: the user approved this exact Goal, so it is sealed
// in place without another model call. `--digest` is the goal_digest of the
// summary the user approved; a Goal whose file changed since is refused.
async function approve(directory, goalArgument, args) {
  const goalFile = resolveInsideProject(directory, goalArgument, "Goal")
  if (!(await exists(goalFile.absolute))) throw new Error(`Goal does not exist: ${goalFile.relative}`)
  if (!args.digest) throw new Error("approve requires --digest <goal_digest>: the digest of the draft, revise, or deliberate summary the user approved")
  const goal = JSON.parse(await readFile(goalFile.absolute, "utf8"))
  const sealed = sealApprovedGoal(goal, { digest: String(args.digest), via: "run-goal --approve" })
  await writeFile(goalFile.absolute, `${JSON.stringify(sealed, null, 2)}\n`)
  const markdown = path.join(path.dirname(goalFile.absolute), "GOAL.md")
  await writeFile(markdown, renderGoalMarkdown(sealed))
  const routing = routeGoal(sealed)
  const summary = {
    result: "SEALED",
    operation: "approve",
    output: goalFile.relative,
    markdown: path.relative(directory, markdown),
    goal_id: sealed.goal_id,
    previous_status: goal.status,
    approval: sealed.approval,
    routing,
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.exitCode = routing.status === "ROUTED" ? 0 : 1
}

async function loadReports(directory, list, goal = null) {
  const reports = []
  for (const item of (list ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    const file = resolveInsideProject(directory, item, "Research report")
    const report = JSON.parse(await readFile(file.absolute, "utf8"))
    const question = goal?.research_questions.find((entry) => entry.id === report.question_id) ?? null
    const validation = validateResearchReport(report, question)
    if (!validation.valid) throw new Error(`Research report ${file.relative} is invalid: ${validation.errors.join("; ")}`)
    reports.push({
      path: file.relative,
      report_id: report.report_id,
      question_id: report.question_id,
      status: report.status,
      answers: reportAnswers(report),
      unverified_findings: unverifiedFindings(report),
    })
  }
  return reports
}

// How a report is described to the Goal Manager: whether it answers its
// question, and which findings nobody could verify by retrieval.
function describeReport(item) {
  const verification = item.unverified_findings.length > 0 ? `, unverified findings (por confirmar): ${item.unverified_findings.join(", ")}` : ""
  return `${item.path} (${item.report_id}, answers ${item.question_id}, ${item.status}${item.answers ? "" : ", answers nothing"}${verification})`
}

async function loadDecisions(directory, list, goal) {
  const decisions = []
  for (const item of (list ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    const file = resolveInsideProject(directory, item, "Decision")
    const decision = JSON.parse(await readFile(file.absolute, "utf8"))
    const question = goal.open_questions.find((entry) => entry.id === decision.question_id) ?? null
    const validation = validateDecision(decision, { question })
    if (!validation.valid) throw new Error(`Decision ${file.relative} is invalid: ${validation.errors.join("; ")}`)
    decisions.push({ path: file.relative, decision_id: decision.decision_id, question_id: decision.question_id, chosen: decision.chosen, opinion_ids: decision.opinion_ids ?? [] })
  }
  return decisions
}

// One Goal Manager call. `mode` is "draft" (new Goal from intent) or "revise"
// (fold evidence into the existing Goal). Only the user seals a Goal: a model
// that returns SEALED without that approval is rejected here.
async function callGoalManager({ directory, args, output, prompt, title, lines, runId, artifacts, configurationId, mode }) {
  const registry = await loadRegistry(systemRoot)
  const display = resolveDisplay(args)
  const plan = await selectConfiguration({
    systemRoot,
    registry,
    role: "goal-manager",
    args,
    display,
    request: {
      workClass: "complex-engineering-plan",
      risk: args.risk ?? "medium",
      configurationId,
      requiredContext: Number(args["required-context"] ?? 0),
      requiresTools: true,
      requiresCodeEditing: false,
    },
  })
  if (plan.status !== "READY") {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    process.exitCode = 2
    return null
  }
  const execution = await runExecutionPlan({
    plan,
    execute: async (configuration) => {
      const result = await runAgentProcess({
        directory,
        args: ["run", "--format", "json", "--model", configuration.model, "--agent", "goal-manager", prompt],
        timeoutSeconds: Number(args.timeout ?? 600),
        display,
        title,
      })
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        eventsText: result.stdout,
        stderr: result.stderr,
        changedFiles: (await exists(output.absolute)) ? [output.relative] : [],
      }
    },
  })

  let result = execution.status
  let validation = null
  let routing = null
  let markdown = null
  let goal = null
  if (result === "SUCCESS" && !(await exists(output.absolute))) result = "GOAL_NOT_WRITTEN"
  if (result === "SUCCESS") {
    try {
      goal = JSON.parse(await readFile(output.absolute, "utf8"))
      // A model never seals: a SEALED Goal without the user's explicit
      // --allow-sealed is rejected; with it, the runner stamps the approval
      // record (the user approved sealing before the call) and rewrites the
      // file, so the seal still carries who, when, and what.
      if (goal?.status === "SEALED" && args["allow-sealed"] === "true" && goal.approval === undefined) {
        goal.approval = approvalRecord(goal, { via: "run-goal --allow-sealed" })
        await writeFile(output.absolute, `${JSON.stringify(goal, null, 2)}\n`)
      }
      validation = validateGoal(goal)
      if (goal?.status === "SEALED" && args["allow-sealed"] !== "true") {
        validation = { valid: false, errors: ["Goal returned SEALED without explicit user approval (--allow-sealed true)"] }
        result = "SEALED_WITHOUT_APPROVAL"
      } else if (validation.valid) {
        markdown = path.join(path.dirname(output.absolute), "GOAL.md")
        await writeFile(markdown, renderGoalMarkdown(goal))
        routing = routeGoal(goal)
        result = goal.status
      } else {
        result = "GOAL_INVALID"
      }
    } catch (error) {
      validation = { valid: false, errors: [`Goal is not valid JSON: ${error.message}`] }
      result = "GOAL_INVALID"
    }
  }
  await recordCall({
    systemRoot,
    role: "goal-manager",
    plan,
    result,
    success: Boolean(validation?.valid) && result !== "SEALED_WITHOUT_APPROVAL",
    runId,
    execution,
    reason: validation && !validation.valid ? validation.errors.slice(0, 3).join("; ") : null,
    context: { mode },
  })
  const selection = { configuration_id: plan.primary.configuration_id, model: plan.primary.model, rank: plan.primary.rank, ladder: plan.ladder, fits: plan.fits }
  return { result, validation, routing, markdown: markdown ? path.relative(directory, markdown) : null, execution, goal, goal_digest: validation?.valid ? goalDigest(goal) : null, selection, lines }
}

async function draft(directory, args, configurationId) {
  const output = resolveInsideProject(directory, args.output ?? ".codegen-goal/goal.json", "Goal output")
  if (await exists(output.absolute)) throw new Error(`Goal output already exists: ${output.relative}`)
  const reports = await loadReports(directory, args.reports)
  await mkdir(path.dirname(output.absolute), { recursive: true })
  const runId = newRunId()
  const artifacts = runsDirectory(systemRoot, "goal", runId)
  await mkdir(artifacts, { recursive: true })
  const prompt = [
    `Convert this user intent into a Goal: ${args.intent}`,
    `Write the complete Goal to ${output.relative}.`,
    reports.length > 0
      ? `Use these validated research reports as evidence: ${reports.map(describeReport).join("; ")}. A finding marked unverified is "por confirmar": never turn it into a decision without saying so in the rationale.`
      : "No research reports are available; turn unknown facts into research_questions.",
    args["allow-sealed"] === "true"
      ? "The user has explicitly approved sealing this Goal if nothing blocks it."
      : "Leave status DRAFT, RESEARCHING, or DECIDED; the user has not approved sealing. Do not plan implementation or write product code.",
  ].join("\n")
  const call = await callGoalManager({ directory, args, output, prompt, title: `goal-manager · ${output.relative}`, runId, artifacts, configurationId, mode: "draft" })
  if (!call) return
  const summary = {
    result: call.result,
    operation: "draft",
    output: output.relative,
    selection: call.selection,
    markdown: call.markdown,
    goal_digest: call.goal_digest,
    research_reports: reports,
    user_action: call.execution.user_action,
    attempts: call.execution.attempts,
    validation: call.validation,
    routing: call.routing,
    ready_for_approval: call.goal ? readyForApproval(call.goal) : false,
    artifacts,
  }
  await writeFile(path.join(artifacts, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.exitCode = call.validation?.valid ? 0 : 1
}

// Revision: the existing Goal is rewritten in place with research reports,
// proposed decisions from deliberation, and optional user guidance. The
// previous version is kept next to it.
async function revise(directory, args, configurationId) {
  const output = resolveInsideProject(directory, args.revise, "Goal")
  if (!(await exists(output.absolute))) throw new Error(`Goal does not exist: ${output.relative}`)
  const before = JSON.parse(await readFile(output.absolute, "utf8"))
  const beforeValidation = validateGoal(before)
  if (!beforeValidation.valid) throw new Error(`Goal is invalid: ${beforeValidation.errors.join("; ")}`)
  if (before.status === "SEALED") throw new Error("A SEALED Goal is not revised; draft a new Goal for new work")
  const reports = await loadReports(directory, args.reports, before)
  const decisions = await loadDecisions(directory, args.decisions, before)
  if (reports.length === 0 && decisions.length === 0 && !args.intent) {
    throw new Error("revise needs --reports, --decisions, or --intent with user guidance")
  }
  const runId = newRunId()
  const artifacts = runsDirectory(systemRoot, "goal", runId)
  await mkdir(artifacts, { recursive: true })
  const backup = path.join(path.dirname(output.absolute), `goal.before-${runId}.json`)
  await copyFile(output.absolute, backup)
  const prompt = [
    `Revise the existing Goal at ${output.relative}: read it first and rewrite it in place, keeping goal_id "${before.goal_id}" and every requirement the user stated.`,
    ...(reports.length
      ? [
          `Research reports (validated and checked by retrieval): ${reports.map(describeReport).join("; ")}.`,
          "Mark each research question whose report answers it completed, and record the accepted conclusions under decisions, citing the report ids in research_report_ids. A report that answers nothing (BLOCKED, or no finding verified by retrieval) never completes its question: leave it pending, or waive it with the reason when no decision depends on it. A finding marked unverified is \"por confirmar\": do not turn it into a decision without saying so in the rationale.",
        ]
      : []),
    ...(decisions.length
      ? [
          `Proposed decisions from deliberation: ${decisions.map((item) => `${item.path} (${item.decision_id} on ${item.question_id} chose "${item.chosen}")`).join("; ")}.`,
          "Record each one under decisions with its rationale and its opinion_ids, and set the corresponding open question to blocking false or remove it.",
        ]
      : []),
    ...(args.intent ? [`User guidance for this revision: ${args.intent}`, "Record the user's answers as decisions and resolve the open questions they answer."] : []),
    "Do not add research questions or blocking questions unless the evidence makes one unavoidable. Leave status DECIDED, or RESEARCHING if required research is still pending; never SEALED. Do not plan implementation or write product code.",
  ].join("\n")
  const call = await callGoalManager({ directory, args, output, prompt, title: `goal-manager · revise ${output.relative}`, runId, artifacts, configurationId, mode: "revise" })
  if (!call) return
  const summary = {
    result: call.result,
    operation: "revise",
    output: output.relative,
    selection: call.selection,
    backup: path.relative(directory, backup),
    markdown: call.markdown,
    goal_digest: call.goal_digest,
    research_reports: reports,
    decisions,
    user_action: call.execution.user_action,
    attempts: call.execution.attempts,
    validation: call.validation,
    routing: call.routing,
    ready_for_approval: call.goal ? readyForApproval(call.goal) : false,
    artifacts,
  }
  await writeFile(path.join(artifacts, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.exitCode = call.validation?.valid ? 0 : 1
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const directory = path.resolve(args.directory ?? process.cwd())
  await requireGitHead(directory)
  if (args.approve) return approve(directory, args.approve, args)
  if (!args.intent && !args.revise) throw new Error(USAGE)
  const configurationId = await resolvePinnedConfiguration(args, systemRoot)
  if (args.revise) return revise(directory, args, configurationId)
  return draft(directory, args, configurationId)
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 2
})
