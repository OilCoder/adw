import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { goalCoverage, renderPlanMarkdown } from "../.opencode/codegen/lib/coverage.mjs"

async function fixtures() {
  const plan = JSON.parse(await readFile(new URL("./fixtures/orchestrator-basic/plan-template.json", import.meta.url), "utf8"))
  const goal = JSON.parse(await readFile(new URL("./fixtures/orchestrator-basic/.codegen-goal/goal.json", import.meta.url), "utf8"))
  return { plan, goal }
}

test("PLAN.md renders waves, contracts, checks, and Goal coverage; never for an invalid plan", async () => {
  const { plan, goal } = await fixtures()
  goal.requirements.push({ id: "REQ-2", statement: "Docs mention gamma", priority: "should" })
  goal.acceptance_criteria.push({ id: "ACC-2", criterion: "Reviewer likes the names", verification_type: "manual" })
  plan.phases[1].contracts[0].requirements.push({ id: "R2", statement: "gamma is documented", verification: "manual", covers: ["REQ-2"] })
  const markdown = renderPlanMarkdown(plan, goal)
  assert.ok(markdown.startsWith("# Plan `compose-pipeline`"))
  assert.ok(markdown.includes("Wave 1: `core`"), markdown)
  assert.ok(markdown.includes("Wave 2: `compose`"))
  assert.ok(markdown.includes("`REQ-1` [must] All unit tests pass — **covered** by `alpha/R1` [change, automated], `beta/R1` [change, automated], `gamma/R1` [change, automated]"), markdown)
  assert.ok(markdown.includes("`REQ-2` [should] Docs mention gamma — **MANUAL ONLY: no check proves it** by `gamma/R2` [change, manual]"), markdown)
  assert.ok(markdown.includes("`ACC-2` [manual] Reviewer likes the names — **pending human verification**"))
  assert.ok(markdown.includes("- `ACC-2` [manual] Reviewer likes the names\n- `gamma/R2` gamma is documented"), markdown)
  assert.ok(markdown.includes("`C1` (must fail on baseline) covers `R1`: `python3 -m unittest tests/test_alpha.py`"))
  assert.ok(markdown.includes("## Final verification"))
  assert.ok(!markdown.includes("undefined"))

  plan.phases[0].contracts[0].requirements[0].covers = ["REQ-1", "ACC-1", "NOPE"]
  assert.throws(() => renderPlanMarkdown(plan, goal), /Cannot render invalid plan/)

  // Without a Goal there is no coverage section, and a pure refactor is flagged.
  const bare = JSON.parse(await readFile(new URL("./fixtures/orchestrator-basic/plan-direct.json", import.meta.url), "utf8"))
  bare.phases[0].contracts[0].requirements[0].kind = "preserve"
  const plain = renderPlanMarkdown(bare)
  assert.ok(!plain.includes("## Goal coverage"))
  assert.ok(plain.includes("**Pure refactor: every requirement preserves behavior, so no check proves a change happened.**"))
  assert.ok(plain.includes("`C1` (must pass on baseline)"))
})

test("the coverage ledger reports per Goal id what passed, what failed, and what only a human can verify", async () => {
  const { plan, goal } = await fixtures()
  goal.acceptance_criteria.push({ id: "ACC-2", criterion: "Deployed to staging", verification_type: "operational" })
  plan.phases[1].contracts[0].requirements.push({ id: "R2", statement: "gamma is documented", verification: "manual", covers: ["REQ-1"] })
  const results = new Map([
    ["alpha", { status: "PASSED", checks: { C1: "PASS" } }],
    ["beta", { status: "PASSED", checks: { C1: "PASS" } }],
    ["gamma", { status: "PASSED", checks: { C1: "PASS" } }],
  ])
  const ledger = goalCoverage(plan, goal, results)
  const req = ledger.requirements[0]
  assert.equal(req.status, "VERIFIED")
  assert.deepEqual(req.claims.map((claim) => [claim.contract_id, claim.requirement_id, claim.status]), [
    ["alpha", "R1", "VERIFIED"], ["beta", "R1", "VERIFIED"], ["gamma", "R1", "VERIFIED"], ["gamma", "R2", "PENDING_HUMAN"],
  ])
  assert.deepEqual(req.claims[0].checks, [{ check_id: "C1", result: "PASS" }])
  assert.deepEqual(ledger.acceptance_criteria.map((item) => [item.id, item.status]), [["ACC-1", "VERIFIED"], ["ACC-2", "PENDING_HUMAN"]])
  assert.deepEqual(ledger.pending_human, [
    { id: "ACC-2", text: "Deployed to staging", source: "goal" },
    { id: "gamma/R2", text: "gamma is documented", source: "contract" },
  ])
  assert.deepEqual(ledger.summary, { verified: 2, failed: 0, not_verified: 0, pending_human: 2 })

  // One failed check on one contract fails every Goal id that contract claimed.
  results.set("beta", { status: "PASSED", checks: { C1: "FAIL" } })
  const failed = goalCoverage(plan, goal, results)
  assert.equal(failed.requirements[0].status, "FAILED")
  assert.equal(failed.acceptance_criteria[0].status, "FAILED")
  assert.equal(failed.summary.failed, 2)

  // A contract that never ran leaves its claims unverified.
  const partial = goalCoverage(plan, goal, new Map([["alpha", { status: "PASSED", checks: { C1: "PASS" } }]]))
  assert.equal(partial.requirements[0].status, "NOT_VERIFIED")
  assert.equal(partial.requirements[0].claims[1].status, "NOT_RUN")
})

test("PLAN.md shows the triage against the Goal's labels and the budget adjustments", async () => {
  const { plan, goal } = await fixtures()
  const limits = JSON.parse(await readFile(new URL("../.opencode/codegen/config/budgets.json", import.meta.url), "utf8"))
  const riskFloors = JSON.parse(await readFile(new URL("../.opencode/codegen/config/risk-floors.json", import.meta.url), "utf8"))
  plan.phases[0].contracts[0].allowed_to_modify = ["lib/alpha.py", "package.json"]
  plan.phases[0].contracts[0].budgets.max_builder_attempts = 9
  const lowGoal = { ...goal, routing: { ...goal.routing, risk: "low" } }
  const markdown = renderPlanMarkdown(plan, lowGoal, { route: "planned", riskFloors, limits })
  assert.ok(markdown.includes("## Triage"), markdown)
  assert.ok(markdown.includes("- Route: Goal `planned` → effective `planned`"))
  assert.ok(markdown.includes("- Risk: Goal `low` → effective `medium`"))
  assert.ok(markdown.includes("`alpha`: declared `low`, floor `medium`, effective `medium` (package.json: dependency manifest or lockfile)"), markdown)
  assert.ok(markdown.includes("**Triage contradictions (approving this plan accepts the effective values):**"))
  assert.ok(markdown.includes("`risk`: Goal said `low`, evidence: alpha: may modify package.json, dependency manifest or lockfile (floor medium) → effective `medium`"))
  assert.ok(markdown.includes("## Budget adjustments"))
  assert.ok(markdown.includes("`alpha` `budgets.max_builder_attempts`: 9 → 3 (above the system ceiling 3 for the planned route)"))

  const clean = renderPlanMarkdown((await fixtures()).plan, goal, { route: "planned", riskFloors, limits })
  assert.ok(clean.includes("No triage contradictions: the plan fits the Goal's labels."))
  assert.ok(!clean.includes("## Budget adjustments"))
})
