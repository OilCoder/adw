const STATUSES = new Set(["DRAFT", "RESEARCHING", "DECIDED", "SEALED"])
const SHAPES = new Set(["localized", "multi-component", "system"])
const RISKS = new Set(["low", "medium", "high"])

function text(value) {
  return typeof value === "string" && value.trim().length > 0
}

function list(value, label, errors, { required = false } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`)
    return []
  }
  if (required && value.length === 0) errors.push(`${label} cannot be empty`)
  return value
}

function uniqueIds(items, label, errors, globalIds) {
  for (const item of items) {
    if (!text(item?.id)) {
      errors.push(`${label} item must define id`)
      continue
    }
    if (globalIds.has(item.id)) errors.push(`duplicate artifact id: ${item.id}`)
    globalIds.add(item.id)
  }
}

export function validateGoal(goal) {
  const errors = []
  if (goal?.schema_version !== 1) errors.push("schema_version must be 1")
  for (const field of ["goal_id", "title", "summary", "objective"]) {
    if (!text(goal?.[field])) errors.push(`${field} must be a non-empty string`)
  }
  if (!STATUSES.has(goal?.status)) errors.push("status is invalid")

  const inScope = list(goal?.in_scope, "in_scope", errors, { required: true })
  list(goal?.out_of_scope, "out_of_scope", errors)
  const requirements = list(goal?.requirements, "requirements", errors, { required: true })
  const constraints = list(goal?.constraints, "constraints", errors)
  const metrics = list(goal?.success_metrics, "success_metrics", errors, { required: true })
  const acceptance = list(goal?.acceptance_criteria, "acceptance_criteria", errors, {
    required: true,
  })
  const decisions = list(goal?.decisions, "decisions", errors)
  const research = list(goal?.research_questions, "research_questions", errors)
  const questions = list(goal?.open_questions, "open_questions", errors)
  const globalIds = new Set()
  for (const [label, items] of Object.entries({
    requirements,
    constraints,
    success_metrics: metrics,
    acceptance_criteria: acceptance,
    decisions,
    research_questions: research,
    open_questions: questions,
  })) {
    uniqueIds(items, label, errors, globalIds)
  }

  for (const requirement of requirements) {
    if (!text(requirement.statement)) errors.push(`${requirement.id}: statement is required`)
    if (!new Set(["must", "should", "could"]).has(requirement.priority)) {
      errors.push(`${requirement.id}: priority is invalid`)
    }
  }
  for (const metric of metrics) {
    for (const field of ["metric", "target", "measurement"]) {
      if (!text(metric[field])) errors.push(`${metric.id}: ${field} is required`)
    }
  }
  for (const criterion of acceptance) {
    if (!text(criterion.criterion)) errors.push(`${criterion.id}: criterion is required`)
    if (!new Set(["automated", "manual", "operational"]).has(criterion.verification_type)) {
      errors.push(`${criterion.id}: verification_type is invalid`)
    }
  }
  for (const constraint of constraints) {
    if (!text(constraint.statement)) errors.push(`${constraint.id}: statement is required`)
  }
  for (const decision of decisions) {
    for (const field of ["question", "decision", "rationale"]) {
      if (!text(decision[field])) errors.push(`${decision.id}: ${field} is required`)
    }
    if (
      !Array.isArray(decision.research_report_ids) ||
      decision.research_report_ids.some((id) => !text(id))
    ) {
      errors.push(`${decision.id}: research_report_ids must be an array of report ids`)
    }
    if (
      decision.opinion_ids !== undefined &&
      (!Array.isArray(decision.opinion_ids) || decision.opinion_ids.some((id) => !text(id)))
    ) {
      errors.push(`${decision.id}: opinion_ids must be an array of opinion ids`)
    }
  }
  for (const question of questions) {
    if (!text(question.question)) errors.push(`${question.id}: question is required`)
    if (typeof question.blocking !== "boolean") errors.push(`${question.id}: blocking must be boolean`)
    if (question.options !== undefined) {
      const options = Array.isArray(question.options) ? question.options : []
      if (
        !Array.isArray(question.options) ||
        options.length < 2 ||
        options.some((option) => !text(option)) ||
        new Set(options).size !== options.length
      ) {
        errors.push(`${question.id}: options must list at least two distinct choices`)
      }
    }
  }
  for (const item of research) {
    if (!text(item.question) || !text(item.why_needed)) {
      errors.push(`${item.id}: research question and reason are required`)
    }
    if (!new Set(["pending", "completed", "waived"]).has(item.status)) {
      errors.push(`${item.id}: research status is invalid`)
    }
    if (!Array.isArray(item.allowed_source_types) || item.allowed_source_types.length === 0) {
      errors.push(`${item.id}: allowed_source_types cannot be empty`)
    }
    if (!Number.isInteger(item.budget?.max_sources) || item.budget.max_sources < 1) {
      errors.push(`${item.id}: max_sources must be at least 1`)
    }
    if (!Number.isInteger(item.budget?.max_minutes) || item.budget.max_minutes < 1) {
      errors.push(`${item.id}: max_minutes must be at least 1`)
    }
  }

  const routing = goal?.routing
  if (!routing || !SHAPES.has(routing.change_shape) || !RISKS.has(routing.risk)) {
    errors.push("routing shape or risk is invalid")
  }
  for (const field of ["existing_gate", "architecture_uncertainty", "external_research_required"]) {
    if (typeof routing?.[field] !== "boolean") errors.push(`routing.${field} must be boolean`)
  }
  const budgets = goal?.budgets
  for (const field of [
    "max_research_questions",
    "max_research_calls",
    "max_planner_calls",
    "max_derived_tasks",
  ]) {
    if (!Number.isInteger(budgets?.[field]) || budgets[field] < 0) {
      errors.push(`budgets.${field} must be a non-negative integer`)
    }
  }
  if (research.length > (budgets?.max_research_questions ?? -1)) {
    errors.push("research question count exceeds its budget")
  }
  // Every route that builds needs the Planner at least once (the direct route
  // is the Planner capped at one contract), so a zero budget can never be built.
  if (Number.isInteger(budgets?.max_planner_calls) && budgets.max_planner_calls < 1) {
    errors.push("budgets.max_planner_calls must be at least 1: the Planner writes every contract, including the single contract of the direct route")
  }

  if (goal?.status === "SEALED") {
    if (questions.some((question) => question.blocking)) {
      errors.push("SEALED goal cannot contain blocking open questions")
    }
    if (research.some((item) => item.required && item.status === "pending")) {
      errors.push("SEALED goal cannot contain required pending research")
    }
    if (
      (routing?.architecture_uncertainty || routing?.external_research_required) &&
      decisions.length === 0
    ) {
      errors.push("SEALED goal with deliberative signals must record at least one decision")
    }
  }
  if (inScope.some((item) => !text(item))) errors.push("in_scope contains empty text")

  return { valid: errors.length === 0, errors }
}

// The Goal Manager proposes budgets; the system owns their ceilings and
// floors. Values above a ceiling are cut to it, and max_research_calls is
// raised to the number of required pending questions so a deliberation can
// never end without researching what the Goal says it needs. Every change
// is returned so the runner can report it before the user approves.
export function applyGoalLimits(goal, limits) {
  const adjusted = structuredClone(goal)
  const adjustments = []
  const budgets = adjusted?.budgets
  if (!budgets || typeof budgets !== "object" || !limits?.goal) return { goal: adjusted, adjustments }
  const requiredPending = (Array.isArray(adjusted.research_questions) ? adjusted.research_questions : []).filter(
    (item) => item?.required && item?.status === "pending",
  ).length
  const questionCount = Array.isArray(adjusted.research_questions) ? adjusted.research_questions.length : 0
  const floors = { max_research_calls: requiredPending, max_research_questions: questionCount, max_planner_calls: 1 }
  for (const [field, ceiling] of Object.entries(limits.goal)) {
    const current = budgets[field]
    if (!Number.isInteger(current)) continue
    const floor = floors[field] ?? 0
    let next = current
    let reason = null
    if (Number.isInteger(ceiling) && next > ceiling) {
      next = ceiling
      reason = `above the system ceiling ${ceiling}`
    }
    if (next < floor && floor <= (Number.isInteger(ceiling) ? ceiling : floor)) {
      next = floor
      reason = field === "max_research_calls"
        ? `below the ${floor} required pending research question${floor === 1 ? "" : "s"}`
        : field === "max_research_questions"
          ? `below the ${floor} research question${floor === 1 ? "" : "s"} the Goal lists`
          : "below the minimum of 1"
    }
    if (next !== current) {
      budgets[field] = next
      adjustments.push({ field: `budgets.${field}`, from: current, to: next, reason })
    }
  }
  return { goal: adjusted, adjustments }
}

export function sealApprovedGoal(goal) {
  const current = validateGoal(goal)
  if (!current.valid) throw new Error(`Cannot approve invalid Goal: ${current.errors.join("; ")}`)
  const sealed = structuredClone(goal)
  sealed.status = "SEALED"
  const validation = validateGoal(sealed)
  if (!validation.valid) throw new Error(`Goal is not ready for approval: ${validation.errors.join("; ")}`)
  return sealed
}

function bullets(items, format) {
  return items.length > 0 ? items.map((item) => `- ${format(item)}`).join("\n") : "- None"
}

export function renderGoalMarkdown(goal, { adjustments = [] } = {}) {
  const validation = validateGoal(goal)
  if (!validation.valid) throw new Error(`Cannot render invalid goal: ${validation.errors.join("; ")}`)
  const adjustmentSection =
    adjustments.length > 0
      ? `
## Budget adjustments

The system clamped these budgets before rendering:

${bullets(adjustments, (item) => `\`${item.field}\`: ${item.from} → ${item.to} (${item.reason})`)}
`
      : ""
  return `# ${goal.title}

**Goal ID:** \`${goal.goal_id}\`<br>
**Status:** \`${goal.status}\`

## Summary

${goal.summary}

## Objective

${goal.objective}

## In Scope

${bullets(goal.in_scope, (item) => item)}

## Out of Scope

${bullets(goal.out_of_scope, (item) => item)}

## Requirements

${bullets(goal.requirements, (item) => `**${item.priority.toUpperCase()}** \`${item.id}\`: ${item.statement}`)}

