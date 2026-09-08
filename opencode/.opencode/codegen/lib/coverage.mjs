// Human-readable plan and the Goal coverage ledger. Both follow the thread of
// ids: Goal requirement or criterion → contract requirement → check → result.
import { contractChecks, contractRequirements, expectedBaseline, isPureRefactor } from "./contract.mjs"
import { planCoverage, validatePlan } from "./plan-validation.mjs"

function bullets(items, format = (item) => item) {
  return items.length > 0 ? items.map((item, index) => `- ${format(item, index)}`).join("\n") : "- None"
}

function claimText(claim) {
  return `\`${claim.contract_id}/${claim.requirement_id}\` [${claim.kind}, ${claim.verification}]`
}

const STATUS_LABEL = {
  covered: "covered",
  "manual-only": "MANUAL ONLY: no check proves it",
  uncovered: "UNCOVERED",
  "pending-human": "pending human verification",
}

function renderContract(contract) {
  const requirements = contractRequirements(contract)
  const checks = contractChecks(contract)
  const lines = [
    `### Contract \`${contract.contract_id}\``,
    "",
    contract.objective,
    "",
    `- Work class: \`${contract.work_class}\`; risk: \`${contract.risk}\``,
    `- May modify: ${(contract.allowed_to_modify ?? []).map((item) => `\`${item}\``).join(", ") || "nothing"}`,
    `- Forbidden: ${(contract.forbidden ?? []).map((item) => `\`${item}\``).join(", ") || "none"}`,
    "",
    "Requirements:",
    "",
    bullets(requirements, (item) =>
      `\`${item.id}\` [${item.kind}, ${item.verification}] ${item.statement}${item.covers.length > 0 ? ` → covers ${item.covers.map((id) => `\`${id}\``).join(", ")}` : " → covers nothing in the Goal"}`,
    ),
    "",
    "Checks:",
    "",
    bullets(checks, (check) =>
      `\`${check.id}\` (${expectedBaseline(check, contract) === "fail" ? "must fail on baseline" : "must pass on baseline"}) covers ${(check.covers ?? []).map((id) => `\`${id}\``).join(", ")}: \`${check.source_command ?? check.command}\``,
    ),
  ]
  if (isPureRefactor(contract)) {
    lines.push("", "**Pure refactor: every requirement preserves behavior, so no check proves a change happened.**")
  }
  const manual = requirements.filter((item) => item.verification === "manual")
  if (manual.length > 0) {
    lines.push("", `Pending human verification: ${manual.map((item) => `\`${item.id}\``).join(", ")}`)
  }
  return lines.join("\n")
}

// PLAN.md is rendered deterministically after validation, never by the
// Planner. With a Goal it carries the coverage section and the triage against
// the Goal's labels the user reviews before the Builders run.
export function renderPlanMarkdown(plan, goal = null, { route = null, riskFloors = null } = {}) {
  const validation = validatePlan(plan, { goal, route, riskFloors })
  if (!validation.valid) throw new Error(`Cannot render invalid plan: ${validation.errors.join("; ")}`)
  const coverage = validation.coverage
  const triage = validation.triage
  const sections = [
    `# Plan \`${plan.plan_id}\``,
    "",
    `**Base revision:** \`${plan.base_revision}\`${goal ? `<br>\n**Goal:** \`${goal.goal_id}\`` : ""}`,
    "",
    "## Objective",
    "",
    plan.objective,
    "",
    "## Execution waves",
    "",
    bullets(validation.execution_waves, (wave, index) => `Wave ${index + 1}: ${wave.map((id) => `\`${id}\``).join(", ")}`),
  ]
  if (triage) {
    sections.push(
      "",
      "## Triage",
      "",
      ...(triage.route_goal ? [`- Route: Goal \`${triage.route_goal}\` → effective \`${triage.route_effective}\``] : []),
      `- Risk: Goal \`${triage.risk_goal ?? "unknown"}\` → effective \`${triage.risk_effective}\``,
      "",
      "Risk per contract:",
      "",
      bullets(triage.contracts, (item) =>
        `\`${item.contract_id}\`: declared \`${item.risk_declared}\`, floor \`${item.risk_floor}\`, effective \`${item.risk_effective}\`${item.floor_reasons.length > 0 ? ` (${item.floor_reasons.map((hit) => `${hit.path}: ${hit.reason}`).join("; ")})` : ""}`,
      ),
      "",
      triage.contradictions.length > 0
        ? `**Triage contradictions (approving this plan accepts the effective values):**\n\n${bullets(triage.contradictions, (item) => `\`${item.label}\`: Goal said \`${item.claimed}\`, evidence: ${item.evidence} → effective \`${item.effective}\``)}`
        : "No triage contradictions: the plan fits the Goal's labels.",
    )
  }
  if (coverage) {
    sections.push(
      "",
      "## Goal coverage",
      "",
      "Requirements:",
      "",
      bullets(coverage.requirements, (item) =>
        `\`${item.id}\` [${item.priority}] ${item.statement} — **${STATUS_LABEL[item.status]}**${item.claims.length > 0 ? ` by ${item.claims.map(claimText).join(", ")}` : ""}`,
      ),
      "",
      "Acceptance criteria:",
      "",
      bullets(coverage.acceptance_criteria, (item) =>
        `\`${item.id}\` [${item.verification_type}] ${item.criterion} — **${STATUS_LABEL[item.status]}**${item.claims.length > 0 ? ` by ${item.claims.map(claimText).join(", ")}` : ""}`,
      ),
    )
    const pendingHuman = [
      ...coverage.acceptance_criteria.filter((item) => item.status === "pending-human").map((item) => `\`${item.id}\` [${item.verification_type}] ${item.criterion}`),
      ...coverage.manual_contract_requirements.map((item) => `\`${item.contract_id}/${item.requirement_id}\` ${item.statement}`),
    ]
    sections.push("", "Pending human verification:", "", bullets(pendingHuman))
    if (coverage.pure_refactor_contracts.length > 0) {
      sections.push("", `Pure refactor contracts (no check proves a change): ${coverage.pure_refactor_contracts.map((id) => `\`${id}\``).join(", ")}`)
    }
  }
  for (const phase of plan.phases) {
    sections.push(
      "",
      `## Phase \`${phase.phase_id}\``,
      "",
      `${phase.objective}${phase.depends_on.length > 0 ? ` (after ${phase.depends_on.map((id) => `\`${id}\``).join(", ")})` : ""}`,
      "",
      ...phase.contracts.map(renderContract),
    )
  }
  if (plan.final_verification?.commands?.length) {
    sections.push("", "## Final verification", "", bullets(plan.final_verification.commands, (command) => `\`${command}\``))
  }
  return `${sections.join("\n")}\n`
}

