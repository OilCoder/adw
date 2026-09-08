#!/usr/bin/env node

import path from "node:path"
import { fileURLToPath } from "node:url"

import { loadRegistry, loadRiskFloors, newRunId, parseArguments, requireGitHead } from "../lib/cli.mjs"
import { resolveFitCheck } from "../lib/fit-check.mjs"
import { appendMetalog, loadMetalogSummary } from "../lib/metalog.mjs"
import { orchestrate } from "../lib/orchestrator.mjs"
import { builderFamily } from "../lib/release.mjs"
import { runProcess } from "../lib/process.mjs"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(scriptDirectory, "../../..")

// Every model-backed step runs as a separate runner process: run ids use the
// pid, and each `opencode run` owns its own local server.
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

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const directory = path.resolve(args.directory ?? process.cwd())
  await requireGitHead(directory)
  const fitCheck = await resolveFitCheck(args, systemRoot)
  const registry = await loadRegistry(systemRoot)
  const runId = args["run-id"] ?? newRunId()
  const timeout = args.timeout ?? null
  const display = args.display ?? process.env.CODEGEN_DISPLAY ?? null
  // Keep the Gate independent from the implementation: exclude the family of
  // the Builder configuration first in line for this project.
  const excludedFamily = builderFamily(registry, { metalog: await loadMetalogSummary(systemRoot) })
  const list = (items) => (items?.length ? items.join(",") : null)

  const state = await orchestrate({
    directory,
    goalPath: args.goal ?? ".codegen-goal/goal.json",
    planPath: args.plan ?? null,
    registry,
    riskFloors: await loadRiskFloors(systemRoot),
    runId,
    concurrency: Number(args.concurrency ?? 2),
    keepWorktrees: args["keep-worktrees"] === "true",
    metalog: { append: (entry) => appendMetalog(systemRoot, entry) },
    gateTimeoutSeconds: Number(args["gate-timeout"] ?? 300),
    log: (record) => process.stderr.write(
      `[${record.at}] ${record.event}${record.contract_id ? ` ${record.contract_id}` : ""}${record.event === "RUN_STOPPED" && record.reason ? `: ${record.reason}` : ""}\n`,
    ),
    runners: {
      planner: ({ directory: cwd, objective, goal, output, route, evidence, excludeConfigurations }) =>
        spawnRunner(
          "run-planner.mjs",
          { objective, goal, output, route, evidence, "exclude-configurations": list(excludeConfigurations), "fit-check": fitCheck, timeout, display },
          cwd,
        ),
      gateDesigner: ({ directory: cwd, contract, workClass, risk }) =>
        spawnRunner(
          "run-gate-designer.mjs",
          { contract, "work-class": workClass, risk, "exclude-family": excludedFamily, "fit-check": fitCheck, timeout, display },
          cwd,
        ),
      builder: ({ directory: cwd, contract, workClass, risk, evidence, excludeConfigurations }) =>
        spawnRunner(
          "run-builder.mjs",
          { contract, "work-class": workClass, risk, evidence, "exclude-configurations": list(excludeConfigurations), "fit-check": fitCheck, timeout, display },
          cwd,
        ),
    },
  })
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
  // A run paused for plan review is not a failure: the user continues it
  // with --plan once the plan is approved.
  process.exitCode = ["COMPLETED", "PLAN_REVIEW_REQUIRED"].includes(state.status) ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 2
})
