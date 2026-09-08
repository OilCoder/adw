import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { routeGoal } from "../.opencode/codegen/lib/goal-routing.mjs"
import { approvalRecord } from "../.opencode/codegen/lib/goal.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))

async function fixtureGoal() {
  return JSON.parse(await readFile(path.join(here, "fixtures/goal-research/goal.json"), "utf8"))
}

const decision = {
  id: "DEC-1",
  question: "Application check or database constraint?",
  decision: "Database constraint",
  rationale: "Avoids the race condition",
  research_report_ids: ["RR-1"],
}

function approved(goal) {
  return { ...goal, status: "SEALED", approval: approvalRecord(goal) }
}

function sealedDirect(goal) {
  return approved({
    ...goal,
    research_questions: [],
    decisions: [],
    routing: { ...goal.routing, external_research_required: false },
  })
}

test("invalid goal is reported, not routed", async () => {
  const goal = await fixtureGoal()
  const result = routeGoal({ ...goal, title: "" })
  assert.equal(result.status, "INVALID_GOAL")
  assert.equal(result.route, null)
})

test("open goal with pending required research is not routed: it needs deliberation before the seal", async () => {
  const goal = await fixtureGoal()
  const result = routeGoal(goal)
  assert.equal(result.status, "GOAL_NOT_SEALED")
  assert.equal(result.route, null)
  assert.equal(result.needs_deliberation, true)
  assert.deepEqual(result.reasons, ["external-research-required", "required-research-pending"])
  assert.deepEqual(result.pending, { research_questions: ["RQ-1"], blocking_questions: [] })
})

test("architecture uncertainty and blocking questions keep an open goal out of the Router", async () => {
  const goal = await fixtureGoal()
  const result = routeGoal({
    ...goal,
    research_questions: [],
    open_questions: [{ id: "OQ-1", question: "Which error code?", blocking: true }],
    routing: { ...goal.routing, external_research_required: false, architecture_uncertainty: true },
  })
  assert.equal(result.status, "GOAL_NOT_SEALED")
  assert.equal(result.needs_deliberation, true)
  assert.deepEqual(result.reasons, ["architecture-uncertainty", "blocking-questions-open"])
  assert.deepEqual(result.pending.blocking_questions, ["OQ-1"])
})

test("open goal without deliberative signals waits for user approval", async () => {
  const goal = await fixtureGoal()
  const { approval, ...open } = sealedDirect(goal)
  const result = routeGoal({ ...open, status: "DECIDED" })
  assert.equal(result.status, "GOAL_NOT_SEALED")
  assert.equal(result.needs_deliberation, false)
  assert.deepEqual(result.reasons, ["goal-requires-user-approval"])
})

test("sealed localized low-risk goal with an existing gate routes direct", async () => {
  const goal = await fixtureGoal()
  const result = routeGoal(sealedDirect(goal))
  assert.equal(result.route, "direct")
  assert.deepEqual(result.reasons, ["localized", "low-risk", "existing-gate"])
})

test("sealed goal that needs a gate or spans components routes planned", async () => {
  const goal = await fixtureGoal()
  const noGate = routeGoal(approved({
    ...sealedDirect(goal),
    routing: { ...sealedDirect(goal).routing, existing_gate: false },
  }))
  assert.equal(noGate.route, "planned")
  assert.ok(noGate.reasons.includes("gate-preparation-may-be-required"))

  const multi = routeGoal(approved({
    ...sealedDirect(goal),
    routing: { ...sealedDirect(goal).routing, change_shape: "multi-component", risk: "medium" },
  }))
  assert.equal(multi.route, "planned")
  assert.deepEqual(multi.reasons, ["shape:multi-component", "risk:medium"])
  assert.ok(multi.allowed_events.includes("PLAN_REQUESTED"))
})

test("sealed goal with recorded deliberation never routes direct", async () => {
  const goal = await fixtureGoal()
  const result = routeGoal(approved({
    ...goal,
    decisions: [decision],
    research_questions: goal.research_questions.map((item) => ({ ...item, status: "completed" })),
  }))
  assert.equal(result.status, "ROUTED")
  assert.equal(result.route, "planned")
  assert.ok(result.reasons.includes("deliberation-recorded"))
})
