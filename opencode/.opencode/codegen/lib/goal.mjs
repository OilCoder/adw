import { createHash } from "node:crypto"

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

// The digest of what the user read: the Goal's content, without its status
// and without the approval record itself. A draft and the sealed Goal made
// from it share a digest; a Goal edited after it was summarized does not.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

export function goalDigest(goal) {
  const { status, approval, ...content } = goal ?? {}
  return createHash("sha256").update(JSON.stringify(canonical(content))).digest("hex")
}

const DIGEST = /^[0-9a-f]{64}$/

// The approval record is the only evidence that a human sealed the Goal: who
// (always the user), when, through which path, and the digest they approved.
export function approvalRecord(goal, { via = "run-goal --approve", now = new Date() } = {}) {
  return { approved_by: "user", approved_at: now.toISOString(), goal_digest: goalDigest(goal), via }
}

function validateApproval(goal, errors) {
  const approval = goal?.approval
  if (goal?.status !== "SEALED") {
    if (approval !== undefined) errors.push("approval is only recorded on a SEALED goal")
    return
  }
  if (!approval || typeof approval !== "object") {
    errors.push("SEALED goal must carry an approval record (approved_by, approved_at, goal_digest, via)")
    return
  }
  if (approval.approved_by !== "user") errors.push("approval.approved_by must be user: only the user seals a Goal")
  if (!text(approval.approved_at) || Number.isNaN(Date.parse(approval.approved_at))) errors.push("approval.approved_at must be an ISO date")
  if (!text(approval.via)) errors.push("approval.via must name the path the approval came through")
  if (!DIGEST.test(approval.goal_digest ?? "")) errors.push("approval.goal_digest must be a sha256 hex digest")
  else if (approval.goal_digest !== goalDigest(goal)) errors.push("approval.goal_digest does not match the Goal content: the Goal changed after it was approved")
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
  validateApproval(goal, errors)

  return { valid: errors.length === 0, errors }
}

// Seals the Goal the user approved. `digest` is what the user was shown
// (the goal_digest of the last draft, revise, or deliberate summary): a Goal
// whose content on disk no longer matches is refused, so nobody approves a
// file they did not read. The approval record travels with the sealed Goal.
export function sealApprovedGoal(goal, { digest = null, via = "run-goal --approve", now = new Date() } = {}) {
  const current = validateGoal(goal)
  if (!current.valid) throw new Error(`Cannot approve invalid Goal: ${current.errors.join("; ")}`)
  if (goal.status === "SEALED") throw new Error(`Goal is already SEALED (approved at ${goal.approval?.approved_at ?? "unknown"})`)
  const actual = goalDigest(goal)
  if (digest !== null && digest !== actual) {
    throw new Error(`Goal changed since it was summarized: approved digest ${digest}, on disk ${actual}. Read the Goal again and approve what is there.`)
  }
  const sealed = structuredClone(goal)
  sealed.status = "SEALED"
  sealed.approval = approvalRecord(goal, { via, now })
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
**Status:** \`${goal.status}\`${goal.approval ? `<br>\n**Approved:** by ${goal.approval.approved_by} at ${goal.approval.approved_at} via \`${goal.approval.via}\`; digest \`${goal.approval.goal_digest}\`` : ""}

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
