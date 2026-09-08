#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { runExecutionPlan, selectExecutionPlan } from "../lib/builder-runner.mjs"
import {
  loadRegistry,
  newRunId,
  parseArguments,
  requireGitHead,
  resolveMinimumStatus,
  resolvePinnedConfiguration,
  runsDirectory,
} from "../lib/cli.mjs"
import { contractChecks, contractRequirements } from "../lib/contract.mjs"
import { CHECKS_DIRECTORY, checkGateReadiness } from "../lib/gate.mjs"
import { resolveDisplay, runAgentProcess } from "../lib/agent-run.mjs"
import { changedFilesSince, revision } from "../lib/worktrees.mjs"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(scriptDirectory, "../../..")

// Each readiness reason, spelled out with the requirement the check is
// supposed to prove, so the designer works on the right check.
function describeReasons(readiness, contract) {
  const requirements = new Map(contractRequirements(contract).map((item) => [item.id, item]))
  const checks = new Map(contractChecks(contract).map((check) => [check.id, check]))
  const lines = []
  for (const reason of readiness.reasons) {
    const [kind, detail] = reason.split(":")
    const check = checks.get(detail)
    const covered = (check?.covers ?? []).map((id) => `${id} "${requirements.get(id)?.statement ?? "?"}"`).join("; ")
    if (kind === "check-passes-on-baseline") {
      lines.push(`- ${CHECKS_DIRECTORY}/${detail}.sh passes on the untouched baseline, so it proves nothing. It covers ${covered}. Rewrite it so it fails until those requirements are met and passes afterwards.`)
    } else if (kind === "missing-script") {
      lines.push(`- ${detail} does not exist; the check that calls it cannot run.`)
    } else if (kind === "no-verification-checks") {
      lines.push("- the contract declares no checks.")
    } else {
      lines.push(`- ${reason}`)
    }
  }
  return lines.join("\n")
}

// The Gate Designer writes checks with a configuration admitted for its own
// role and excludes the model family that will implement the contract. It
// may only touch .codegen-contract/checks/: the contract and gate.sh are
// sealed, and readiness is judged against the contract as sealed.
async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (!args.contract || !args["work-class"]) {
    throw new Error(
      "usage: run-gate-designer.mjs --contract <path> --work-class <class> [--risk <risk>] [--exclude-family <family>]",
    )
  }
  const directory = path.resolve(args.directory ?? process.cwd())
  await requireGitHead(directory)
  const minimumStatus = await resolveMinimumStatus(args, systemRoot)
  const configurationId = await resolvePinnedConfiguration(args, systemRoot)
  const contractPath = path.resolve(directory, args.contract)
  const contract = JSON.parse(await readFile(contractPath, "utf8"))
  const before = await checkGateReadiness({ directory, contract })
  if (before.ready) {
    const summary = { result: "ALREADY_READY", readiness: before, attempts: [] }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return
  }
  if (!before.fixable) {
    const summary = { result: "NOT_FIXABLE", readiness: before, attempts: [] }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    process.exitCode = 1
    return
  }

  const registry = await loadRegistry(systemRoot)
  const plan = selectExecutionPlan(registry, "gate-designer", {
    workClass: args["work-class"],
    risk: args.risk ?? "low",
    minimumStatus,
    configurationId,
    requiredContext: Number(args["required-context"] ?? 0),
    requiresTools: true,
    requiresCodeEditing: true,
    excludeFamily: args["exclude-family"] ?? null,
  })
  if (plan.status !== "READY") {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    process.exitCode = 2
    return
  }

  const runId = newRunId()
  const artifacts = runsDirectory(systemRoot, "gate-designer", runId)
  await mkdir(artifacts, { recursive: true })
  const display = resolveDisplay(args)
  const baseline = await revision(directory)
  const prompt = [
    `Prepare the Gate for the sealed contract at ${path.relative(directory, contractPath)}.`,
    "Readiness check reported:",
    describeReasons(before, contract),
    `Each check lives in ${CHECKS_DIRECTORY}/<check id>.sh and covers the contract requirements listed in the contract. Rewrite only the failing checks' scripts (and any helper files next to them under ${CHECKS_DIRECTORY}/) so that each check fails on the current baseline for every change requirement it covers and passes once those requirements are met.`,
    "Do not edit the contract, gate.sh, product code, existing tests, dependencies, or configuration. Do not implement the product change. If a trustworthy check cannot be built, report BLOCKED.",
  ].join("\n")

  const execution = await runExecutionPlan({
    plan,
    execute: async (configuration, attemptNumber) => {
      const result = await runAgentProcess({
        directory,
        args: ["run", "--format", "json", "--model", configuration.model, "--agent", "gate-designer", prompt],
        timeoutSeconds: Number(args.timeout ?? 900),
        display,
        title: `gate-designer · ${contract.contract_id ?? "contrato"}`,
      })
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        eventsText: result.stdout,
        stderr: result.stderr,
        changedFiles: await changedFilesSince(directory, baseline),
      }
    },
  })

  let result = execution.status
  const changed = execution.attempts.at(-1)?.changed_files ?? []
  // Anything outside the checks directory is out of scope: the contract and
  // the wrapper included. A designer that rewrote contract.json fails here.
  const outsideScope = changed.filter((file) => !file.startsWith(`${CHECKS_DIRECTORY}/`))
  let after = null
  if (result === "SUCCESS" && outsideScope.length > 0) result = "SCOPE_FAIL"
  if (result === "SUCCESS") {
    if (changed.length === 0) {
      result = /\bBLOCKED\b/i.test(execution.attempts.at(-1).metrics.final_text)
        ? "CONTRACT_BLOCKED"
        : "NO_CHANGES"
    } else {
      after = await checkGateReadiness({ directory, contract })
      result = after.ready ? "GATE_READY" : "GATE_NOT_READY"
    }
  }

  const summary = {
    result,
    contract: path.relative(directory, contractPath),
    readiness_before: before,
    readiness_after: after,
    changed_files: changed,
    outside_scope: outsideScope,
    user_action: execution.user_action,
    attempts: execution.attempts,
    artifacts,
  }
  await writeFile(path.join(artifacts, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.exitCode = result === "GATE_READY" ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 2
})
