import { cp, rm } from "node:fs/promises"
import path from "node:path"

import { GATE_WRAPPER, parseGateOutput } from "./gate.mjs"
import { runProcess } from "./process.mjs"
import { changedFilesSince, git } from "./worktrees.mjs"

function pathMatches(pattern, candidate) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3)
    return candidate === prefix || candidate.startsWith(`${prefix}/`)
  }
  return pattern === candidate
}

// Runs one sealed contract gate (its .codegen-contract directory) on the tree
// checked out in `directory`, then leaves the tree as it was. The final Gate
// runs every gate this way; the diagnosis replays one gate along the
// integration branch the same way.
export async function runContractGate({ directory, source, timeoutSeconds = 600, run = runProcess }) {
  const gateDirectory = path.join(directory, ".codegen-contract")
  const gateTracked =
    (await git(directory, ["ls-files", "--error-unmatch", ".codegen-contract"], { allowFailure: true }))
      .exitCode === 0
  await rm(gateDirectory, { recursive: true, force: true })
  await cp(source, gateDirectory, { recursive: true })
  const result = await run(`bash ${GATE_WRAPPER}`, [], { cwd: directory, timeoutSeconds, shell: true })
  await rm(gateDirectory, { recursive: true, force: true })
  if (gateTracked) await git(directory, ["checkout", "--", ".codegen-contract"], { allowFailure: true })
  return {
    command: `bash ${GATE_WRAPPER}`,
    exit_code: result.exitCode,
    check_results: parseGateOutput(result.stdout),
    output: `${result.stdout}\n${result.stderr}`.trim().slice(-4000),
  }
}

// The final Gate judges the integrated result, not any single contract:
// every contract gate must still pass on the merged tree, the merged diff
// must stay inside the union of allowed paths, and the plan-level checks pass.
// Each contract gate reports its checks one by one; the coverage ledger
// reads those verdicts.
export async function runFinalGate({
  directory,
  baseRevision,
  plan,
  contractGates = [],
  timeoutSeconds = 600,
  run = runProcess,
}) {
  const contracts = plan.phases.flatMap((phase) => phase.contracts)
  const allowed = contracts.flatMap((contract) => contract.allowed_to_modify)
  const changed = await changedFilesSince(directory, baseRevision)
  const outsideScope = changed.filter((file) => !allowed.some((pattern) => pathMatches(pattern, file)))
  const checks = []
  const reasons = []
  if (outsideScope.length > 0) reasons.push(`outside-scope:${outsideScope.join(",")}`)

  for (const { contract_id, source } of contractGates) {
    const gate = await runContractGate({ directory, source, timeoutSeconds, run })
    checks.push({ contract_id, ...gate })
    if (gate.exit_code !== 0) reasons.push(`contract-gate-failed:${contract_id}`)
  }

  for (const command of plan.final_verification?.commands ?? []) {
    const result = await run(command, [], { cwd: directory, timeoutSeconds, shell: true })
    checks.push({
      contract_id: null,
      command,
      exit_code: result.exitCode,
      check_results: [],
      output: `${result.stdout}\n${result.stderr}`.trim().slice(-4000),
    })
    if (result.exitCode !== 0) reasons.push(`final-verification-failed:${command}`)
  }

  return {
    result: reasons.length === 0 ? "PASS" : "FAIL",
    reasons,
    changed_files: changed,
    outside_scope: outsideScope,
    checks,
  }
}