// The ledger after a run: what the plan claimed for each Goal id, and what
// actually happened to the contracts and checks behind each claim.
// `results` maps contract_id → { status, checks: { check_id → "PASS"|"FAIL" } }.
// A Goal id is VERIFIED only when every automated claim on it belongs to a
// PASSED contract whose covering checks all passed in the final gate.
// Manual and operational criteria, and manual contract requirements, are
// never claimed green: they stay pending human verification.
export function goalCoverage(plan, goal, results = new Map()) {
  const coverage = planCoverage(plan, goal)
  const contracts = new Map(
    (plan.phases ?? []).flatMap((phase) => (phase.contracts ?? []).map((contract) => [contract.contract_id, contract])),
  )
  function outcome(claim) {
    const contract = contracts.get(claim.contract_id)
    const result = results.get(claim.contract_id) ?? { status: "NOT_RUN", checks: {} }
    const checks = contractChecks(contract).filter((check) => (check.covers ?? []).includes(claim.requirement_id))
    const checkResults = checks.map((check) => ({ check_id: check.id, result: result.checks?.[check.id] ?? "NOT_RUN" }))
    let status
    if (claim.verification === "manual") status = "PENDING_HUMAN"
    else if (result.status !== "PASSED") status = result.status === "NOT_RUN" ? "NOT_RUN" : "FAILED"
    else if (checkResults.every((item) => item.result === "PASS")) status = "VERIFIED"
    else status = checkResults.some((item) => item.result === "FAIL") ? "FAILED" : "NOT_RUN"
    return { ...claim, contract_status: result.status, checks: checkResults, status }
  }
  function verdict(claims, { automatable }) {
    if (!automatable) return "PENDING_HUMAN"
    const automated = claims.filter((claim) => claim.verification === "automated")
    if (automated.length === 0) return claims.length > 0 ? "PENDING_HUMAN" : "UNCOVERED"
    if (automated.every((claim) => claim.status === "VERIFIED")) return "VERIFIED"
    if (automated.some((claim) => claim.status === "FAILED")) return "FAILED"
    return "NOT_VERIFIED"
  }
  const requirements = coverage.requirements.map((item) => {
    const claims = item.claims.map(outcome)
    return { id: item.id, priority: item.priority, statement: item.statement, claims, status: verdict(claims, { automatable: true }) }
  })
  const acceptanceCriteria = coverage.acceptance_criteria.map((item) => {
    const claims = item.claims.map(outcome)
    return {
      id: item.id,
      verification_type: item.verification_type,
      criterion: item.criterion,
      claims,
      status: verdict(claims, { automatable: item.verification_type === "automated" }),
    }
  })
  const pendingHuman = [
    ...acceptanceCriteria.filter((item) => item.status === "PENDING_HUMAN").map((item) => ({ id: item.id, text: item.criterion, source: "goal" })),
    ...coverage.manual_contract_requirements.map((item) => ({ id: `${item.contract_id}/${item.requirement_id}`, text: item.statement, source: "contract" })),
  ]
  const all = [...requirements, ...acceptanceCriteria]
  return {
    requirements,
    acceptance_criteria: acceptanceCriteria,
    pending_human: pendingHuman,
    summary: {
      verified: all.filter((item) => item.status === "VERIFIED").length,
      failed: all.filter((item) => item.status === "FAILED").length,
      not_verified: all.filter((item) => item.status === "NOT_VERIFIED" || item.status === "UNCOVERED").length,
      pending_human: pendingHuman.length,
    },
  }
}
