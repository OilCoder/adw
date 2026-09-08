import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { approvalRecord, goalDigest, renderGoalMarkdown, sealApprovedGoal, validateGoal } from "../.opencode/codegen/lib/goal.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))

async function fixtureGoal() {
  return JSON.parse(await readFile(path.join(here, "fixtures/goal-research/goal.json"), "utf8"))
}

// Seals a Goal the way approval does: status plus the approval record whose
// digest matches the content. Edits after sealing break the digest on purpose.
function approve(goal) {
  return { ...goal, status: "SEALED", approval: approvalRecord(goal) }
}

function decided(goal) {
  return {
    ...goal,
    status: "DECIDED",
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

function sealed(goal) {
  return approve(decided(goal))
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
  assert.ok(markdown.includes(`**Approved:** by user at ${goal.approval.approved_at} via \`run-goal --approve\`; digest \`${goal.approval.goal_digest}\``))
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
    [{ ...goal, routing: { ...goal.routing, risk: "extreme" } }, "routing shape or risk is invalid"],
    [{ ...goal, routing: { ...goal.routing, existing_gate: "yes" } }, "routing.existing_gate must be boolean"],
  ]
  for (const [candidate, expected] of cases) {
    const result = validateGoal(candidate)
    assert.equal(result.valid, false)
    assert.ok(result.errors.includes(expected), `expected "${expected}" in ${result.errors}`)
  }
})

test("SEALED rules: no blocking questions, no pending required research, decisions for deliberative signals", async () => {
  const goal = await fixtureGoal()
  const pending = approve(goal)
  assert.ok(validateGoal(pending).errors.includes("SEALED goal cannot contain required pending research"))

  const blocking = approve({
    ...decided(goal),
    open_questions: [{ id: "OQ-1", question: "Which error code?", blocking: true }],
  })
  assert.ok(validateGoal(blocking).errors.includes("SEALED goal cannot contain blocking open questions"))

  const undecided = approve({ ...decided(goal), decisions: [] })
  assert.ok(
    validateGoal(undecided).errors.includes(
      "SEALED goal with deliberative signals must record at least one decision",
    ),
  )

  const plain = approve({
    ...decided(goal),
    decisions: [],
    routing: { ...goal.routing, external_research_required: false },
  })
  assert.deepEqual(validateGoal(plain), { valid: true, errors: [] })

  const waived = approve({
    ...decided(goal),
    research_questions: goal.research_questions.map((item) => ({ ...item, status: "waived" })),
  })
  assert.deepEqual(validateGoal(waived), { valid: true, errors: [] })
})

test("the seal is evidence: a SEALED goal needs an approval record whose digest matches its content", async () => {
  const goal = await fixtureGoal()
  const bare = { ...decided(goal), status: "SEALED" }
  assert.ok(validateGoal(bare).errors.some((error) => /must carry an approval record/.test(error)))
  const edited = { ...sealed(goal), objective: "something else" }
  assert.ok(validateGoal(edited).errors.some((error) => /goal_digest does not match/.test(error)))
  const early = { ...decided(goal), approval: approvalRecord(decided(goal)) }
  assert.ok(validateGoal(early).errors.includes("approval is only recorded on a SEALED goal"))
  const machine = { ...sealed(goal), approval: { ...sealed(goal).approval, approved_by: "model" } }
  assert.ok(validateGoal(machine).errors.some((error) => /approved_by must be user/.test(error)))
  // The digest ignores status and the approval record itself, so the draft the user read and the sealed Goal agree.
  assert.equal(goalDigest(decided(goal)), goalDigest(sealed(goal)))
  assert.notEqual(goalDigest(decided(goal)), goalDigest({ ...decided(goal), objective: "x" }))
})

test("sealApprovedGoal records the approval and refuses a Goal that changed since it was summarized", async () => {
  const goal = decided(await fixtureGoal())
  const now = new Date("2026-09-08T12:00:00.000Z")
  const result = sealApprovedGoal(goal, { digest: goalDigest(goal), via: "tool codegen_workflow approve", now })
  assert.equal(result.status, "SEALED")
  assert.deepEqual(result.approval, { approved_by: "user", approved_at: "2026-09-08T12:00:00.000Z", goal_digest: goalDigest(goal), via: "tool codegen_workflow approve" })
  assert.deepEqual(validateGoal(result), { valid: true, errors: [] })
  assert.throws(() => sealApprovedGoal({ ...goal, objective: "edited after the summary" }, { digest: goalDigest(goal) }), /Goal changed since it was summarized/)
  assert.throws(() => sealApprovedGoal(result, { digest: goalDigest(goal) }), /already SEALED/)
})

test("renderer refuses an invalid goal", async () => {
  const goal = await fixtureGoal()
  assert.throws(() => renderGoalMarkdown({ ...goal, title: "" }), /Cannot render invalid goal/)
})

test("a Goal carries no budgets: nothing caps research or planner calls, and GOAL.md has no Budgets section", async () => {
  const goal = JSON.parse(await readFile(path.join(here, "fixtures/goal-research/goal.json"), "utf8"))
  assert.equal(goal.budgets, undefined)
  assert.deepEqual(validateGoal(goal), { valid: true, errors: [] })
  assert.ok(!renderGoalMarkdown(goal).includes("## Budgets"))
})
