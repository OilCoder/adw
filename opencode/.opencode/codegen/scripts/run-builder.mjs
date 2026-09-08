#!/usr/bin/env node

import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  runBuilderExecution,
} from "../lib/builder-runner.mjs"
import {
  loadRegistry,
  newRunId,
  parseArguments,
  requireGitHead,
  listArgument,
  resolvePinnedConfiguration,
  runsDirectory,
} from "../lib/cli.mjs"
import { contractChecks } from "../lib/contract.mjs"
import { resolveDisplay, runAgentProcess } from "../lib/agent-run.mjs"
import { recordCall, selectConfiguration } from "../lib/select-configuration.mjs"
import { runProcess } from "../lib/process.mjs"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(scriptDirectory, "../../..")

async function trackedFiles(directory) {
  const result = await runProcess(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: directory, timeoutSeconds: 30 },
  )
  if (result.exitCode !== 0) throw new Error("Builder Runner requires a Git worktree")
  return result.stdout.split("\0").filter(Boolean)
}

async function snapshot(directory) {
  const state = new Map()
  for (const relativePath of await trackedFiles(directory)) {
    try {
      const filePath = path.join(directory, relativePath)
      if ((await lstat(filePath)).isSymbolicLink()) continue
      const content = await readFile(filePath)
      state.set(relativePath, createHash("sha256").update(content).digest("hex"))
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
  return state
}

function changedFiles(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths].filter((file) => before.get(file) !== after.get(file)).sort()
}

function pathMatches(pattern, candidate) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3)
    return candidate === prefix || candidate.startsWith(`${prefix}/`)
  }
  return pattern === candidate
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const directory = path.resolve(args.directory ?? process.cwd())
  const contractPath = path.resolve(directory, args.contract ?? "")
  if (!args.contract || !args["work-class"]) {
    throw new Error(
      "usage: run-builder.mjs --contract <path> --work-class <class> [--risk <risk>] [--evidence <path>] [--exclude-family <family>] [--exclude-configurations a,b] [--fit-check run|off]",
    )
  }

  await requireGitHead(directory)
  const configurationId = await resolvePinnedConfiguration(args, systemRoot)
  const registry = await loadRegistry(systemRoot)
  const contract = JSON.parse(await readFile(contractPath, "utf8"))
  const display = resolveDisplay(args)
  const plan = await selectConfiguration({
    systemRoot,
    registry,
    role: "builder",
    args,
    display,
    request: {
      workClass: args["work-class"],
      risk: args.risk ?? "low",
      configurationId,
      requiredContext: Number(args["required-context"] ?? 0),
      excludeFamily: args["exclude-family"] ?? null,
      excludeConfigurations: listArgument(args["exclude-configurations"]),
      requiresTools: true,
      requiresCodeEditing: true,
    },
  })
  const evidencePath = args.evidence ? path.resolve(directory, args.evidence) : null
  const evidence = evidencePath ? JSON.parse(await readFile(evidencePath, "utf8")) : null
  // Evidence of a repair (an integration conflict, a failed final Gate) is
  // not a retry of this Builder: it explains why the sealed contract runs
  // again on the integrated tree.
  const repairKind = evidence?.kind ?? null
  const repairEvidence = evidence?.repair_evidence ?? null
  if (plan.status !== "READY") {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    process.exitCode = 2
    return
  }

  const runId = newRunId()
  const artifacts = runsDirectory(systemRoot, "builder", runId)
  await mkdir(artifacts, { recursive: true })
  const baseline = await snapshot(directory)
  const prompt = [
    `Execute the sealed contract at ${path.relative(directory, contractPath)}.`,
    ...(evidencePath && repairKind
      ? [
          `This contract repairs an integration failure (${repairKind}). Read the evidence at ${path.relative(directory, evidencePath)} before changing anything: it explains what was built before, what failed on the integrated tree, and why. Fix exactly that without widening the contract.`,
        ]
      : []),
    ...(evidencePath && !repairKind
      ? [
          `This is a retry. Read the evidence from the previous failed attempt at ${path.relative(directory, evidencePath)} before changing anything, and fix the reported failure without widening the contract.${repairEvidence ? ` The repair this contract performs is explained at ${repairEvidence}; read it too.` : ""}`,
        ]
      : []),
    "Implement it now and finish with the requested concise status.",
  ].join(" ")

  const execution = await runBuilderExecution({
    plan,
    execute: async (configuration, attemptNumber) => {
      const result = await runAgentProcess({
        directory,
        args: ["run", "--format", "json", "--model", configuration.model, "--agent", "builder", prompt],
        timeoutSeconds: Number(args.timeout ?? 900),
        display,
        title: `builder · ${contract.contract_id ?? path.basename(contractPath)}`,
      })
      const after = await snapshot(directory)
      const changed = changedFiles(baseline, after)
      await writeFile(
        path.join(artifacts, `attempt-${attemptNumber}.json`),
        `${JSON.stringify(
          {
            configuration,
            exit_code: result.exitCode,
            signal: result.signal,
            changed_files: changed,
          },
          null,
          2,
        )}\n`,
      )
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        eventsText: result.stdout,
        stderr: result.stderr,
        changedFiles: changed,
      }
    },
  })

  let result = execution.status
  const finalAttempt = execution.attempts.at(-1)
  const allowed = contract.allowed_to_modify ?? []
  const outsideScope = (finalAttempt?.changed_files ?? []).filter(
    (file) => !allowed.some((pattern) => pathMatches(pattern, file)),
  )
  const verification = []

  if (result === "SUCCESS" && outsideScope.length > 0) result = "SCOPE_FAIL"
  if (result === "SUCCESS" && finalAttempt.changed_files.length === 0) {
    result = /\bBLOCKED\b/i.test(finalAttempt.metrics.final_text)
      ? "CONTRACT_BLOCKED"
      : "NO_CHANGES"
  }
  // Controlled verification: every check of the contract runs, one by one,
  // so a failed attempt leaves evidence per requirement for the retry.
  if (result === "SUCCESS") {
    for (const check of contractChecks(contract)) {
      const run = await runProcess(check.command, [], {
        cwd: directory,
        timeoutSeconds: Number(args["gate-timeout"] ?? 300),
        shell: true,
      })
      verification.push({
        check_id: check.id,
        covers: check.covers,
        command: check.command,
        exit_code: run.exitCode,
        signal: run.signal,
        output: `${run.stdout}\n${run.stderr}`.trim().slice(-4000),
      })
      if (run.exitCode !== 0) result = "GATE_FAIL"
    }
  }
  if (result === "SUCCESS") result = "PASS"

  const failing = verification.filter((check) => check.exit_code !== 0).map((check) => check.check_id)
  await recordCall({
    systemRoot,
    role: "builder",
    plan,
    result,
    success: result === "PASS",
    runId,
    execution,
    reason: result === "GATE_FAIL" ? `failing checks: ${failing.join(", ")}` : result === "SCOPE_FAIL" ? `outside scope: ${outsideScope.join(", ")}` : null,
    context: { contract_id: contract.contract_id ?? null },
  })

  const report = {
    result,
    work_class: args["work-class"],
    selection: { configuration_id: plan.primary.configuration_id, model: plan.primary.model, rank: plan.primary.rank, ladder: plan.ladder, fits: plan.fits },
    user_action: execution.user_action,
    attempts: execution.attempts,
    outside_scope: outsideScope,
    verification,
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
