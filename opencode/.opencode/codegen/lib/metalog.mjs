// The metalog: one line per model call, per fit check, and per no-progress
// stop, appended by the runners and the orchestrator of this project. The
// selector reads it: a configuration whose fit check failed is never chosen
// again, and one with repeated failures attributable to the model sinks to
// the bottom of its role's list until it succeeds again.
import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"

// Results that say nothing about the model: the account, the provider, the
// local harness, or the contract failed. Logged, never counted.
export const NEUTRAL_RESULTS = new Set([
  "AUTH_ERROR",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_UNAVAILABLE",
  "ZEN_BALANCE_EXHAUSTED",
  "GO_USAGE_LIMIT",
  "LOCAL_RUNNER_ERROR",
  "PARTIAL_EXECUTION",
  "UNCLASSIFIED_ERROR",
  "CONTRACT_BLOCKED",
  "NO_BUILDER_ADMITTED",
  "USER_ACTION_REQUIRED",
  "BLOCKED",
])

export const METALOG_RELATIVE = ".opencode/codegen/metalog.jsonl"

export function metalogPath(systemRoot) {
  return process.env.CODEGEN_METALOG ?? path.join(systemRoot, METALOG_RELATIVE)
}

// success: the role's own verdict on the artifact (a valid plan, a passed
// gate, a report that answers). A neutral result is neither.
export function outcomeOf(result, { success }) {
  if (NEUTRAL_RESULTS.has(result)) return "neutral"
  return success ? "success" : "failure"
}

export async function appendMetalog(systemRoot, entry) {
  const file = metalogPath(systemRoot)
  await mkdir(path.dirname(file), { recursive: true })
  const record = { at: new Date().toISOString(), ...entry }
  await appendFile(file, `${JSON.stringify(record)}\n`)
  return record
}

export async function readMetalog(systemRoot) {
  try {
    const text = await readFile(metalogPath(systemRoot), "utf8")
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
}

// What the selector reads: the fit verdict of each configuration and, per
// role, how many attributable failures in a row since its last success.
export function summarizeMetalog(entries) {
  const configurations = {}
  const view = (id) => (configurations[id] ??= { fit: null, fit_reason: null, roles: {} })
  for (const entry of entries) {
    if (!entry?.configuration_id) continue
    const item = view(entry.configuration_id)
    if (entry.kind === "fit") {
      if (entry.outcome === "pass" || entry.outcome === "fail") {
        item.fit = entry.outcome
        item.fit_reason = entry.reason ?? null
      }
      continue
    }
    if (!entry.role) continue
    const role = (item.roles[entry.role] ??= { consecutive_failures: 0, calls: 0, failures: 0, last_outcome: null, last_at: null })
    if (entry.kind === "call") role.calls += 1
    if (entry.outcome === "failure") {
      role.failures += 1
      role.consecutive_failures += 1
    } else if (entry.outcome === "success") {
      role.consecutive_failures = 0
    }
    role.last_outcome = entry.outcome ?? null
    role.last_at = entry.at ?? null
  }
  return { configurations }
}

export async function loadMetalogSummary(systemRoot) {
  return summarizeMetalog(await readMetalog(systemRoot))
}

function tokensOf(metrics) {
  if (!metrics) return null
  return { input: metrics.input_tokens ?? 0, output: metrics.output_tokens ?? 0, cache_read: metrics.cache_read_tokens ?? 0 }
}

// One model call by a runner. `selection` is the primary of the execution
// plan (configuration, rank, ladder); `result` the runner's own verdict.
export function callEntry({ role, selection, result, success, runId, execution = null, reason = null, context = {} }) {
  const metrics = execution?.attempts?.at(-1)?.metrics ?? execution?.metrics ?? null
  return {
    kind: "call",
    role,
    configuration_id: selection.configuration_id,
    model: selection.model,
    provider: selection.provider,
    rank: selection.rank ?? null,
    ladder: selection.ladder ?? [],
    result,
    outcome: outcomeOf(result, { success }),
    reason,
    run_id: runId,
    tokens: tokensOf(metrics),
    cost: metrics?.reported_cost ?? null,
    ...context,
  }
}

// A no-progress stop decided by the orchestrator: the model reproduced an
// earlier attempt. Always attributable to the model.
export function stopEntry({ role, selection, reason, runId, context = {} }) {
  return {
    kind: "stop",
    role,
    configuration_id: selection.configuration_id,
    model: selection.model ?? null,
    provider: selection.provider ?? null,
    rank: selection.rank ?? null,
    ladder: selection.ladder ?? [],
    result: "NO_PROGRESS",
    outcome: "failure",
    reason,
    run_id: runId,
    ...context,
  }
}
