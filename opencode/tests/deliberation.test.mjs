import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { deliberationPlan, readyForApproval, verifyRevision } from "../.opencode/codegen/lib/deliberation.mjs"

const fixture = JSON.parse(await readFile(new URL("./fixtures/goal-research/goal.json", import.meta.url), "utf8"))
const decisionFixture = JSON.parse(await readFile(new URL("./fixtures/opinions/decision.json", import.meta.url), "utf8"))

function goalWith(overrides) {
  return { ...structuredClone(fixture), ...overrides }
}

test("plan: every required pending research question runs; optional ones never spend a call", () => {
  const plan = deliberationPlan(fixture)
  assert.equal(plan.status, "READY")
  assert.deepEqual(plan.research, ["RQ-1"])
  assert.deepEqual(plan.opinions, [])
  const optionalFirst = goalWith({
    research_questions: [
      { ...fixture.research_questions[0], id: "RQ-0", required: false },
      fixture.research_questions[0],
    ],
  })
  assert.deepEqual(deliberationPlan(optionalFirst).research, ["RQ-1"], "only required research runs")
  const optionalOnly = goalWith({ research_questions: [{ ...fixture.research_questions[0], required: false }] })
  assert.equal(deliberationPlan(optionalOnly).status, "NOTHING_TO_DELIBERATE", "an optional question never spends a Researcher call")
})

test("plan: evidence already on disk is folded in without re-running, and nothing caps required research", () => {
  const folded = deliberationPlan(fixture, { reports: ["RQ-1"] })
  assert.equal(folded.status, "READY")
  assert.deepEqual(folded.research, [])
  const two = goalWith({ research_questions: [fixture.research_questions[0], { ...fixture.research_questions[0], id: "RQ-2" }] })
  assert.deepEqual(deliberationPlan(two).research, ["RQ-1", "RQ-2"], "every required pending question is researched")
})

test("plan: blocking questions need a closed option set; otherwise the user decides", () => {
  const withOptions = goalWith({ open_questions: [{ id: "OQ-1", question: "A or B?", blocking: true, options: ["a", "b"] }] })
  assert.deepEqual(deliberationPlan(withOptions).opinions, ["OQ-1"])
  assert.deepEqual(deliberationPlan(withOptions, { decisions: ["OQ-1"] }).opinions, [])
  const open = goalWith({ open_questions: [{ id: "OQ-2", question: "What colour?", blocking: true }] })
  const plan = deliberationPlan(open)
  assert.equal(plan.status, "USER_DECISION_REQUIRED")
  assert.deepEqual(plan.user_decisions, ["OQ-2"])
})

test("plan: a Goal with nothing open has nothing to deliberate", () => {
  const done = goalWith({ research_questions: [{ ...fixture.research_questions[0], status: "completed" }], decisions: [{ id: "D-1", question: "q", decision: "d", rationale: "r", research_report_ids: ["RR-1"] }] })
  assert.equal(deliberationPlan(done).status, "NOTHING_TO_DELIBERATE")
  assert.equal(readyForApproval(done), true)
  assert.equal(readyForApproval(fixture), false, "pending required research blocks sealing")
})

test("verifyRevision checks the revision against the evidence, not the model's word", () => {
  const reports = [{ question_id: "RQ-1", report_id: "RR-1" }]
  const decisions = [{ ...decisionFixture }]
  const before = goalWith({ open_questions: [{ id: "OQ-1", question: decisionFixture.question, blocking: true, options: ["application-check", "database-constraint"] }] })
  const good = goalWith({
    status: "DECIDED",
    research_questions: [{ ...fixture.research_questions[0], status: "completed" }],
    open_questions: [{ id: "OQ-1", question: decisionFixture.question, blocking: false, options: ["application-check", "database-constraint"] }],
    decisions: [
      { id: "D-1", question: "ORM?", decision: "constraint", rationale: "r", research_report_ids: ["RR-1"] },
      { id: "D-2", question: decisionFixture.question, decision: "database-constraint", rationale: "r", research_report_ids: [], opinion_ids: decisionFixture.opinion_ids },
    ],
  })
  const ok = verifyRevision(before, good, { reports, decisions })
  assert.deepEqual(ok, { ok: true, errors: [], ready_for_approval: true })

  const stillPending = verifyRevision(before, { ...good, research_questions: fixture.research_questions }, { reports, decisions })
  assert.ok(stillPending.errors.some((e) => e.includes("RQ-1 still pending")))
  const blocked = verifyRevision(before, { ...good, research_questions: fixture.research_questions }, { reports: [{ ...reports[0], status: "BLOCKED" }], decisions })
  assert.ok(!blocked.errors.some((e) => e.includes("still pending")), "a BLOCKED report may leave the question pending")
  assert.equal(blocked.ready_for_approval, false, "required research still pending keeps the Goal open")
  const unrecorded = verifyRevision(before, { ...good, decisions: [good.decisions[0]] }, { reports, decisions })
  assert.ok(unrecorded.errors.some((e) => e.includes("DEC-OQ-1 is not recorded")))
  const sealed = verifyRevision(before, { ...good, status: "SEALED" }, { reports, decisions })
  assert.ok(sealed.errors.some((e) => e.includes("SEALED without user approval")))
  const renamed = verifyRevision(before, { ...good, goal_id: "other" }, { reports, decisions })
  assert.ok(renamed.errors.some((e) => e.includes("goal_id changed")))
})

test("verifyRevision: a report that answers nothing never completes its question", () => {
  const before = goalWith({})
  const completed = goalWith({ status: "DECIDED", research_questions: [{ ...fixture.research_questions[0], status: "completed" }], decisions: [{ id: "D-1", question: "q", decision: "d", rationale: "r", research_report_ids: ["RR-1"] }] })
  const unverified = [{ question_id: "RQ-1", report_id: "RR-1", status: "COMPLETE", answers: false }]
  const rejected = verifyRevision(before, completed, { reports: unverified })
  assert.ok(rejected.errors.some((e) => e.includes("RQ-1 marked completed although report RR-1 has no verified finding")), rejected.errors.join("\n"))
  const pending = verifyRevision(before, { ...completed, research_questions: fixture.research_questions }, { reports: unverified })
  assert.deepEqual(pending.errors, [], "the question may stay pending")
  assert.equal(pending.ready_for_approval, false)
  const waived = verifyRevision(before, { ...completed, research_questions: [{ ...fixture.research_questions[0], status: "waived" }] }, { reports: unverified })
  assert.deepEqual(waived.errors, [])
  const answering = verifyRevision(before, completed, { reports: [{ ...unverified[0], answers: true }] })
  assert.deepEqual(answering.errors, [])
})
