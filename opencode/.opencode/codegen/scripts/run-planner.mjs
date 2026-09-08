#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { runExecutionPlan } from "../lib/builder-runner.mjs"
import { renderPlanMarkdown } from "../lib/coverage.mjs"
import { validatePlan } from "../lib/plan-validation.mjs"
import {
  exists,
  listArgument,
  loadRegistry,
  loadRiskFloors,
  newRunId,
  parseArguments,
  requireGitHead,
  resolvePinnedConfiguration,
  runsDirectory,
} from "../lib/cli.mjs"
import { resolveDisplay, runAgentProcess } from "../lib/agent-run.mjs"
import { recordCall, selectConfiguration } from "../lib/select-configuration.mjs"
import { runProcess } from "../lib/process.mjs"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(scriptDirectory, "../../..")

// The Goal ids the plan has to account for, spelled out so the Planner
// declares `covers` against real ids instead of guessing them.
function coverageBrief(goal) {
  const must = goal.requirements.filter((item) => item.priority === "must")
  const other = goal.requirements.filter((item) => item.priority !== "must")
  const automated = goal.acceptance_criteria.filter((item) => item.verification_type === "automated")
  const human = goal.acceptance_criteria.filter((item) => item.verification_type !== "automated")
  const line = (item) => `${item.id}: ${item.statement ?? item.criterion}`
  return [
    "Each contract requirement lists in `covers` the Goal ids it satisfies. The validator rejects the plan unless every one of these is covered:",
    ...must.map((item) => `- requirement (must) ${line(item)}`),
    ...automated.map((item) => `- acceptance criterion (automated, needs an automated contract requirement) ${line(item)}`),
    ...(other.length > 0 ? ["Cover these when the plan addresses them; uncovered ones are reported, not rejected:", ...other.map((item) => `- requirement (${item.priority}) ${line(item)}`)] : []),
    ...(human.length > 0 ? ["These criteria are verified by a human, never by a check; do not invent checks for them:", ...human.map((item) => `- acceptance criterion (${item.verification_type}) ${line(item)}`)] : []),
  ].join("\n")
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (!args.objective) {
    throw new Error(
      "usage: run-planner.mjs --objective <text> [--goal <path>] [--output .codegen-plan/plan.json] [--route direct|planned] [--evidence <rejected-plan-evidence.json>] [--repair true] [--exclude-configurations a,b] [--fit-check run|off]",
    )
  }
  if (args.route !== undefined && !["direct", "planned"].includes(args.route)) throw new Error("route must be direct or planned")
  const directory = path.resolve(args.directory ?? process.cwd())
  await requireGitHead(directory)
  const configurationId = await resolvePinnedConfiguration(args, systemRoot)
  const outputPath = path.resolve(directory, args.output ?? ".codegen-plan/plan.json")
  const relativeOutput = path.relative(directory, outputPath)
  if (relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput)) {
    throw new Error("Planner output must be inside the target project")
  }
  if (await exists(outputPath)) throw new Error(`Planner output already exists: ${relativeOutput}`)
  await mkdir(path.dirname(outputPath), { recursive: true })

  const registry = await loadRegistry(systemRoot)
  const display = resolveDisplay(args)
  const plan = await selectConfiguration({
    systemRoot,
    registry,
    role: "planner",
    args,
    display,
    request: {
      workClass: "complex-engineering-plan",
      risk: args.risk ?? "medium",
      configurationId,
      requiredContext: Number(args["required-context"] ?? 0),
      excludeConfigurations: listArgument(args["exclude-configurations"]),
      requiresTools: true,
      requiresCodeEditing: false,
    },
  })
  if (plan.status !== "READY") {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    process.exitCode = 2
    return
  }

  const runId = newRunId()
  const artifacts = runsDirectory(systemRoot, "planner", runId)
  await mkdir(artifacts, { recursive: true })
  const route = args.route ?? null
  const riskFloors = await loadRiskFloors(systemRoot)
  const goal = args.goal ? JSON.parse(await readFile(path.resolve(directory, args.goal), "utf8")) : null
  const goalRisk = goal?.routing?.risk ?? null
  const evidencePath = args.evidence ? path.resolve(directory, args.evidence) : null
  const evidence = evidencePath ? JSON.parse(await readFile(evidencePath, "utf8")) : null
  // A repair plan extends a plan the user already approved: the repository
  // the Planner inspects is the integrated tree, the plan's base revision is
  // its HEAD, and the plan needs only the contracts that fix the failure.
  const repair = args.repair === "true" || evidence?.kind === "repair"
  const prompt = [
    `Plan this objective: ${args.objective}`,
    ...(args.goal ? [`The sealed Goal with requirements, constraints, and acceptance criteria is at ${args.goal}; read it first.`] : []),
    `Write the complete plan to ${relativeOutput}.`,
    `Use only these work_class values: ${Object.keys(registry.routes).join(", ")}.`,
    "Paths in allowed_to_modify are exact file paths or dir/**; read and forbidden also accept *.ext globs. Never use other wildcards.",
    ...(goalRisk
      ? [`The Goal was triaged at risk ${goalRisk}. Declare each contract's real risk: if your inspection shows more risk than the Goal assumed, say so; the run then pauses for the user to accept it instead of building on a wrong label. Paths such as dependency manifests, CI, migrations, auth, payments, or infrastructure raise the effective risk on their own.`]
      : []),
    "Requirements are objects with id, statement, kind (change: adds or alters behavior; preserve: keeps existing behavior), verification (automated, or manual when no command can judge it), and covers (Goal ids). verification.checks lists one executable check per automated requirement: id, covers (requirement ids), command. A check covering a change requirement must fail on the untouched repository and pass once the requirement is met; a check covering only preserve requirements must already pass. Never declare an expected baseline: it follows from the kinds. A contract with only manual requirements has no Gate and is rejected.",
    ...(goal ? [coverageBrief(goal)] : []),
    "Check commands judge behavior and file contents only (run the script, run tests, compare outputs). Never inspect Git state (git status, git diff, untracked files): the same gate reruns on the integration branch where the change is already committed, and scope is enforced by the orchestrator. Never call .codegen-contract/gate.sh: the orchestrator generates it around your checks.",
    ...(repair
      ? [
          `This is a repair plan. A plan already approved by the user was built and integrated on branch ${evidence?.integration_branch ?? "codegen/<run>"}; the repository you inspect is that integrated tree and its HEAD is the base revision of your plan. The integrated result failed: ${evidence?.reason ?? "see the evidence"}. Read the evidence at ${path.relative(directory, evidencePath)} first; it carries the failing checks, their output, the replay along the integration branch, and the repairs already attempted. Plan only the contracts that fix exactly this failure, with new contract ids. Stay inside the approved footprint (${(evidence?.approved_footprint ?? []).join(", ") || "the paths of the approved plan"}); if the fix genuinely needs other paths, list them and the run pauses for the user to accept it. Each contract requirement still names the Goal ids it covers; the repair plan need not cover the whole Goal again. If the failure needs a product decision, do not guess: return BLOCKED with the missing decision.`,
        ]
      : []),
    ...(evidence?.errors
      ? [
          `This is a retry. The previous plan (${evidence.rejected_plan ?? path.relative(directory, evidencePath)}) was rejected by the deterministic validator with these errors: ${(evidence.errors ?? []).join("; ")}. Fix exactly those problems and keep everything else.`,
        ]
      : []),
    ...(route === "direct"
      ? ["This objective took the direct route: write one phase with one contract if the change fits in one. If it genuinely needs more, write them; the run is then re-routed to the planned route and pauses for the user to review the plan."]
      : []),
    "Do not implement product code. If blocked, do not create the plan file.",
  ].join("\n")

  const execution = await runExecutionPlan({
    plan,
    execute: async (configuration, attemptNumber) => {
      const result = await runAgentProcess({
        directory,
        args: ["run", "--format", "json", "--model", configuration.model, "--agent", "planner", prompt],
        timeoutSeconds: Number(args.timeout ?? 900),
        display,
        title: `planner · ${relativeOutput}`,
      })
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        eventsText: result.stdout,
        stderr: result.stderr,
        changedFiles: (await exists(outputPath)) ? [relativeOutput] : [],
      }
    },
  })

  let result = execution.status
  let validation = null
  let markdown = null
  if (result === "SUCCESS" && !(await exists(outputPath))) result = "PLAN_NOT_WRITTEN"
  if (result === "SUCCESS") {
    try {
      const generatedPlan = JSON.parse(await readFile(outputPath, "utf8"))
      validation = validatePlan(generatedPlan, {
        workClasses: new Set(Object.keys(registry.routes)),
        goal,
        route,
        riskFloors,
        partialCoverage: repair,
      })
      const revision = await runProcess("git", ["rev-parse", "HEAD"], {
        cwd: directory,
        timeoutSeconds: 30,
      })
      if (
        revision.exitCode !== 0 ||
        generatedPlan.base_revision !== revision.stdout.trim()
      ) {
        validation.errors.push("base_revision does not match the current Git HEAD")
        validation.valid = false
      }
      result = validation.valid ? "PASS" : "PLAN_INVALID"
      // PLAN.md is rendered deterministically next to the plan, never by the
      // model, so the user can review contracts and Goal coverage.
      if (validation.valid) {
        markdown = outputPath.replace(/\.json$/, ".md")
        await writeFile(markdown, renderPlanMarkdown(generatedPlan, goal, { route, riskFloors, partialCoverage: repair }))
      }
    } catch (error) {
      validation = { valid: false, errors: [`Plan is not valid JSON: ${error.message}`] }
      result = "PLAN_INVALID"
    }
  }

  await recordCall({
    systemRoot,
    role: "planner",
    plan,
    result,
    success: result === "PASS",
    runId,
    execution,
    reason: validation && !validation.valid ? validation.errors.slice(0, 3).join("; ") : null,
    context: { route },
  })

  const report = {
    result,
    output: relativeOutput,
    selection: { configuration_id: plan.primary.configuration_id, model: plan.primary.model, rank: plan.primary.rank, ladder: plan.ladder, fits: plan.fits },
    markdown: markdown ? path.relative(directory, markdown) : null,
    user_action: execution.user_action,
    attempts: execution.attempts,
    validation: validation ? { valid: validation.valid, errors: validation.errors, execution_waves: validation.execution_waves ?? [] } : null,
    coverage: validation?.coverage ?? null,
    triage: validation?.triage ?? null,
    artifacts,
  }
  await writeFile(path.join(artifacts, "summary.json"), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = result === "PASS" ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 2
})
