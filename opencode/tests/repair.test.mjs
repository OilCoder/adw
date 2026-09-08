import assert from "node:assert/strict"
import test from "node:test"

import { validateRequirementsAndChecks } from "../.opencode/codegen/lib/plan-validation.mjs"
import {
  composeRepairContract,
  diagnoseFinalGate,
  finalGateSignature,
  interpretReplay,
  repairFinding,
  repairKey,
  repairProgress,
} from "../.opencode/codegen/lib/repair.mjs"
import { routeDerivedWork } from "../.opencode/codegen/lib/derived-work.mjs"

const alpha = {
  contract_id: "alpha", objective: "Implement alpha", work_class: "w", risk: "low",
  read: ["lib/alpha.py"], allowed_to_modify: ["lib/alpha.py"], forbidden: ["tests/**", "lib/beta.py"],
  requirements: [
    { id: "R1", statement: "doubles", kind: "change", verification: "automated", covers: ["REQ-1"] },
    { id: "R2", statement: "compatible with beta", kind: "preserve", verification: "automated", covers: ["REQ-1"] },
    { id: "R3", statement: "readable", verification: "manual", covers: [] },
  ],
  verification: { checks: [{ id: "C1", covers: ["R1"], command: "t1" }, { id: "C2", covers: ["R2"], command: "t2" }], invariants: ["only alpha"] },
  response: ["status"],
}
const beta = {
  contract_id: "beta", objective: "Implement beta", work_class: "w", risk: "medium",
  read: ["lib/beta.py"], allowed_to_modify: ["lib/beta.py"], forbidden: ["tests/**", "lib/alpha.py"],
  requirements: [{ id: "R1", statement: "adds three", kind: "change", verification: "automated", covers: ["REQ-1"] }],
  verification: { checks: [{ id: "C1", covers: ["R1"], command: "bash .codegen-contract/checks/C1.sh", source_command: "t3" }], invariants: ["only beta"] },
  response: ["status"],
}
const finalGate = {
  result: "FAIL",
  reasons: ["contract-gate-failed:alpha", "final-verification-failed:all"],
  checks: [
    { contract_id: "alpha", exit_code: 1, check_results: [{ check_id: "C1", result: "PASS" }, { check_id: "C2", result: "FAIL" }], output: "boom" },
    { contract_id: "beta", exit_code: 0, check_results: [{ check_id: "C1", result: "PASS" }], output: "" },
    { contract_id: null, command: "all", exit_code: 1, check_results: [], output: "x" },
  ],
}
const sequence = [
  { contract_id: "alpha", commit: "a1", base: "b0", head: "h1" },
  { contract_id: "beta", commit: "b1", base: "b0", head: "h2" },
  { contract_id: "gamma", commit: "g1", base: "h2", head: "h3" },
]

test("the signature of a failed final gate names the reasons and the failing checks per contract, order-independent", () => {
  const signature = finalGateSignature(finalGate)
  const reordered = finalGateSignature({ ...finalGate, reasons: [...finalGate.reasons].reverse(), checks: [...finalGate.checks].reverse() })
  assert.equal(signature, reordered)
  assert.notEqual(signature, finalGateSignature({ ...finalGate, reasons: ["contract-gate-failed:beta"] }))
})

test("a round that reproduces an earlier signature, or a finding repaired once, stops the loop", () => {
  const key = repairKey({ culprit_id: "beta", failing_contract_id: "alpha", failing_checks: ["C2"] })
  assert.equal(repairProgress([], { signature: "s1", key }).stop, false)
  assert.match(repairProgress([{ signature: "s1", key: "k0" }], { signature: "s1", key }).reason, /round 2 reproduced round 1/)
  assert.match(repairProgress([{ signature: "s0", key }], { signature: "s1", key }).reason, /already repaired once/)
  assert.equal(repairKey({ culprit_id: "beta", failing_checks: ["C2", "C1"] }), repairKey({ culprit_id: "beta", failing_checks: ["C1", "C2"] }))
})

