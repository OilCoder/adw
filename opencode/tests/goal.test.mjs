import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { renderGoalMarkdown, validateGoal } from "../.opencode/codegen/lib/goal.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))

async function fixtureGoal() {
  return JSON.parse(await readFile(path.join(here, "fixtures/goal-research/goal.json"), "utf8"))
}

function sealed(goal) {
  return {
    ...goal,
    status: "SEALED",
    research_questions: goal.research_questions.map((item) => ({ ...item, status: "completed" })),
    decisions: [
      {
        id: "DEC-1",
        question: "Application check or database constraint?",
        decision: "Database constraint mapped to a domain error",
        rationale: "Avoids the race condition",
        research_report_ids: ["RR-1"],
      },
    ],
  }
}

test("fixture goal validates and renders every section", async () => {
  const goal = await fixtureGoal()
  assert.deepEqual(validateGoal(goal), { valid: true, errors: [] })
  const markdown = renderGoalMarkdown(goal)
  for (const heading of [
    "## Summary",
    "## Objective",
    "## In Scope",
    "## Out of Scope",
    "## Requirements",
    "## Constraints",
    "## Success Metrics",
    "## Acceptance Criteria",
    "## Decisions",
    "## Research Questions",
    "## Open Questions",
    "## Routing Signals",
    "## Budgets",
  ]) {
    assert.ok(markdown.includes(heading), `missing ${heading}`)
  }
  assert.ok(markdown.includes("**MUST** `REQ-1`"))
  assert.ok(markdown.includes("`RQ-1` [pending]"))
  assert.ok(markdown.includes("## Decisions\n\n- None"))
  assert.ok(!markdown.includes("undefined"))
})

test("sealed goal renders decisions and never prints undefined", async () => {
  const goal = sealed(await fixtureGoal())
  assert.deepEqual(validateGoal(goal), { valid: true, errors: [] })
  const markdown = renderGoalMarkdown(goal)
  assert.ok(markdown.includes("`DEC-1` Database constraint mapped to a domain error - Avoids the race condition"))
  assert.ok(!markdown.includes("undefined"))
})

test("validator rejects structural problems", async () => {
  const goal = await fixtureGoal()
  const cases = [
    [{ ...goal, status: "DONE" }, "status is invalid"],
    [{ ...goal, in_scope: [] }, "in_scope cannot be empty"],
    [{ ...goal, requirements: [{ id: "REQ-1", statement: "x", priority: "urgent" }] }, "REQ-1: priority is invalid"],
    [
      { ...goal, requirements: [...goal.requirements, { id: "REQ-1", statement: "dup", priority: "must" }] },
      "duplicate artifact id: REQ-1",
    ],
    [{ ...goal, success_metrics: [{ id: "MET-1", metric: "x" }] }, "MET-1: target is required"],
    [
      { ...goal, acceptance_criteria: [{ id: "ACC-1", criterion: "x", verification_type: "vibes" }] },
      "ACC-1: verification_type is invalid",
    ],
    [{ ...goal, constraints: [{ id: "CON-1" }] }, "CON-1: statement is required"],
    [
      { ...goal, decisions: [{ id: "DEC-1", question: "q", decision: "d", rationale: "", research_report_ids: [] }] },
      "DEC-1: rationale is required",
    ],
    [
      { ...goal, decisions: [{ id: "DEC-1", question: "q", decision: "d", rationale: "r", research_report_ids: "RR-1" }] },
      "DEC-1: research_report_ids must be an array of report ids",
    ],
    [{ ...goal, open_questions: [{ id: "OQ-1", question: "q", blocking: "yes" }] }, "OQ-1: blocking must be boolean"],
    [
      { ...goal, research_questions: [{ ...goal.research_questions[0], allowed_source_types: [] }] },
      "RQ-1: allowed_source_types cannot be empty",
    ],
    [
      { ...goal, research_questions: [{ ...goal.research_questions[0], budget: { max_sources: 0, max_minutes: 5 } }] },
      "RQ-1: max_sources must be at least 1",
    ],
    [{ ...goal, routing: { ...goal.routing, risk: "extreme" } }, "routing shape or risk is invalid"],
    [{ ...goal, routing: { ...goal.routing, existing_gate: "yes" } }, "routing.existing_gate must be boolean"],
    [{ ...goal, budgets: { ...goal.budgets, max_planner_calls: -1 } }, "budgets.max_planner_calls must be a non-negative integer"],
    [{ ...goal, budgets: { ...goal.budgets, max_research_questions: 0 } }, "research question count exceeds its budget"],
  ]
  for (const [candidate, expected] of cases) {
    const result = validateGoal(candidate)
    assert.equal(result.valid, false)
    assert.ok(result.errors.includes(expected), `expected "${expected}" in ${result.errors}`)
  }
})

