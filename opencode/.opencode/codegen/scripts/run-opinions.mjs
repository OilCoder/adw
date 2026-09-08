#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { classifyExecution } from "../lib/builder-runner.mjs"
import { admittedForRole, independentFamilies } from "../lib/release.mjs"
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
import { validateGoal } from "../lib/goal.mjs"
import { appendMetalog, callEntry, loadMetalogSummary } from "../lib/metalog.mjs"
import { configurationCost } from "../lib/model-selection.mjs"
import { ensureFit } from "../lib/select-configuration.mjs"
import {
  reconcileOpinions,
  renderDecisionMarkdown,
  unanimousDecision,
  validateDecision,
  validateOpinion,
} from "../lib/opinions.mjs"
import { resolveDisplay, runAgentProcess } from "../lib/agent-run.mjs"
import { runProcess } from "../lib/process.mjs"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(scriptDirectory, "../../..")

function view(configuration, role, ladder = []) {
  return {
    configuration_id: configuration.configuration_id,
    model: configuration.opencode_model,
    provider: configuration.provider,
    family: configuration.family,
    role,
    rank: ladder.indexOf(configuration.configuration_id) + 1 || null,
    ladder,
    cost_per_million: configurationCost(configuration).total,
  }
}

async function runAgent({ directory, agent, model, prompt, timeoutSeconds, output, display, title }) {
  const result = await runAgentProcess({
    directory,
    args: ["run", "--format", "json", "--model", model, "--agent", agent, prompt],
    timeoutSeconds,
    display,
    title,
  })
  const written = await exists(output)
  return {
    written,
    exit_code: result.exitCode,
    signal: result.signal,
    ...classifyExecution({
      exitCode: result.exitCode,
      signal: result.signal,
      eventsText: result.stdout,
      stderr: result.stderr,
      changedFiles: written ? [output] : [],
    }),
  }
}