## Constraints

${bullets(goal.constraints, (item) => `\`${item.id}\`: ${item.statement}`)}

## Success Metrics

${bullets(goal.success_metrics, (item) => `\`${item.id}\` ${item.metric}; target: ${item.target}; measurement: ${item.measurement}`)}

## Acceptance Criteria

${bullets(goal.acceptance_criteria, (item) => `\`${item.id}\` [${item.verification_type}]: ${item.criterion}`)}

## Decisions

${bullets(goal.decisions, (item) => `\`${item.id}\` ${item.decision} - ${item.rationale}`)}

## Research Questions

${bullets(goal.research_questions, (item) => `\`${item.id}\` [${item.status}]: ${item.question}`)}

## Open Questions

${bullets(goal.open_questions, (item) => `\`${item.id}\`${item.blocking ? " [blocking]" : ""}: ${item.question}`)}

## Routing Signals

- Change shape: \`${goal.routing.change_shape}\`
- Risk: \`${goal.routing.risk}\`
- Existing Gate: \`${goal.routing.existing_gate}\`
- Architecture uncertainty: \`${goal.routing.architecture_uncertainty}\`
- External research required: \`${goal.routing.external_research_required}\`

## Budgets

- Research questions: ${goal.budgets.max_research_questions}
- Research calls: ${goal.budgets.max_research_calls}
- Planner calls: ${goal.budgets.max_planner_calls}
- Derived tasks: ${goal.budgets.max_derived_tasks}
${adjustmentSection}`
}