test("SEALED rules: no blocking questions, no pending required research, decisions for deliberative signals", async () => {
  const goal = await fixtureGoal()
  const pending = { ...goal, status: "SEALED" }
  assert.ok(validateGoal(pending).errors.includes("SEALED goal cannot contain required pending research"))

  const blocking = {
    ...sealed(goal),
    open_questions: [{ id: "OQ-1", question: "Which error code?", blocking: true }],
  }
  assert.ok(validateGoal(blocking).errors.includes("SEALED goal cannot contain blocking open questions"))

  const undecided = { ...sealed(goal), decisions: [] }
  assert.ok(
    validateGoal(undecided).errors.includes(
      "SEALED goal with deliberative signals must record at least one decision",
    ),
  )

  const plain = {
    ...sealed(goal),
    decisions: [],
    routing: { ...goal.routing, external_research_required: false },
  }
  assert.deepEqual(validateGoal(plain), { valid: true, errors: [] })

  const waived = {
    ...sealed(goal),
    research_questions: goal.research_questions.map((item) => ({ ...item, status: "waived" })),
  }
  assert.deepEqual(validateGoal(waived), { valid: true, errors: [] })
})

test("renderer refuses an invalid goal", async () => {
  const goal = await fixtureGoal()
  assert.throws(() => renderGoalMarkdown({ ...goal, title: "" }), /Cannot render invalid goal/)
})

test("a Goal with no planner budget is invalid because nothing could ever build it", async () => {
  const goal = JSON.parse(await readFile(path.join(here, "fixtures/goal-research/goal.json"), "utf8"))
  goal.budgets.max_planner_calls = 0
  const result = validateGoal(goal)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((error) => error.includes("max_planner_calls must be at least 1")))
})

test("budgets a model wrote are clamped to the system limits and the adjustments are rendered", async () => {
  const { applyGoalLimits, renderGoalMarkdown } = await import("../.opencode/codegen/lib/goal.mjs")
  const { readFile } = await import("node:fs/promises")
  const limits = JSON.parse(await readFile(new URL("../.opencode/codegen/config/budgets.json", import.meta.url), "utf8"))
  const goal = JSON.parse(await readFile(new URL("./fixtures/goal-research/goal.json", import.meta.url), "utf8"))
  const greedy = { ...goal, budgets: { max_research_questions: 9, max_research_calls: 0, max_planner_calls: 7, max_derived_tasks: 3 } }
  const { goal: clamped, adjustments } = applyGoalLimits(greedy, limits)
  assert.deepEqual(clamped.budgets, { max_research_questions: 5, max_research_calls: 1, max_planner_calls: 3, max_derived_tasks: 3 })
  assert.deepEqual(adjustments.map((item) => [item.field, item.from, item.to]), [
    ["budgets.max_research_questions", 9, 5],
    ["budgets.max_research_calls", 0, 1],
    ["budgets.max_planner_calls", 7, 3],
  ])
  assert.match(adjustments[1].reason, /1 required pending research question/)
  assert.deepEqual(applyGoalLimits(goal, limits).adjustments, [], "a Goal within limits is untouched")
  const markdown = renderGoalMarkdown(clamped, { adjustments })
  assert.ok(markdown.includes("## Budget adjustments"))
  assert.ok(markdown.includes("`budgets.max_planner_calls`: 7 → 3 (above the system ceiling 3)"))
  assert.ok(!renderGoalMarkdown(clamped).includes("## Budget adjustments"))
})
