// Deliberation (CODE_GENERATION_FLOW §8.3): research pending questions, obtain
// independent opinions on blocking questions with a closed option set, then let
// the Goal Manager fold the evidence into the Goal. Everything here is
// deterministic; deliberate.mjs spawns the model-backed runners.
import { approvalRecord, validateGoal } from "./goal.mjs"

// What one pass has to do. `reports` and `decisions` are the question ids that
// already have artifacts on disk (a runner never repeats a question). Only
// required research runs: the Researcher works when knowledge is missing for
// a decision (CODE_GENERATION_FLOW §3), not for questions the Goal can seal
// without.
export function deliberationPlan(goal, { reports = [], decisions = [] } = {}) {
  const pending = goal.research_questions.filter((item) => item.status === "pending" && !reports.includes(item.id))
  const required = pending.filter((item) => item.required)
  const research = required.map((item) => item.id)
  const blocking = goal.open_questions.filter((item) => item.blocking)
  const opinions = blocking.filter((item) => Array.isArray(item.options) && item.options.length >= 2 && !decisions.includes(item.id)).map((item) => item.id)
  const userDecisions = blocking.filter((item) => !Array.isArray(item.options) || item.options.length < 2).map((item) => item.id)
  // Evidence already on disk for questions the Goal still shows as open must
  // be folded in even when nothing new runs.
  const unfolded =
    reports.some((id) => goal.research_questions.some((item) => item.id === id && item.status === "pending")) ||
    decisions.some((id) => goal.open_questions.some((item) => item.id === id && item.blocking))
  let status = "READY"
  if (userDecisions.length > 0) status = "USER_DECISION_REQUIRED"
  else if (research.length === 0 && opinions.length === 0 && !unfolded) status = "NOTHING_TO_DELIBERATE"
  return { status, research, opinions, user_decisions: userDecisions, revise: status === "READY" }
}

// Would sealing this Goal now be valid? Simulates the seal the way approval
// makes it: status plus an approval record for this exact content.
export function readyForApproval(goal) {
  return validateGoal({ ...goal, status: "SEALED", approval: approvalRecord(goal) }).valid
}

// Checks the Goal Manager's revision against the evidence it was given rather
// than trusting its summary.
export function verifyRevision(before, after, { reports = [], decisions = [] } = {}) {
  const errors = []
  const validation = validateGoal(after)
  if (!validation.valid) errors.push(...validation.errors)
  if (after?.goal_id !== before.goal_id) errors.push("goal_id changed during revision")
  if (after?.status === "SEALED") errors.push("revision returned SEALED without user approval")
  for (const report of reports) {
    const question = (after?.research_questions ?? []).find((item) => item.id === report.question_id)
    // A report answers its question when it is COMPLETE and at least one
    // finding was verified by retrieval (`answers`, computed by the runner).
    // A BLOCKED report, or a COMPLETE one nobody could verify, answers
    // nothing: the question may stay pending (the Goal then stays open) or
    // be waived, never completed. An answering report must be folded in.
    const answers = report.answers ?? report.status !== "BLOCKED"
    if (!question) errors.push(`research question ${report.question_id} disappeared`)
    else if (question.status === "pending" && answers) errors.push(`research question ${report.question_id} still pending although report ${report.report_id} answers it`)
    else if (question.status === "completed" && !answers) errors.push(`research question ${report.question_id} marked completed although report ${report.report_id} ${report.status === "BLOCKED" ? "is BLOCKED" : "has no verified finding"}`)
  }
  for (const decision of decisions) {
    const question = (after?.open_questions ?? []).find((item) => item.id === decision.question_id)
    if (question?.blocking) errors.push(`open question ${decision.question_id} still blocking although decision ${decision.decision_id} was proposed`)
    const recorded = (after?.decisions ?? []).some(
      (item) => (item.opinion_ids ?? []).some((id) => (decision.opinion_ids ?? []).includes(id)) || item.question === decision.question,
    )
    if (!recorded) errors.push(`decision ${decision.decision_id} is not recorded under decisions`)
  }
  return { ok: errors.length === 0, errors, ready_for_approval: errors.length === 0 && readyForApproval(after) }
}
