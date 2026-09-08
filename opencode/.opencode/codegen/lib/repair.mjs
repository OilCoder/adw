// Repair of integration failures (CODE_GENERATION_FLOW §4, "Trabajo
// derivado" and "Reparación tras integrar"). Nothing here calls a model: Git
// names the paths of a conflict, and replaying a gate along the integration
// branch names the commit that broke it. The repair contract is composed from
// contracts the user already approved; the Planner is the fallback when the
// facts are inconclusive or the composed contract cannot be gated.
import { contractChecks, contractRequirements } from "./contract.mjs"

const RISK_RANK = { low: 0, medium: 1, high: 2 }

function unique(items) {
  return [...new Set(items)]
}

function maxRisk(...risks) {
  return risks.filter((risk) => risk in RISK_RANK).reduce((highest, risk) => (RISK_RANK[risk] > RISK_RANK[highest] ? risk : highest), "low")
}

function pathMatches(pattern, candidate) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3)
    return candidate === prefix || candidate.startsWith(`${prefix}/`)
  }
  return pattern === candidate
}

function overlaps(left, right) {
  return pathMatches(left, right.endsWith("/**") ? right.slice(0, -3) : right) || pathMatches(right, left.endsWith("/**") ? left.slice(0, -3) : left)
}

// What the next round would be told about a failed final Gate: the reasons
// and, per contract, the checks that failed. A round that reproduces the
// signature of an earlier one would be repaired with the same evidence, so
// the loop stops there (no counter, same rule as the Builder's attempts).
export function finalGateSignature(finalGate) {
  const failing = (finalGate?.checks ?? [])
    .filter((check) => check.exit_code !== 0)
    .map((check) => ({
      contract_id: check.contract_id,
      command: check.contract_id ? null : check.command,
      checks: (check.check_results ?? []).filter((item) => item.result === "FAIL").map((item) => item.check_id).sort(),
    }))
    .sort((a, b) => `${a.contract_id}${a.command}`.localeCompare(`${b.contract_id}${b.command}`))
  return JSON.stringify({ reasons: [...(finalGate?.reasons ?? [])].sort(), failing })
}

// A finding repaired once is never repaired again: the same culprit for the
// same failing checks is the same finding.
export function repairKey({ culprit_id, failing_contract_id = null, failing_checks = [], command = null }) {
  return JSON.stringify({ culprit_id, failing_contract_id, failing_checks: [...failing_checks].sort(), command })
}

export function repairProgress(history, { signature, key }) {
  const round = history.findIndex((item) => item.signature === signature)
  if (round !== -1) return { stop: true, reason: `no progress: final gate round ${history.length + 1} reproduced round ${round + 1}` }
  const repaired = history.findIndex((item) => item.key === key)
  if (repaired !== -1) return { stop: true, reason: `no progress: the finding of round ${repaired + 1} was already repaired once` }
  return { stop: false, reason: null }
}

