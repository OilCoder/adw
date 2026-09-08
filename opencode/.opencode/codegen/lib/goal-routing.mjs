import { validateGoal } from "./goal.mjs"

// Router: decides how much process one SEALED Goal needs, direct or planned.
// It never writes code or contracts. Deliberation is not a route of the
// Router: it happens before the seal (deliberate.mjs), and a Goal that is
// not sealed is reported as such, with what still keeps it open, so the
// caller sends the user to deliberate or to approve. A SEALED Goal has
// already been deliberated (the validator requires recorded decisions when
// deliberative signals are set).
export function routeGoal(goal) {
  const validation = validateGoal(goal)
  if (!validation.valid) {
    return { status: "INVALID_GOAL", route: null, reasons: validation.errors }
  }

  const pendingResearch = goal.research_questions.filter(
    (item) => item.required && item.status === "pending",
  )
  const blockingQuestions = goal.open_questions.filter((item) => item.blocking)
  const deliberativeSignals = []
  if (goal.routing.external_research_required) deliberativeSignals.push("external-research-required")
  if (goal.routing.architecture_uncertainty) deliberativeSignals.push("architecture-uncertainty")
  if (pendingResearch.length > 0) deliberativeSignals.push("required-research-pending")
  if (blockingQuestions.length > 0) deliberativeSignals.push("blocking-questions-open")

  if (goal.status !== "SEALED") {
    return {
      status: "GOAL_NOT_SEALED",
      route: null,
      reasons: deliberativeSignals.length === 0 ? ["goal-requires-user-approval"] : deliberativeSignals,
      needs_deliberation: deliberativeSignals.length > 0,
      pending: {
        research_questions: pendingResearch.map((item) => item.id),
        blocking_questions: blockingQuestions.map((item) => item.id),
      },
    }
  }

  const direct =
    deliberativeSignals.length === 0 &&
    goal.routing.change_shape === "localized" &&
    goal.routing.risk === "low" &&
    goal.routing.existing_gate
  if (direct) {
    return {
      status: "ROUTED",
      route: "direct",
      reasons: ["localized", "low-risk", "existing-gate"],
      allowed_events: [
        "CONTRACT_DRAFTED",
        "CONTRACT_VALIDATED",
        "BUILDER_DISPATCHED",
        "VERIFICATION_STARTED",
      ],
    }
  }

  return {
    status: "ROUTED",
    route: "planned",
    reasons: [
      `shape:${goal.routing.change_shape}`,
      `risk:${goal.routing.risk}`,
      ...(goal.routing.existing_gate ? [] : ["gate-preparation-may-be-required"]),
      ...(deliberativeSignals.length > 0 ? ["deliberation-recorded"] : []),
    ],
    allowed_events: [
      "PLAN_REQUESTED",
      "PLAN_GENERATED",
      "PLAN_VALIDATED",
      "DAG_READY",
      "WAVE_READY",
    ],
  }
}
