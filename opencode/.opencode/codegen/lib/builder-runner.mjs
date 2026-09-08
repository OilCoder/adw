import { selectModel } from "./model-selection.mjs"
import { summarizeEvents } from "./run-metrics.mjs"

const ZEN_RECHARGE_ACTION = "OpenCode Zen balance is exhausted. Recharge the Zen balance, then resume the run."
const GO_BALANCE_ACTION = "OpenCode Go reached its usage limit. Wait for the quota to reset, or check the balance in the OpenCode console if you keep Use balance enabled."

// The execution plan of a runner: the primary is the cheapest admitted
// configuration of the role not excluded by escalation, `rank` its place in
// the role's ordered list, `ladder` the whole list (ids in order). The
// metalog of the project, when given, excludes failed fits and demotes
// repeated failures.
export function selectExecutionPlan(registry, role, request, { metalog = null } = {}) {
  const selected = selectModel(registry, { ...request, role, metalog })
  const ladder = selected.ladder.map((item) => item.configuration_id)
  if (selected.status !== "SELECTED") {
    return {
      status: "NO_MATCH",
      work_class: request.workClass,
      role,
      ladder,
      rejected: selected.rejected,
    }
  }

  return {
    status: "READY",
    work_class: request.workClass,
    role,
    primary: { ...selected.selection, ladder },
    ladder,
    rejected: selected.rejected,
  }
}

export function selectBuilderExecutionPlan(registry, request, options = {}) {
  return selectExecutionPlan(registry, "builder", {
    ...request,
    requiresCodeEditing: true,
    requiresTools: true,
  }, options)
}
export function classifyExecution({
  exitCode,
  signal = null,
  eventsText = "",
  stderr = "",
  changedFiles = [],
}) {
  if (exitCode === 0) {
    return { classification: "SUCCESS", user_action: null }
  }
  if (changedFiles.length > 0) {
    return { classification: "PARTIAL_EXECUTION", user_action: null }
  }
  if (exitCode === 124 || signal) {
    return { classification: "LOCAL_RUNNER_ERROR", user_action: null }
  }

  const summary = summarizeEvents(eventsText)
  const error = summary.errors.at(-1)
  const statusCode = error?.status_code ?? null
  const name = error?.name ?? ""
  const message = error?.message ?? ""
  const searchable = `${name} ${message} ${stderr}`.toLowerCase()
  let classification = "UNCLASSIFIED_ERROR"
  let userAction = null

  if (statusCode === 401) classification = "AUTH_ERROR"
  else if (statusCode === 404) classification = "MODEL_CONFIG_ERROR"
  else if (
    /insufficient[_ -]?(?:credit|credits|balance)|credit balance|balance (?:is )?(?:empty|exhausted|depleted)|not (?:have|enough) (?:credits|balance)|out of credits|add credits|top[ -]?up|payment required/.test(
      searchable,
    )
  ) {
    classification = "ZEN_BALANCE_EXHAUSTED"
    userAction = ZEN_RECHARGE_ACTION
  }
  else if (statusCode === 429 || /rate limit|too many requests/.test(searchable)) {
    classification = "PROVIDER_RATE_LIMIT"
  } else if (/quota|usage limit/.test(searchable)) {
    classification = "GO_USAGE_LIMIT"
    userAction = GO_BALANCE_ACTION
  } else if (
    [500, 502, 503, 504, 529].includes(statusCode) ||
    /provider unavailable|service unavailable|overloaded|capacity temporarily unavailable/.test(
      searchable,
    )
  ) {
    classification = "PROVIDER_UNAVAILABLE"
  } else if (statusCode === 400 || /contextoverflow|structuredoutput/.test(searchable)) {
    classification = "MODEL_CONFIG_ERROR"
  }

  return {
    classification,
    user_action: userAction,
    status_code: statusCode,
    message: message || "Process failed without a classified provider error",
  }
}

export async function runExecutionPlan({ plan, execute }) {
  if (plan.status !== "READY") throw new Error("Execution plan is not ready")

  const result = await execute(plan.primary, 1)
  const classification = classifyExecution(result)
  return {
    status: classification.classification,
    user_action: classification.user_action,
    attempts: [attemptRecord(plan.primary, result, classification)],
  }
}

export async function runBuilderExecution(options) {
  return runExecutionPlan(options)
}

function attemptRecord(configuration, result, classification) {
  return {
    configuration,
    exit_code: result.exitCode,
    signal: result.signal ?? null,
    changed_files: result.changedFiles ?? [],
    metrics: summarizeEvents(result.eventsText ?? ""),
    // The tail of stderr travels with every attempt so an unclassified
    // failure can be diagnosed from the summary alone.
    stderr_tail: (result.stderr ?? "").trim().slice(-1500) || null,
    ...classification,
  }
}