// The first reason of a failed final Gate that a repair can act on, and the
// replay that attributes it. `sequence` is the integration order:
// { contract_id, commit, base, head } per integrated contract, `base` being
// the head its worktree was built from.
export function diagnoseFinalGate({ finalGate, sequence, baseRevision }) {
  const reasons = finalGate?.reasons ?? []
  const outside = reasons.find((reason) => reason.startsWith("outside-scope:"))
  if (outside) {
    return { disposition: "BLOCKED", reason: `the integrated diff left the approved footprint (${outside.slice("outside-scope:".length)}); that is a harness defect, not a Builder's` }
  }
  const gateFailure = reasons.find((reason) => reason.startsWith("contract-gate-failed:"))
  if (gateFailure) {
    const failingId = gateFailure.slice("contract-gate-failed:".length)
    const gate = (finalGate.checks ?? []).find((check) => check.contract_id === failingId)
    const failingChecks = (gate?.check_results ?? []).filter((item) => item.result === "FAIL").map((item) => item.check_id).sort()
    const position = sequence.findIndex((item) => item.contract_id === failingId)
    if (position === -1) return { disposition: "REPLAN", reason: `${failingId} failed the final gate but was never integrated` }
    const failing = sequence[position]
    const predecessors = sequence.slice(0, position).filter((item) => item.base === failing.base)
    const later = sequence.slice(position + 1)
    const steps = [
      { contract_id: failingId, op: "checkout", revision: failing.base, then_pick: failing.commit, label: `${failingId} alone on its base` },
      ...predecessors.map((item) => ({ contract_id: item.contract_id, op: "pick", commit: item.commit, label: `${item.contract_id} (same wave, integrated before)` })),
      ...later.map((item) => ({ contract_id: item.contract_id, op: "checkout", revision: item.head, label: `${item.contract_id} integrated` })),
    ]
    return {
      disposition: "REPLAY",
      kind: "contract-gate",
      failing_contract_id: failingId,
      failing_checks: failingChecks,
      output: gate?.output ?? null,
      steps,
    }
  }
  const commandFailure = reasons.find((reason) => reason.startsWith("final-verification-failed:"))
  if (commandFailure) {
    const command = commandFailure.slice("final-verification-failed:".length)
    const gate = (finalGate.checks ?? []).find((check) => check.contract_id === null && check.command === command)
    const steps = [
      { contract_id: null, op: "checkout", revision: baseRevision, label: "base revision" },
      ...sequence.map((item) => ({ contract_id: item.contract_id, op: "checkout", revision: item.head, label: `${item.contract_id} integrated` })),
    ]
    return { disposition: "REPLAY", kind: "plan-command", command, output: gate?.output ?? null, steps }
  }
  return { disposition: "REPLAN", reason: `final gate failed for reasons no repair recognizes: ${reasons.join(", ")}` }
}

// `results` is one { pass } per step, in order. A contract gate must pass
// with the contract alone on its base; a plan-level command must have passed
// at some head. The first failure after that names the culprit. Anything
// else is inconclusive: the check is not deterministic, or the failure
// depends on something the replay cannot see, and the Planner gets the facts.
export function interpretReplay(diagnosis, results) {
  const steps = diagnosis.steps
  if (diagnosis.kind === "contract-gate") {
    if (!results[0]?.pass) {
      return { disposition: "REPLAN", reason: `${diagnosis.failing_contract_id}: its checks ${diagnosis.failing_checks.join(", ")} fail with the contract alone on its base; the failure is not an interaction the replay can attribute` }
    }
    const broken = results.findIndex((item, index) => index > 0 && !item.pass)
    if (broken === -1) return { disposition: "REPLAN", reason: `${diagnosis.failing_contract_id}: the failure does not reproduce along the integration branch; the checks are not deterministic` }
    return { disposition: "REPAIR", culprit_id: steps[broken].contract_id, at: steps[broken].label }
  }
  const passed = results.findIndex((item) => item.pass)
  if (passed === -1) return { disposition: "REPLAN", reason: `plan-level command never passed at any integration head, including the base: ${diagnosis.command}` }
  const broken = results.findIndex((item, index) => index > passed && !item.pass)
  if (broken === -1) return { disposition: "REPLAN", reason: `plan-level command does not fail along the integration branch on replay; it is not deterministic: ${diagnosis.command}` }
  return { disposition: "REPAIR", culprit_id: steps[broken].contract_id, at: steps[broken].label }
}

function prefixed(contractId, id) {
  return `${contractId}.${id}`
}

