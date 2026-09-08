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
  }

  const routing = goal?.routing
  if (!routing || !SHAPES.has(routing.change_shape) || !RISKS.has(routing.risk)) {
    errors.push("routing shape or risk is invalid")
  }
  for (const field of ["existing_gate", "architecture_uncertainty", "external_research_required"]) {
    if (typeof routing?.[field] !== "boolean") errors.push(`routing.${field} must be boolean`)
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

export function renderGoalMarkdown(goal) {
  const validation = validateGoal(goal)
  if (!validation.valid) throw new Error(`Cannot render invalid goal: ${validation.errors.join("; ")}`)
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
`
}