test("diagnosis: a contract gate failure replays the contract alone on its base, its same-wave predecessors, then the later heads", () => {
  const diagnosis = diagnoseFinalGate({ finalGate, sequence, baseRevision: "b0" })
  assert.equal(diagnosis.disposition, "REPLAY")
  assert.equal(diagnosis.kind, "contract-gate")
  assert.equal(diagnosis.failing_contract_id, "alpha")
  assert.deepEqual(diagnosis.failing_checks, ["C2"])
  assert.deepEqual(diagnosis.steps.map((step) => [step.contract_id, step.op, step.revision ?? step.commit, step.then_pick ?? null]), [
    ["alpha", "checkout", "b0", "a1"],
    ["beta", "checkout", "h2", null],
    ["gamma", "checkout", "h3", null],
  ])
  // Beta failing: alpha, integrated before it in the same wave, is picked on top of beta alone.
  const betaGate = { ...finalGate, reasons: ["contract-gate-failed:beta"] }
  const betaDiagnosis = diagnoseFinalGate({ finalGate: betaGate, sequence, baseRevision: "b0" })
  assert.deepEqual(betaDiagnosis.steps.map((step) => [step.contract_id, step.op]), [["beta", "checkout"], ["alpha", "pick"], ["gamma", "checkout"]])
  assert.equal(interpretReplay(diagnosis, [{ pass: true }, { pass: false }, { pass: false }]).culprit_id, "beta")
  assert.equal(interpretReplay(diagnosis, [{ pass: false }]).disposition, "REPLAN")
  assert.equal(interpretReplay(diagnosis, [{ pass: true }, { pass: true }, { pass: true }]).disposition, "REPLAN")
})

test("diagnosis: a plan-level command replays from the base; it needs a passing head before a failing one", () => {
  const commandGate = { ...finalGate, reasons: ["final-verification-failed:all"] }
  const diagnosis = diagnoseFinalGate({ finalGate: commandGate, sequence, baseRevision: "b0" })
  assert.equal(diagnosis.kind, "plan-command")
  assert.deepEqual(diagnosis.steps.map((step) => step.contract_id), [null, "alpha", "beta", "gamma"])
  assert.equal(interpretReplay(diagnosis, [{ pass: true }, { pass: true }, { pass: false }, { pass: false }]).culprit_id, "beta")
  assert.match(interpretReplay(diagnosis, [{ pass: false }, { pass: false }, { pass: false }, { pass: false }]).reason, /never passed/)
  assert.equal(diagnoseFinalGate({ finalGate: { reasons: ["outside-scope:x.py"], checks: [] }, sequence, baseRevision: "b0" }).disposition, "BLOCKED")
})

test("the composed repair contract keeps both contracts' checks, marks the failing ones as change, unions the scope, and validates", () => {
  const contract = composeRepairContract({
    round: 1, culprit: beta, failing: alpha, culpritRisk: "medium", failingRisk: "low", finalGate,
    diagnosis: { failing_checks: ["C2"], at: "beta (same wave, integrated before)" },
  })
  assert.equal(contract.contract_id, "beta.repair-1")
  assert.equal(contract.risk, "medium")
  assert.deepEqual(contract.allowed_to_modify, ["lib/beta.py", "lib/alpha.py"])
  assert.deepEqual(contract.forbidden, ["tests/**"])
  assert.deepEqual(contract.requirements.map((r) => [r.id, r.kind, r.covers]), [["beta.R1", "preserve", ["REQ-1"]], ["alpha.R1", "preserve", ["REQ-1"]], ["alpha.R2", "change", ["REQ-1"]]])
  assert.deepEqual(contract.verification.checks.map((c) => [c.id, c.command, c.covers, c.origin]), [
    ["beta.C1", "t3", ["beta.R1"], { contract_id: "beta", check_id: "C1" }],
    ["alpha.C1", "t1", ["alpha.R1"], { contract_id: "alpha", check_id: "C1" }],
    ["alpha.C2", "t2", ["alpha.R2"], { contract_id: "alpha", check_id: "C2" }],
  ])
  assert.equal(contract.repair.parent_contract_id, "beta")
  const errors = []
  validateRequirementsAndChecks(contract, contract.contract_id, errors)
  assert.deepEqual(errors, [])
  const finding = repairFinding(contract, { footprint: ["lib/alpha.py", "lib/beta.py", "lib/gamma.py"], evidence: ["round 1"] })
  assert.equal(routeDerivedWork(finding).disposition, "DIRECT_REPAIR")
  assert.equal(routeDerivedWork(repairFinding(contract, { footprint: ["lib/gamma.py"], evidence: ["round 1"] })).disposition, "REPLAN_REQUIRED")
  // A plan-level command adds its own change requirement on the culprit alone.
  const commandRepair = composeRepairContract({ round: 2, culprit: beta, culpritRisk: "low", finalGate, command: "all", diagnosis: { at: "beta integrated" } })
  assert.deepEqual(commandRepair.requirements.map((r) => [r.id, r.kind]), [["beta.R1", "preserve"], ["plan.final", "change"]])
  assert.deepEqual(commandRepair.allowed_to_modify, ["lib/beta.py"])
})