// The repair contract is composed from the two contracts involved, both
// already approved: the culprit (whose commit broke the checks) and the
// failing one. Every check both contracts carry travels with it; a check the
// final Gate saw failing on the integrated tree covers a `change`
// requirement (it must fail on the repair's baseline, the integration head,
// and pass afterwards), every other one a `preserve` requirement. The scope
// is the union of both contracts' approved paths, the risk the highest of
// the two: nothing the user did not already accept.
export function composeRepairContract({ round, culprit, failing = null, culpritRisk, failingRisk = null, finalGate, command = null, diagnosis }) {
  const involved = failing && failing.contract_id !== culprit.contract_id ? [culprit, failing] : [culprit]
  const failingByContract = new Map(
    (finalGate?.checks ?? [])
      .filter((check) => check.contract_id)
      .map((check) => [check.contract_id, new Set((check.check_results ?? []).filter((item) => item.result === "FAIL").map((item) => item.check_id))]),
  )
  const requirements = []
  const checks = []
  for (const contract of involved) {
    const failed = failingByContract.get(contract.contract_id) ?? new Set()
    const changed = new Set()
    for (const check of contractChecks(contract)) {
      if (failed.has(check.id)) for (const id of check.covers ?? []) changed.add(id)
    }
    for (const requirement of contractRequirements(contract)) {
      if (requirement.verification !== "automated") continue
      requirements.push({
        id: prefixed(contract.contract_id, requirement.id),
        statement: `[${contract.contract_id}] ${requirement.statement}`,
        kind: changed.has(requirement.id) ? "change" : "preserve",
        verification: "automated",
        covers: requirement.covers,
      })
    }
    for (const check of contractChecks(contract)) {
      checks.push({
        id: prefixed(contract.contract_id, check.id),
        covers: (check.covers ?? []).map((id) => prefixed(contract.contract_id, id)),
        command: check.source_command ?? check.command,
        origin: { contract_id: contract.contract_id, check_id: check.id },
      })
    }
  }
  if (command) {
    requirements.push({ id: "plan.final", statement: `plan-level final verification passes: ${command}`, kind: "change", verification: "automated", covers: [] })
    checks.push({ id: "plan.final", covers: ["plan.final"], command, origin: null })
  }
  const allowed = unique(involved.flatMap((contract) => contract.allowed_to_modify ?? []))
  const forbidden = unique(involved.flatMap((contract) => contract.forbidden ?? [])).filter((pattern) => !allowed.some((path) => overlaps(path, pattern)))
  const read = unique([...involved.flatMap((contract) => contract.read ?? []), ...allowed])
  const failingText = failing
    ? `checks ${diagnosis.failing_checks.join(", ")} of ${failing.contract_id}`
    : `the plan-level command ${JSON.stringify(command)}`
  return {
    contract_id: `${culprit.contract_id}.repair-${round}`,
    objective: `Repair: ${failingText} pass in isolation but fail on the integrated tree after ${culprit.contract_id} (${diagnosis.at}). Make them pass again while keeping every other check of ${involved.map((item) => item.contract_id).join(" and ")} passing. Objectives being repaired: ${involved.map((item) => `${item.contract_id}: ${item.objective}`).join("; ")}`,
    work_class: culprit.work_class,
    risk: maxRisk(culpritRisk ?? culprit.risk, failingRisk ?? failing?.risk),
    read,
    allowed_to_modify: allowed,
    forbidden,
    requirements,
    verification: {
      checks,
      invariants: unique([
        ...involved.flatMap((contract) => contract.verification?.invariants ?? []),
        "Repair: change only what the failing checks need; behavior the passing checks verify stays as it is",
      ]),
    },
    response: culprit.response ?? ["status", "changed files", "checks run", "blockers"],
    repair: {
      kind: "final-gate",
      round,
      parent_contract_id: culprit.contract_id,
      failing_contract_id: failing?.contract_id ?? null,
      failing_checks: diagnosis.failing_checks ?? [],
      command,
      attributed_at: diagnosis.at,
    },
  }
}

// The finding the Router classifies before the repair runs (derived-work).
// By construction a composed repair stays inside the approved footprint,
// inherits an accepted risk, and has a real Gate; the Router still decides,
// so the admission is one place, not an assumption in the orchestrator.
export function repairFinding(contract, { footprint, evidence }) {
  const inside = (contract.allowed_to_modify ?? []).every((path) => footprint.some((pattern) => overlaps(pattern, path)))
  return {
    parent_contract_id: contract.repair?.parent_contract_id ?? null,
    evidence,
    required_for_goal: true,
    within_goal_scope: inside,
    localized: true,
    risk_accepted: true,
    existing_gate: (contract.verification?.checks ?? []).length > 0,
    allowed_to_modify: contract.allowed_to_modify ?? [],
    needs_product_decision: false,
    changes_architecture: false,
    changes_dependencies: false,
    changes_api: false,
  }
}