// Advisors run once each on distinct model families admitted as advisor.
// Unanimity is decided deterministically; divergence goes to a reconciler
// from a third family admitted as reconciler.
async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (!args.question) {
    throw new Error(
      "usage: run-opinions.mjs --question <open_question_id> [--goal .codegen-goal/goal.json] [--advisors 2]",
    )
  }
  const directory = path.resolve(args.directory ?? process.cwd())
  await requireGitHead(directory)
  // Maintenance pins advisors and reconciler in order: a,b[,c].
  const pinned = (await resolvePinnedConfiguration({ configuration: args.configurations ?? null }, systemRoot))
    ?.split(",").map((value) => value.trim()).filter(Boolean) ?? []
  const goalFile = resolveInsideProject(directory, args.goal ?? ".codegen-goal/goal.json", "Goal")
  const goal = JSON.parse(await readFile(goalFile.absolute, "utf8"))
  const goalValidation = validateGoal(goal)
  if (!goalValidation.valid) throw new Error(`Goal is invalid: ${goalValidation.errors.join("; ")}`)
  const question = goal.open_questions.find((item) => item.id === args.question)
  if (!question) throw new Error(`Goal does not define open question ${args.question}`)
  if (!Array.isArray(question.options) || question.options.length < 2) {
    throw new Error(`Open question ${question.id} has no closed option set; add options before deliberation`)
  }
  const advisorCount = Number(args.advisors ?? 2)
  const outputDirectory = resolveInsideProject(directory, `.codegen-opinions/${question.id}`, "Opinions output")
  if (await exists(outputDirectory.absolute)) {
    throw new Error(`Opinions output already exists: ${outputDirectory.relative}`)
  }

  const registry = await loadRegistry(systemRoot)
  const request = {
    workClass: "independent-analysis",
    risk: goal.routing.risk,
    requiredContext: Number(args["required-context"] ?? 0),
    requiresTools: true,
    requiresCodeEditing: false,
  }
  // Advisors come from configurations admitted as advisor, one per family; the
  // reconciler from a configuration admitted as reconciler in a family that
  // gave no opinion.
  const pinnedAdvisors = pinned.slice(0, advisorCount)
  const pinnedReconciler = pinned[advisorCount] ?? null
  const display = resolveDisplay(args)
  const metalog = await loadMetalogSummary(systemRoot)
  const admittedAdvisors = admittedForRole(registry, "advisor", request, { metalog })
  const advisorLadder = admittedAdvisors.eligible.map((configuration) => configuration.configuration_id)
  const advisorPool = independentFamilies(
    pinnedAdvisors.length > 0
      ? pinnedAdvisors.map((id) => admittedAdvisors.eligible.find((c) => c.configuration_id === id)).filter(Boolean)
      : admittedAdvisors.eligible,
  )
  // One advisor per family, cheapest first, each checked for fit the first
  // time this project uses it; a family whose first configuration does not
  // fit is skipped.
  const advisors = []
  const fits = []
  for (const configuration of advisorPool) {
    if (advisors.length >= advisorCount) break
    const fit = await ensureFit({ systemRoot, configuration, args, display })
    if (!fit.cached) fits.push({ configuration_id: configuration.configuration_id, outcome: fit.outcome, reason: fit.reason })
    if (fit.outcome === "pass") advisors.push(configuration)
  }
  const advisorFamilies = new Set(advisors.map((configuration) => configuration.family))
  const admittedReconcilers = admittedForRole(registry, "reconciler", request, { metalog })
  const reconcilerLadder = admittedReconcilers.eligible.map((configuration) => configuration.configuration_id)
  let reconciler = null
  for (const configuration of independentFamilies(admittedReconcilers.eligible)) {
    if (advisorFamilies.has(configuration.family)) continue
    if (pinnedReconciler && configuration.configuration_id !== pinnedReconciler) continue
    const fit = await ensureFit({ systemRoot, configuration, args, display })
    if (!fit.cached) fits.push({ configuration_id: configuration.configuration_id, outcome: fit.outcome, reason: fit.reason })
    if (fit.outcome === "pass") {
      reconciler = configuration
      break
    }
  }
  if (advisors.length < advisorCount || !reconciler) {
    const summary = {
      result: "INSUFFICIENT_INDEPENDENCE",
      question_id: question.id,
      reason: `${advisors.length} admitted advisor families of ${advisorCount} required; reconciler family ${reconciler ? "available" : "missing"}`,
      families: advisors.map((configuration) => configuration.family),
      rejected: { advisor: admittedAdvisors.rejected, reconciler: admittedReconcilers.rejected },
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    process.exitCode = 2
    return
  }

  await mkdir(outputDirectory.absolute, { recursive: true })
  const runId = newRunId()
  const artifacts = runsDirectory(systemRoot, "opinions", runId)
  await mkdir(artifacts, { recursive: true })
  const timeoutSeconds = Number(args.timeout ?? 600)
  const attempts = []
  const opinions = []
  let userAction = null

  for (const configuration of advisors) {
    const opinionId = `${question.id}-${configuration.family}`
    const output = path.join(outputDirectory.relative, `${opinionId}.json`)
    const prompt = [
      `Give your independent opinion on open question ${question.id} from ${goalFile.relative}: ${question.question}`,
      `Listed options: ${question.options.map((option) => `"${option}"`).join(", ")}.`,
      `Write the opinion to ${output} with opinion_id "${opinionId}", copying question_id, question, and options verbatim.`,
    ].join("\n")
    const run = await runAgent({
      directory,
      agent: "advisor",
      model: configuration.opencode_model,
      prompt,
      timeoutSeconds,
      output: path.join(directory, output),
      display,
      title: `advisor · ${question.id} · ${configuration.family}`,
    })
    const attempt = { role: "advisor", configuration: view(configuration, "advisor", advisorLadder), output, ...run, validation: null }
    attempts.push(attempt)
    if (run.classification === "SUCCESS" && run.written) {
      try {
        const opinion = JSON.parse(await readFile(path.join(directory, output), "utf8"))
        attempt.validation = validateOpinion(opinion, question)
        if (attempt.validation.valid) opinions.push({ opinion, family: configuration.family })
      } catch (error) {
        attempt.validation = { valid: false, errors: [`Opinion is not valid JSON: ${error.message}`] }
      }
    }
    const advisorResult = attempt.validation ? (attempt.validation.valid ? "OPINION_VALID" : "OPINION_INVALID") : run.written ? run.classification : run.classification === "SUCCESS" ? "OPINION_NOT_WRITTEN" : run.classification
    await appendMetalog(systemRoot, callEntry({ role: "advisor", selection: attempt.configuration, result: advisorResult, success: Boolean(attempt.validation?.valid), runId, execution: { metrics: run.metrics ?? null }, reason: attempt.validation && !attempt.validation.valid ? attempt.validation.errors.slice(0, 3).join("; ") : null, context: { question_id: question.id } }))
    if (run.user_action) {
      userAction = run.user_action
      break
    }
  }

  const reconciliation = userAction
    ? { status: "USER_ACTION_REQUIRED", reason: userAction }
    : reconcileOpinions(opinions, { minOpinions: advisorCount })
  let decision = null
  let decisionValidation = null
  let result = reconciliation.status
  const decisionId = `DEC-${question.id}`
  const decisionOutput = path.join(outputDirectory.relative, "decision.json")

  if (reconciliation.status === "UNANIMOUS") {
    decision = unanimousDecision({ question, opinions: opinions.map((item) => item.opinion), decisionId })
    await writeFile(path.join(directory, decisionOutput), `${JSON.stringify(decision, null, 2)}\n`)
  } else if (reconciliation.status === "DIVERGENT") {
    const prompt = [
      `Reconcile the divergent opinions on open question ${question.id} from ${goalFile.relative}: ${question.question}`,
      `Listed options: ${question.options.map((option) => `"${option}"`).join(", ")}.`,
      `Opinion files: ${attempts.filter((attempt) => attempt.validation?.valid).map((attempt) => attempt.output).join(", ")}.`,
      `Write the proposed decision to ${decisionOutput} with decision_id "${decisionId}", method "reconciled", citing every opinion and explaining each rejected position.`,
    ].join("\n")
    const run = await runAgent({
      directory,
      agent: "reconciler",
      model: reconciler.opencode_model,
      prompt,
      timeoutSeconds,
      output: path.join(directory, decisionOutput),
      display,
      title: `reconciler · ${question.id} · ${reconciler.family}`,
    })
    attempts.push({ role: "reconciler", configuration: view(reconciler, "reconciler", reconcilerLadder), output: decisionOutput, ...run })
    if (run.user_action) {
      userAction = run.user_action
      result = "USER_ACTION_REQUIRED"
    } else if (run.classification === "SUCCESS" && run.written) {
      try {
        decision = JSON.parse(await readFile(path.join(directory, decisionOutput), "utf8"))
      } catch (error) {
        decisionValidation = { valid: false, errors: [`Decision is not valid JSON: ${error.message}`] }
      }
    } else {
      result = run.written ? run.classification : "RECONCILER_FAILED"
    }
  }

  if (decision) {
    decisionValidation = validateDecision(decision, { question, opinions: opinions.map((item) => item.opinion) })
    if (decisionValidation.valid) {
      result = "DECISION_PROPOSED"
      await writeFile(
        path.join(directory, outputDirectory.relative, "DECISION.md"),
        renderDecisionMarkdown(decision, opinions.map((item) => item.opinion)),
      )
    } else {
      result = "DECISION_INVALID"
    }
  }
  const reconcilerAttempt = attempts.find((attempt) => attempt.role === "reconciler")
  if (reconcilerAttempt) {
    const reconcilerResult = decisionValidation ? (decisionValidation.valid ? "DECISION_PROPOSED" : "DECISION_INVALID") : reconcilerAttempt.classification === "SUCCESS" ? "DECISION_NOT_WRITTEN" : reconcilerAttempt.classification
    await appendMetalog(systemRoot, callEntry({ role: "reconciler", selection: reconcilerAttempt.configuration, result: reconcilerResult, success: Boolean(decisionValidation?.valid), runId, execution: { metrics: reconcilerAttempt.metrics ?? null }, reason: decisionValidation && !decisionValidation.valid ? decisionValidation.errors.slice(0, 3).join("; ") : null, context: { question_id: question.id } }))
  }

  const summary = {
    result,
    question_id: question.id,
    output: outputDirectory.relative,
    reconciliation,
    decision: decisionValidation?.valid ? decisionOutput : null,
    decision_validation: decisionValidation,
    user_action: userAction,
    fits,
    attempts,
    artifacts,
  }
  await writeFile(path.join(artifacts, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.exitCode = result === "DECISION_PROPOSED" ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 2
})
