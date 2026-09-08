import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { goalCoverage } from "./coverage.mjs"
import { routeDerivedWork } from "./derived-work.mjs"
import { runContractGate, runFinalGate } from "./final-gate.mjs"
import { checkGateReadiness, checkScriptPath, materializeGate } from "./gate.mjs"
import { routeGoal } from "./goal-routing.mjs"
import { validateGoal } from "./goal.mjs"
import { stopEntry } from "./metalog.mjs"
import { validatePlan, validateRequirementsAndChecks } from "./plan-validation.mjs"
import { runProcess } from "./process.mjs"
import {
  composeRepairContract,
  diagnoseFinalGate,
  finalGateSignature,
  interpretReplay,
  repairFinding,
  repairKey,
  repairProgress,
} from "./repair.mjs"
import {
  checkoutDetached,
  cherryPick,
  commitPatch,
  commitPaths,
  createWorktree,
  ensureExcluded,
  linkOpenCodeLayer,
  removeWorktree,
  resetWorktree,
  restorePaths,
  revision,
} from "./worktrees.mjs"

export const RUN_ROOT = ".codegen-run"

// Terminal dispositions after a Builder attempt, from CODE_GENERATION_FLOW §4.
const PROVIDER_STOPS = new Set(["PROVIDER_RATE_LIMIT", "PROVIDER_UNAVAILABLE"])
const USER_ACTION_STOPS = new Set(["ZEN_BALANCE_EXHAUSTED", "GO_USAGE_LIMIT"])
const BLOCKING_STOPS = new Set([
  "NO_BUILDER_ADMITTED",
  "AUTH_ERROR",
  "MODEL_CONFIG_ERROR",
  "LOCAL_RUNNER_ERROR",
  "UNCLASSIFIED_ERROR",
  "PARTIAL_EXECUTION",
])
// A repair or rebuild that fails for one of these is a technical stop, not a
// reason to replan.
const TERMINAL_RECORD_STATUSES = new Set(["USER_ACTION_REQUIRED", "ESCALATE", "BLOCKED"])

// What the next attempt would be told: the result and the checks or paths
// behind it. An attempt that reproduces the signature of an earlier one would
// be retried with exactly the same evidence, which CODE_GENERATION_FLOW §4
// forbids, so the loop stops there. There is no attempt cap: the loop runs
// while each attempt brings new evidence.
export function attemptSignature(result, summary = {}) {
  const failing = (summary.verification ?? []).filter((check) => check.exit_code !== 0).map((check) => check.check_id).sort()
  const outside = [...(summary.outside_scope ?? [])].sort()
  return JSON.stringify({ result, failing, outside })
}

// `repeats` is the number of the earlier attempt this one reproduced, or null.
export function classifyBuilderOutcome(result, { attempt, repeats = null }) {
  if (result === "PASS") return { disposition: "ACCEPT" }
  const retriable = result === "GATE_FAIL" || result === "SCOPE_FAIL" || result === "NO_CHANGES"
  if (retriable) {
    if (repeats === null) return { disposition: "RETRY", reason: result }
    return { disposition: "STOP", status: "BUILD_FAILED", reason: `no progress: attempt ${attempt} reproduced attempt ${repeats} (${result})` }
  }
  if (result === "CONTRACT_BLOCKED") return { disposition: "STOP", status: "REPLAN_REQUIRED", reason: result }
  if (USER_ACTION_STOPS.has(result)) return { disposition: "STOP", status: "USER_ACTION_REQUIRED", reason: result }
  if (PROVIDER_STOPS.has(result)) return { disposition: "STOP", status: "ESCALATE", reason: result }
  if (BLOCKING_STOPS.has(result)) return { disposition: "STOP", status: "BLOCKED", reason: result }
  return { disposition: "STOP", status: "BLOCKED", reason: `unknown builder result ${result}` }
}

function pathspec(pattern) {
  return pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern
}

function pathMatches(pattern, candidate) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3)
    return candidate === prefix || candidate.startsWith(`${prefix}/`)
  }
  return pattern === candidate
}

async function pool(items, concurrency, worker) {
  const results = new Array(items.length)
  let next = 0
  async function lane() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane))
  return results
}

function outcomeStatusOf(records) {
  const statuses = new Set(records.map((record) => record.status))
  return ["USER_ACTION_REQUIRED", "REPLAN_REQUIRED", "ESCALATE", "BLOCKED", "BUILD_FAILED"].find((candidate) => statuses.has(candidate)) ?? "BUILD_FAILED"
}

// The whole plan the final Gate judges: the reviewed plan plus every repair
// plan the Planner added on top of it.
function mergedPlanView(plans) {
  return {
    phases: plans.flatMap((plan) => plan.phases),
    final_verification: { commands: [...new Set(plans.flatMap((plan) => plan.final_verification?.commands ?? []))] },
  }
}

export async function orchestrate(options) {
  const run = await createRun(options)
  return options.resumeRunId ? run.resume() : run.start()
}

async function createRun({
  directory,
  goalPath = ".codegen-goal/goal.json",
  planPath = null,
  resumeRunId = null,
  registry,
  riskFloors = null,
  runners,
  runId,
  concurrency = 2,
  keepWorktrees = false,
  metalog = null,
  gateTimeoutSeconds = 300,
  log = () => {},
}) {
  const effectiveRunId = resumeRunId ?? runId
  const runDirectory = path.join(directory, RUN_ROOT, effectiveRunId)
  await mkdir(runDirectory, { recursive: true })
  await ensureExcluded(directory, `${RUN_ROOT}/`)
  const eventsFile = path.join(runDirectory, "events.jsonl")
  const stateFile = path.join(runDirectory, "state.json")
  const workClasses = new Set(Object.keys(registry.routes))

  let state = {
    run_id: effectiveRunId,
    status: "STARTED",
    stop_reason: null,
    goal_id: null,
    goal_path: goalPath,
    route: null,
    triage: null,
    plan_id: null,
    plan_path: null,
    plan_markdown: null,
    plan_reviewed: false,
    base_revision: null,
    integration_branch: `codegen/${effectiveRunId}`,
    integration_worktree: path.join(runDirectory, "integration"),
    integration_head: null,
    // Integration order: what each integrated commit was built on and the
    // head it produced. The diagnosis replays gates along it.
    integration_sequence: [],
    waves: [],
    // Repairs after integration: rebuilds after a conflict, composed repair
    // contracts after a failed final Gate, repair plans from the Planner.
    repairs: [],
    repair_plans: [],
    replan_rounds: [],
    pending_plan: null,
    final_gate_rounds: [],
    final_gate: null,
    goal_coverage: null,
    derived_work: [],
    escalations: [],
    planner_calls: 0,
    gate_designer_calls: 0,
    user_action: null,
    resumed: 0,
  }
  // Loaded lazily: the Goal, the plans (reviewed plus repairs), and the
  // unsealed contracts by id.
  let goal = null
  let plans = []
  const contracts = new Map()
  const gateSources = []
  const worktreesToRemove = []
  const rebuilds = new Map()

  async function emit(event, data = {}) {
    const record = { at: new Date().toISOString(), event, ...data }
    await appendFile(eventsFile, `${JSON.stringify(record)}\n`)
    log(record)
  }
  async function persist() {
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`)
  }
  async function stop(status, reason, extra = {}) {
    state.status = status
    state.stop_reason = reason
    if (extra.user_action) state.user_action = extra.user_action
    await emit("RUN_STOPPED", { status, reason, ...extra })
    await persist()
    return state
  }
  function registerPlan(plan, kind) {
    plans.push(plan)
    for (const phase of plan.phases) {
      for (const contract of phase.contracts) contracts.set(contract.contract_id, { contract, phaseId: phase.phase_id, kind })
    }
  }
  function footprint() {
    return [...new Set(plans.flatMap((plan) => plan.phases.flatMap((phase) => phase.contracts.flatMap((contract) => contract.allowed_to_modify))))]
  }
  function allRecords() {
    return state.waves.flatMap((wave) => wave.contracts)
  }
  function projectRelative(absolute) {
    return path.relative(directory, absolute)
  }

  // ---------------------------------------------------------------- Planner

  // A plan the validator rejects is re-requested with the errors as evidence
  // while the errors change. A plan that reproduces the errors of an earlier
  // attempt would be re-requested with the same evidence: no progress for
  // that configuration, so the orchestrator climbs one rung of the Planner's
  // list (the next configuration gets the evidence) and stops only when the
  // list is exhausted. Any other failure stops at once. Returns
  // { plan, output } or { stopped: state }.
  async function requestPlan({ cwd, route, outputPrefix, repairEvidence = null }) {
    const excluded = []
    let errorSets = []
    let evidence = repairEvidence
    let output = null
    let attempt = 0
    while (true) {
      state.planner_calls += 1
      attempt += 1
      output = `${outputPrefix}${attempt > 1 ? `-${attempt}` : ""}.json`
      await emit("PLAN_REQUESTED", { output: projectRelative(path.resolve(cwd, output)), route, attempt: state.planner_calls, evidence, excluded: [...excluded], repair: repairEvidence !== null })
      const summary = await runners.planner({
        directory: cwd,
        objective: goal.objective,
        goal: goalPath,
        output,
        route,
        evidence,
        excludeConfigurations: [...excluded],
        repair: repairEvidence !== null,
      })
      const selection = summary.selection ?? null
      await emit("PLAN_GENERATED", { result: summary.result ?? summary.status, output: projectRelative(path.resolve(cwd, output)), attempt: state.planner_calls, markdown: summary.markdown ? projectRelative(path.resolve(cwd, summary.markdown)) : null, configuration_id: selection?.configuration_id ?? null, rank: selection?.rank ?? null })
      if (summary.result === "PASS") {
        const plan = JSON.parse(await readFile(path.resolve(cwd, output), "utf8"))
        return { plan, output: projectRelative(path.resolve(cwd, output)), markdown: summary.markdown ? projectRelative(path.resolve(cwd, summary.markdown)) : null }
      }
      if (summary.status === "NO_MATCH") {
        return { stopped: await stop("PLAN_FAILED", `no planner admitted${excluded.length > 0 ? ` after escalating past ${excluded.join(", ")}` : ""}`, { rejected: summary.rejected ?? null, attempts: state.planner_calls }) }
      }
      if (summary.result !== "PLAN_INVALID") return { stopped: await stop("PLAN_FAILED", summary.result, { validation: summary.validation ?? null, attempts: state.planner_calls }) }
      const errors = [...(summary.validation?.errors ?? [])].sort()
      const repeats = errorSets.findIndex((item) => item.length === errors.length && item.every((error, index) => error === errors[index]))
      errorSets.push(errors)
      evidence = `${outputPrefix}-${attempt}.evidence.json`
      const repairPart = repairEvidence ? JSON.parse(await readFile(path.resolve(cwd, repairEvidence), "utf8")) : {}
      await mkdir(path.dirname(path.resolve(cwd, evidence)), { recursive: true })
      await writeFile(
        path.resolve(cwd, evidence),
        `${JSON.stringify({ ...repairPart, attempt: state.planner_calls, rejected_plan: output, errors: summary.validation?.errors ?? [], ...(repeats !== -1 ? { escalated_from: selection?.configuration_id ?? null } : {}) }, null, 2)}\n`,
      )
      if (repeats === -1) {
        await emit("PLAN_RETRY", { attempt: state.planner_calls, evidence, errors: summary.validation?.errors ?? [] })
        continue
      }
      const reason = `no progress: attempt ${state.planner_calls} reproduced the validation errors of attempt ${state.planner_calls - attempt + repeats + 1}`
      if (selection?.configuration_id) {
        await metalog?.append?.(stopEntry({ role: "planner", selection, reason, runId: effectiveRunId, context: { attempt: state.planner_calls } }))
      }
      const next = selection ? ((selection.ladder ?? []).find((id) => id !== selection.configuration_id && !excluded.includes(id)) ?? null) : null
      if (!next) {
        return { stopped: await stop("PLAN_FAILED", `${reason}; no other planner admitted`, { validation: summary.validation ?? null, attempts: state.planner_calls }) }
      }
      excluded.push(selection.configuration_id)
      errorSets = []
      const escalation = { role: "planner", from: selection.configuration_id, to: next, reason, evidence }
      state.escalations.push(escalation)
      await emit("ESCALATED", escalation)
    }
  }

  // --------------------------------------------------------- Contract prep

  // One worktree per contract from the head it builds on; the contract and
  // its Gate are sealed and committed there. `originScripts` copies the real
  // check bodies of earlier contracts (the Gate Designer may have rewritten
  // them) over the materialized ones, so a rebuild or a repair judges with
  // the same checks that judged the originals.
  async function prepareContract({ contract, phaseId, kind, riskEffective, baseHead, worktreeName, evidence = null, originScripts = null, designer = false, parentContractId = null }) {
    const worktree = path.join(runDirectory, "worktrees", worktreeName)
    await createWorktree({ repository: directory, directory: worktree, revision: baseHead })
    worktreesToRemove.push(worktree)
    await linkOpenCodeLayer(directory, worktree)
    await emit("WORKTREE_CREATED", { contract_id: contract.contract_id, kind, worktree, base: baseHead })

    const contractDirectory = path.join(worktree, ".codegen-contract")
    await mkdir(contractDirectory, { recursive: true })
    const sealed = await materializeGate(worktree, contract)
    if (originScripts) {
      for (const check of contract.verification.checks) {
        const origin = originScripts(check)
        if (!origin) continue
        const source = path.join(origin.worktree, checkScriptPath(origin.check_id))
        await copyFile(source, path.join(worktree, checkScriptPath(check.id)))
      }
    }
    let evidencePath = null
    if (evidence) {
      evidencePath = `.codegen-contract/${evidence.name}`
      await writeFile(path.join(worktree, evidencePath), `${JSON.stringify(evidence.data, null, 2)}\n`)
    }
    await writeFile(path.join(contractDirectory, "contract.json"), `${JSON.stringify(sealed, null, 2)}\n`)
    await commitPaths(worktree, [".codegen-contract"], `codegen: seal ${contract.contract_id}`, { force: true })

    const record = {
      contract_id: contract.contract_id,
      phase_id: phaseId,
      kind,
      parent_contract_id: parentContractId,
      worktree,
      base: baseHead,
      status: "PREPARED",
      risk_effective: riskEffective,
      gate_readiness: null,
      attempts: [],
      escalations: [],
      sealed_commit: null,
      result_commit: null,
      integration_head: null,
      conflict: null,
      evidence: evidencePath,
      stop: null,
    }

    let readiness = await checkGateReadiness({ directory: worktree, contract: sealed, timeoutSeconds: gateTimeoutSeconds })
    if (!readiness.ready && readiness.fixable && designer) {
      await emit("GATE_DESIGN_REQUESTED", { contract_id: contract.contract_id, reasons: readiness.reasons })
      // The Goal said a Gate already existed; the evidence says otherwise.
      // Recorded, never silently corrected: the Gate Designer resolves it.
      if (goal.routing.existing_gate) {
        const contradiction = {
          label: "existing_gate",
          claimed: true,
          effective: false,
          evidence: `${contract.contract_id}: ${readiness.reasons.join(", ")}; the Gate Designer had to make the checks real`,
        }
        state.triage.contradictions.push(contradiction)
        await emit("TRIAGE_CONTRADICTED", contradiction)
      }
      state.gate_designer_calls += 1
      const design = await runners.gateDesigner({
        directory: worktree,
        contract: ".codegen-contract/contract.json",
        workClass: contract.work_class,
        risk: riskEffective,
      })
      await emit("GATE_DESIGNED", { contract_id: contract.contract_id, result: design.result })
      if (design.result === "GATE_READY") {
        await commitPaths(worktree, [".codegen-contract"], `codegen: gate ${contract.contract_id}`, { force: true })
        readiness = design.readiness_after
      }
    }
    record.gate_readiness = readiness
    if (!readiness.ready) {
      record.status = "GATE_NOT_READY"
      return { record, sealed, ready: false }
    }
    await emit("GATE_READY", { contract_id: contract.contract_id, baseline: readiness.baseline })
    record.sealed_commit = await revision(worktree)
    return { record, sealed, ready: true }
  }

  // ---------------------------------------------------------------- Builder

  // Attempts run while each one brings new evidence. When a configuration
  // reproduces an earlier attempt (no progress) the orchestrator climbs one
  // rung: the worktree goes back to the sealed contract and the next
  // configuration of the Builder's list gets the accumulated evidence. The
  // contract fails only when the list is exhausted.
  async function buildContract({ contract, record }) {
    const excluded = []
    let signatures = []
    let evidence = record.evidence
    for (let attempt = 1; ; attempt += 1) {
      await emit("BUILDER_DISPATCHED", { contract_id: contract.contract_id, attempt, evidence, excluded: [...excluded] })
      const summary = await runners.builder({
        directory: record.worktree,
        contract: ".codegen-contract/contract.json",
        workClass: contract.work_class,
        risk: record.risk_effective,
        evidence,
        excludeConfigurations: [...excluded],
      })
      const selection = summary.selection ?? null
      // A runner that could not select a configuration reports status
      // NO_MATCH instead of a result; that is a blocking stop with the
      // admission reasons, not an unknown result.
      const result = summary.result ?? (summary.status === "NO_MATCH" ? "NO_BUILDER_ADMITTED" : summary.status)
      const signature = attemptSignature(result, summary)
      const repeats = signatures.find((item) => item.signature === signature)?.attempt ?? null
      signatures.push({ attempt, signature })
      record.attempts.push({ attempt, rung: excluded.length + 1, configuration_id: selection?.configuration_id ?? null, result, evidence, repeats, summary })
      const outcome = classifyBuilderOutcome(result, { attempt, repeats })
      if (result === "NO_BUILDER_ADMITTED") {
        outcome.reason = `no builder admitted for ${contract.work_class} at risk ${record.risk_effective}${excluded.length > 0 ? ` after escalating past ${excluded.join(", ")}` : ""}: ${(summary.rejected ?? []).slice(0, 4).map((r) => `${r.configuration_id} (${(r.reasons ?? []).join(", ")})`).join("; ")}`
      }
      if (outcome.disposition === "ACCEPT") {
        record.result_commit = await commitPaths(
          record.worktree,
          contract.allowed_to_modify.map(pathspec),
          `codegen(${contract.contract_id}): ${contract.objective}`,
        )
        record.status = record.result_commit ? "PASSED" : "NO_RESULT_COMMIT"
        await emit("CONTRACT_PASSED", { contract_id: contract.contract_id, attempt, commit: record.result_commit })
        return record.status === "PASSED"
      }
      if (outcome.disposition === "RETRY") {
        if (summary.result === "SCOPE_FAIL") await restorePaths(record.worktree, summary.outside_scope ?? [])
        evidence = `.codegen-contract/evidence-${attempt}.json`
        await writeFile(
          path.join(record.worktree, evidence),
          `${JSON.stringify({ attempt, result: summary.result, outside_scope: summary.outside_scope, verification: summary.verification, attempts: summary.attempts, repair_evidence: record.evidence }, null, 2)}\n`,
        )
        await emit("RETRY", { contract_id: contract.contract_id, attempt, reason: outcome.reason, evidence })
        continue
      }
      if (outcome.status === "BUILD_FAILED" && selection?.configuration_id) {
        await metalog?.append?.(stopEntry({ role: "builder", selection, reason: outcome.reason, runId: effectiveRunId, context: { contract_id: contract.contract_id, attempt } }))
        const next = (selection.ladder ?? []).find((id) => id !== selection.configuration_id && !excluded.includes(id)) ?? null
        if (next) {
          excluded.push(selection.configuration_id)
          await resetWorktree(record.worktree, record.sealed_commit)
          evidence = `.codegen-contract/evidence-rung-${excluded.length + 1}.json`
          await writeFile(
            path.join(record.worktree, evidence),
            `${JSON.stringify(
              {
                escalated_from: selection.configuration_id,
                reason: outcome.reason,
                repair_evidence: record.evidence,
                attempts: record.attempts.map((item) => ({ attempt: item.attempt, configuration_id: item.configuration_id, result: item.result, outside_scope: item.summary?.outside_scope, verification: item.summary?.verification })),
              },
              null,
              2,
            )}\n`,
          )
          signatures = []
          const escalation = { role: "builder", contract_id: contract.contract_id, from: selection.configuration_id, to: next, reason: outcome.reason, evidence }
          record.escalations.push(escalation)
          state.escalations.push(escalation)
          await emit("ESCALATED", escalation)
          continue
        }
        outcome.reason = `${outcome.reason}; no other builder admitted`
      }
      record.status = outcome.status
      record.stop = summary.user_action ?? outcome.reason
      await emit("CONTRACT_FAILED", { contract_id: contract.contract_id, attempt, status: outcome.status, reason: outcome.reason })
      return false
    }
  }

  // ------------------------------------------------------------ Integration

  // The orchestrator alone moves the integration branch. A conflict keeps
  // its evidence (the unmerged paths) and never stops the wave: the rest
  // integrates first, the conflicting contract is rebuilt on the new head.
  async function integrateRecord(record) {
    const picked = await cherryPick(state.integration_worktree, record.result_commit)
    if (!picked.ok) {
      record.conflict = { paths: picked.paths, detail: picked.conflict, against_head: state.integration_head, original_commit: record.result_commit }
      await emit("INTEGRATION_CONFLICT", { contract_id: record.contract_id, paths: picked.paths, against_head: state.integration_head, detail: picked.conflict })
      return false
    }
    record.integration_head = picked.head
    state.integration_sequence.push({ contract_id: record.contract_id, commit: record.result_commit, base: record.base, head: picked.head })
    state.integration_head = picked.head
    await emit("INTEGRATED", { contract_id: record.contract_id, head: picked.head })
    gateSources.push({ contract_id: record.contract_id, source: path.join(record.worktree, ".codegen-contract") })
    return true
  }

  // D1: the same sealed contract, rebuilt in a fresh worktree from the head
  // it conflicted with, with the conflict as evidence. A commit whose parent
  // is the head cannot conflict again. Returns "OK", a stop state, or a
  // replan request when the Planner has to reorganize the work.
  async function rebuildOnHead(record) {
    const entry = contracts.get(record.contract_id)
    const contract = entry.contract
    const round = (rebuilds.get(record.contract_id) ?? 0) + 1
    rebuilds.set(record.contract_id, round)
    const evidenceData = {
      kind: "integration-conflict",
      contract_id: record.contract_id,
      round,
      conflicting_paths: record.conflict.paths,
      against_head: record.conflict.against_head,
      original_commit: record.conflict.original_commit,
      original_patch: await commitPatch(record.worktree, record.conflict.original_commit),
      detail: record.conflict.detail,
      note: "Your earlier result could not be applied on the integrated tree. Re-implement the sealed contract on this tree; the original patch shows what was done before.",
    }
    await emit("REBUILD_REQUESTED", { contract_id: record.contract_id, round, paths: record.conflict.paths, head: state.integration_head })
    const wave = { index: state.waves.length + 1, kind: "rebuild", phases: [record.phase_id], status: "STARTED", contracts: [] }
    state.waves.push(wave)
    const prepared = await prepareContract({
      contract,
      phaseId: record.phase_id,
      kind: "rebuild",
      riskEffective: record.risk_effective,
      baseHead: state.integration_head,
      worktreeName: `${record.contract_id}.rebuild-${round}`,
      evidence: { name: "repair-evidence.json", data: evidenceData },
      originScripts: (check) => ({ worktree: record.worktree, check_id: check.id }),
      parentContractId: record.contract_id,
    })
    wave.contracts.push(prepared.record)
    const repair = { kind: "rebuild", contract_id: prepared.record.contract_id, parent_contract_id: record.contract_id, round, status: null, reasons: record.conflict.paths }
    state.repairs.push(repair)
    if (!prepared.ready) {
      wave.status = "BLOCKED"
      repair.status = "GATE_NOT_READY"
      await persist()
      return { replan: { kind: "integration-conflict", contract_id: record.contract_id, reason: `on the integrated head the sealed checks no longer behave as the contract demands: ${prepared.record.gate_readiness.reasons.join(", ")}`, readiness: prepared.record.gate_readiness, ...evidenceData, original_patch: undefined } }
    }
    await persist()
    const passed = await buildContract({ contract, record: prepared.record })
    await persist()
    if (!passed) {
      wave.status = "BLOCKED"
      repair.status = prepared.record.status
      if (TERMINAL_RECORD_STATUSES.has(prepared.record.status)) {
        return { stopped: await stop(prepared.record.status, `${prepared.record.contract_id}: ${prepared.record.stop ?? prepared.record.status}`, { user_action: prepared.record.status === "USER_ACTION_REQUIRED" ? prepared.record.stop : null }) }
      }
      return { replan: { kind: "integration-conflict", contract_id: record.contract_id, reason: `rebuilding ${record.contract_id} on the integrated head failed: ${prepared.record.stop ?? prepared.record.status}`, attempts: prepared.record.attempts.map((item) => ({ attempt: item.attempt, result: item.result, configuration_id: item.configuration_id })), ...evidenceData, original_patch: undefined } }
    }
    if (!(await integrateRecord(prepared.record))) {
      wave.status = "BLOCKED"
      repair.status = "INTEGRATION_CONFLICT"
      return { stopped: await stop("BLOCKED", `${record.contract_id}: a commit rebuilt on the integration head conflicted again (${prepared.record.conflict.paths.join(", ")}); the integration branch was modified outside the run`) }
    }
    wave.status = "COMPLETED"
    repair.status = "INTEGRATED"
    await emit("WAVE_COMPLETED", { wave: wave.index, kind: "rebuild", head: state.integration_head })
    await persist()
    return { ok: true }
  }

  // ------------------------------------------------------------------ Waves

  // One worktree per contract, builders in parallel, gates per contract,
  // then integration in contract order. Returns { ok }, { stopped }, or
  // { replan } (a conflict the rebuild could not resolve).
  async function runWaves(plan, waves, riskByContract, kind) {
    const phasesById = new Map(plan.phases.map((phase) => [phase.phase_id, phase]))
    for (const phaseIds of waves) {
      const waveContracts = phaseIds.flatMap((phaseId) => phasesById.get(phaseId).contracts.map((contract) => ({ phaseId, contract })))
      const wave = { index: state.waves.length + 1, kind, phases: phaseIds, status: "STARTED", base: state.integration_head, contracts: [] }
      state.waves.push(wave)
      await emit("WAVE_READY", { wave: wave.index, kind, phases: phaseIds, contracts: waveContracts.map((c) => c.contract.contract_id) })

      const prepared = []
      for (const { phaseId, contract } of waveContracts) {
        const riskEffective = riskByContract.get(contract.contract_id) ?? contract.risk
        const result = await prepareContract({
          contract,
          phaseId,
          kind,
          riskEffective,
          baseHead: state.integration_head,
          worktreeName: contract.contract_id,
          designer: true,
        })
        wave.contracts.push(result.record)
        if (!result.ready) {
          wave.status = "BLOCKED"
          await emit("WAVE_BLOCKED", { wave: wave.index, contract_id: contract.contract_id, reasons: result.record.gate_readiness.reasons })
          await persist()
          return { stopped: await stop("GATE_NOT_READY", `${contract.contract_id}: ${result.record.gate_readiness.reasons.join(", ")}`) }
        }
        prepared.push({ contract, record: result.record })
      }
      await persist()

      await pool(prepared, concurrency, ({ contract, record }) => buildContract({ contract, record }))
      await persist()

      const failed = wave.contracts.filter((record) => record.status !== "PASSED")
      if (failed.length > 0) {
        wave.status = "BLOCKED"
        await emit("WAVE_BLOCKED", { wave: wave.index, failed: failed.map((record) => [record.contract_id, record.status]) })
        const userAction = failed.find((record) => record.status === "USER_ACTION_REQUIRED")?.stop ?? null
        return {
          stopped: await stop(
            outcomeStatusOf(failed),
            failed.map((record) => `${record.contract_id}: ${record.stop ?? record.status}`).join("; "),
            { user_action: userAction },
          ),
        }
      }

      const conflicts = []
      for (const record of [...wave.contracts].sort((a, b) => a.contract_id.localeCompare(b.contract_id))) {
        if (!(await integrateRecord(record))) conflicts.push(record)
      }
      if (conflicts.length > 0) {
        wave.status = "INTEGRATION_CONFLICT"
        await persist()
        for (const record of conflicts) {
          const outcome = await rebuildOnHead(record)
          if (!outcome.ok) return outcome
        }
      }
      wave.status = "COMPLETED"
      await emit("WAVE_COMPLETED", { wave: wave.index, kind, head: state.integration_head })
      await persist()
    }
    return { ok: true }
  }

  // ------------------------------------------------------------- Diagnosis

  // Replays one gate (or one plan-level command) along the integration
  // branch in a scratch worktree, one step at a time. Deterministic: Git
  // trees and check exit codes, no model.
  async function replay(diagnosis) {
    const scratch = path.join(runDirectory, "diagnosis")
    await removeWorktree({ repository: directory, directory: scratch })
    await createWorktree({ repository: directory, directory: scratch, revision: state.base_revision })
    const source = diagnosis.kind === "contract-gate" ? gateSources.find((item) => item.contract_id === diagnosis.failing_contract_id)?.source : null
    const results = []
    try {
      for (const step of diagnosis.steps) {
        let applied = true
        if (step.op === "checkout") {
          await checkoutDetached(scratch, step.revision)
          if (step.then_pick) applied = (await cherryPick(scratch, step.then_pick)).ok
        } else if (step.op === "pick") {
          applied = (await cherryPick(scratch, step.commit)).ok
        }
        if (!applied) {
          results.push({ label: step.label, contract_id: step.contract_id, pass: false, applied: false })
          break
        }
        let pass
        let exitCode
        if (diagnosis.kind === "contract-gate") {
          const gate = await runContractGate({ directory: scratch, source, timeoutSeconds: gateTimeoutSeconds })
          const verdicts = new Map(gate.check_results.map((item) => [item.check_id, item.result]))
          pass = diagnosis.failing_checks.every((id) => verdicts.get(id) === "PASS")
          exitCode = gate.exit_code
        } else {
          const result = await runProcess(diagnosis.command, [], { cwd: scratch, timeoutSeconds: gateTimeoutSeconds, shell: true })
          pass = result.exitCode === 0
          exitCode = result.exitCode
        }
        results.push({ label: step.label, contract_id: step.contract_id, pass, exit_code: exitCode, applied: true })
      }
    } finally {
      await removeWorktree({ repository: directory, directory: scratch })
    }
    return results
  }

  // ------------------------------------------------------------ Final Gate

  // The final Gate runs on the integrated result; a failure is diagnosed,
  // repaired by a composed contract when the facts allow it, or handed to
  // the Planner with the evidence. Every round is a new final Gate; the
  // loop stops when a round reproduces an earlier one.
  async function finalGateLoop() {
    while (true) {
      const round = state.final_gate_rounds.length + 1
      await emit("FINAL_GATE_STARTED", { head: state.integration_head, round })
      state.final_gate = await runFinalGate({
        directory: state.integration_worktree,
        baseRevision: state.base_revision,
        plan: mergedPlanView(plans),
        contractGates: gateSources,
        timeoutSeconds: gateTimeoutSeconds,
      })
      await emit(state.final_gate.result === "PASS" ? "FINAL_GATE_PASS" : "FINAL_GATE_FAIL", { round, ...state.final_gate })
      await persist()
      if (state.final_gate.result === "PASS") return { ok: true }

      const signature = finalGateSignature(state.final_gate)
      const diagnosis = diagnoseFinalGate({ finalGate: state.final_gate, sequence: state.integration_sequence, baseRevision: state.base_revision })
      if (diagnosis.disposition === "BLOCKED") {
        state.final_gate_rounds.push({ round, signature, key: null, disposition: "BLOCKED", reason: diagnosis.reason })
        return { stopped: await stop("BLOCKED", diagnosis.reason) }
      }
      let verdict = diagnosis
      let replayResults = null
      if (diagnosis.disposition === "REPLAY") {
        replayResults = await replay(diagnosis)
        verdict = interpretReplay(diagnosis, replayResults)
      }
      const key = verdict.disposition === "REPAIR"
        ? repairKey({ culprit_id: verdict.culprit_id, failing_contract_id: diagnosis.failing_contract_id ?? null, failing_checks: diagnosis.failing_checks ?? [], command: diagnosis.command ?? null })
        : null
      const progress = repairProgress(state.final_gate_rounds, { signature, key })
      state.final_gate_rounds.push({ round, signature, key, disposition: verdict.disposition, reason: verdict.reason ?? null, culprit_id: verdict.culprit_id ?? null })
      await emit("FINAL_GATE_DIAGNOSED", { round, kind: diagnosis.kind ?? null, disposition: verdict.disposition, culprit_id: verdict.culprit_id ?? null, reason: verdict.reason ?? null, replay: replayResults })
      if (progress.stop) {
        state.stop_reason = progress.reason
        await emit("FINAL_GATE_NO_PROGRESS", { round, reason: progress.reason })
        return { failed: true }
      }
      const evidence = {
        kind: "final-gate",
        round,
        reasons: state.final_gate.reasons,
        failing_contract_id: diagnosis.failing_contract_id ?? null,
        failing_checks: diagnosis.failing_checks ?? [],
        command: diagnosis.command ?? null,
        output: diagnosis.output ?? null,
        replay: replayResults,
        verdict,
      }
      if (verdict.disposition !== "REPAIR") {
        const outcome = await replan({ ...evidence, reason: verdict.reason })
        if (!outcome.ok) return outcome
        continue
      }
      const outcome = await repairAfterFinalGate({ diagnosis, verdict, evidence, round })
      if (!outcome.ok) return outcome
    }
  }

  // D2: a repair contract composed from the culprit and the failing
  // contract, admitted by the Router for derived work, gated by readiness
  // on the integration head, built, and integrated by the orchestrator.
  async function repairAfterFinalGate({ diagnosis, verdict, evidence, round }) {
    const culpritEntry = contracts.get(verdict.culprit_id)
    const failingEntry = diagnosis.failing_contract_id ? contracts.get(diagnosis.failing_contract_id) : null
    const records = allRecords()
    // The record that reached the branch: after a conflict the original
    // record passed its build but only its rebuild was integrated.
    const integrated = (contractId) => records.find((record) => record.contract_id === contractId && record.integration_head !== null)
    const culpritRecord = integrated(verdict.culprit_id)
    const failingRecord = failingEntry ? integrated(failingEntry.contract.contract_id) : null
    if (!culpritEntry || !culpritRecord) {
      return replan({ ...evidence, reason: `the replay named ${verdict.culprit_id} but no integrated contract carries that id` })
    }
    const contract = composeRepairContract({
      round,
      culprit: culpritEntry.contract,
      failing: failingEntry?.contract ?? null,
      culpritRisk: culpritRecord.risk_effective,
      failingRisk: failingRecord?.risk_effective ?? null,
      finalGate: state.final_gate,
      command: diagnosis.command ?? null,
      diagnosis: { ...diagnosis, at: verdict.at },
    })
    const errors = []
    validateRequirementsAndChecks(contract, contract.contract_id, errors)
    if (errors.length > 0) return replan({ ...evidence, reason: `the composed repair contract is not valid: ${errors.join("; ")}` })
    const evidenceData = {
      ...evidence,
      culprit_id: verdict.culprit_id,
      culprit_patch: await commitPatch(culpritRecord.worktree, culpritRecord.result_commit),
      failing_patch: failingRecord ? await commitPatch(failingRecord.worktree, failingRecord.result_commit) : null,
      note: "These checks passed for each contract alone and fail on the integrated tree. Fix the interaction inside the allowed paths; every other check must keep passing.",
    }
    const finding = repairFinding(contract, { footprint: footprint(), evidence: [`final gate round ${round}: ${state.final_gate.reasons.join(", ")}`, `attributed to ${verdict.culprit_id} at ${verdict.at}`] })
    const routing = routeDerivedWork(finding)
    state.derived_work.push({ round, contract_id: contract.contract_id, finding, routing })
    await emit("REPAIR_CONTRACT", { round, contract_id: contract.contract_id, parent_contract_id: verdict.culprit_id, failing_contract_id: diagnosis.failing_contract_id ?? null, disposition: routing.disposition, reasons: routing.reasons })
    if (routing.disposition === "USER_DECISION_REQUIRED") return { stopped: await stop("USER_DECISION_REQUIRED", `${contract.contract_id}: ${routing.reasons.join(", ")}`) }
    if (routing.disposition !== "DIRECT_REPAIR") return replan({ ...evidence, reason: `the Router refused the composed repair (${routing.reasons.join(", ")})` })

    const wave = { index: state.waves.length + 1, kind: "repair", phases: [culpritEntry.phaseId], status: "STARTED", base: state.integration_head, contracts: [] }
    state.waves.push(wave)
    const originWorktree = new Map([[culpritRecord.contract_id, culpritRecord.worktree], ...(failingRecord ? [[failingRecord.contract_id, failingRecord.worktree]] : [])])
    const prepared = await prepareContract({
      contract,
      phaseId: culpritEntry.phaseId,
      kind: "repair",
      riskEffective: contract.risk,
      baseHead: state.integration_head,
      worktreeName: contract.contract_id,
      evidence: { name: "repair-evidence.json", data: evidenceData },
      originScripts: (check) => (check.origin ? { worktree: originWorktree.get(check.origin.contract_id), check_id: check.origin.check_id } : null),
      parentContractId: verdict.culprit_id,
    })
    wave.contracts.push(prepared.record)
    contracts.set(contract.contract_id, { contract, phaseId: culpritEntry.phaseId, kind: "repair" })
    const repair = { kind: "final-gate", round, contract_id: contract.contract_id, parent_contract_id: verdict.culprit_id, failing_contract_id: diagnosis.failing_contract_id ?? null, failing_checks: diagnosis.failing_checks ?? [], command: diagnosis.command ?? null, status: null }
    state.repairs.push(repair)
    if (!prepared.ready) {
      wave.status = "BLOCKED"
      repair.status = "GATE_NOT_READY"
      await persist()
      return replan({ ...evidence, reason: `the composed repair contract cannot be gated on the integration head: ${prepared.record.gate_readiness.reasons.join(", ")}` })
    }
    await persist()
    const passed = await buildContract({ contract, record: prepared.record })
    await persist()
    if (!passed) {
      wave.status = "BLOCKED"
      repair.status = prepared.record.status
      if (TERMINAL_RECORD_STATUSES.has(prepared.record.status)) {
        return { stopped: await stop(prepared.record.status, `${contract.contract_id}: ${prepared.record.stop ?? prepared.record.status}`, { user_action: prepared.record.status === "USER_ACTION_REQUIRED" ? prepared.record.stop : null }) }
      }
      return replan({ ...evidence, reason: `the repair contract ${contract.contract_id} failed: ${prepared.record.stop ?? prepared.record.status}`, attempts: prepared.record.attempts.map((item) => ({ attempt: item.attempt, result: item.result, configuration_id: item.configuration_id })) })
    }
    if (!(await integrateRecord(prepared.record))) {
      wave.status = "BLOCKED"
      repair.status = "INTEGRATION_CONFLICT"
      return { stopped: await stop("BLOCKED", `${contract.contract_id}: a repair built on the integration head conflicted (${prepared.record.conflict.paths.join(", ")}); the integration branch was modified outside the run`) }
    }
    wave.status = "COMPLETED"
    repair.status = "INTEGRATED"
    await emit("WAVE_COMPLETED", { wave: wave.index, kind: "repair", head: state.integration_head })
    await persist()
    return { ok: true }
  }

  // ------------------------------------------------------------- Replanning

  // The Planner reorganizes the work with the evidence: it inspects the
  // integrated tree (the integration worktree is its repository), writes a
  // repair plan based on the integration head, and that plan runs on top of
  // what was already integrated. On the planned route the user reviews the
  // repair plan first, as they reviewed the original; on the direct route
  // only a contradiction pauses (a raised risk, paths outside the approved
  // footprint). Returns { ok }, { stopped }, or { paused }.
  async function replan(evidenceData) {
    // The Planner is asked again only with new evidence: a replan for the
    // same failure of the same contract would get the same facts, so the run
    // stops there. Final-gate rounds have their own signature; this guard
    // covers the conflict and repair-plan paths that never reach one.
    const signature = JSON.stringify({
      kind: evidenceData.kind ?? null,
      contract_id: evidenceData.contract_id ?? evidenceData.failing_contract_id ?? null,
      reason: String(evidenceData.reason ?? "").replace(/\.repair-\d+/g, ".repair-N"),
    })
    const earlier = state.replan_rounds.findIndex((item) => item.signature === signature)
    state.replan_rounds.push({ round: state.replan_rounds.length + 1, signature, reason: evidenceData.reason ?? null })
    if (earlier !== -1) {
      await emit("REPLAN_NO_PROGRESS", { round: state.replan_rounds.length, reason: evidenceData.reason ?? null })
      return { stopped: await stop("REPLAN_REQUIRED", `no progress: replan round ${state.replan_rounds.length} reproduced round ${earlier + 1} (${evidenceData.reason ?? "same failure"})`) }
    }
    const round = state.repair_plans.length + 1
    const cwd = state.integration_worktree
    await ensureExcluded(directory, ".codegen-plan/")
    await ensureExcluded(directory, ".codegen-goal/")
    await linkOpenCodeLayer(directory, cwd)
    await mkdir(path.dirname(path.join(cwd, goalPath)), { recursive: true })
    await copyFile(path.resolve(directory, goalPath), path.join(cwd, goalPath))
    await mkdir(path.join(cwd, ".codegen-plan"), { recursive: true })
    const evidence = `.codegen-plan/${effectiveRunId}-repair-${round}.evidence.json`
    const data = {
      ...evidenceData,
      failure_kind: evidenceData.kind ?? null,
      kind: "repair",
      round,
      integration_head: state.integration_head,
      integration_branch: state.integration_branch,
      approved_footprint: footprint(),
      integrated_contracts: state.integration_sequence.map((item) => item.contract_id),
      repairs_so_far: state.repairs,
    }
    await writeFile(path.join(cwd, evidence), `${JSON.stringify(data, null, 2)}\n`)
    await emit("REPLAN_REQUESTED", { round, reason: evidenceData.reason, evidence: projectRelative(path.join(cwd, evidence)) })
    const requested = await requestPlan({ cwd, route: state.route, outputPrefix: `.codegen-plan/${effectiveRunId}-repair-${round}`, repairEvidence: evidence })
    if (requested.stopped) return { stopped: requested.stopped }
    const plan = requested.plan
    const validation = validatePlan(plan, { workClasses, goal, route: state.route, riskFloors, partialCoverage: true })
    const existing = new Set(contracts.keys())
    for (const phase of plan.phases ?? []) {
      for (const contract of phase.contracts ?? []) {
        if (existing.has(contract.contract_id)) validation.errors.push(`${contract.contract_id}: a contract with this id already ran in this run; a repair plan needs new ids`)
      }
    }
    if (plan.base_revision !== state.integration_head) validation.errors.push(`base_revision ${plan.base_revision} is not the integration head ${state.integration_head}`)
    validation.valid = validation.errors.length === 0
    await emit("PLAN_VALIDATED", { repair: true, round, valid: validation.valid, errors: validation.errors, execution_waves: validation.execution_waves })
    if (!validation.valid) return { stopped: await stop("PLAN_INVALID", validation.errors.join("; ")) }
    const approved = footprint()
    const outside = [...new Set(plan.phases.flatMap((phase) => phase.contracts.flatMap((contract) => contract.allowed_to_modify)))].filter(
      (allowedPath) => !approved.some((pattern) => pathMatches(pattern, pathspec(allowedPath)) || pathMatches(allowedPath, pathspec(pattern))),
    )
    const contradictions = [...validation.triage.contradictions]
    if (outside.length > 0) {
      contradictions.push({ label: "footprint", claimed: approved.join(", "), effective: outside.join(", "), evidence: `the repair plan modifies paths outside the approved footprint: ${outside.join(", ")}` })
    }
    for (const contradiction of contradictions) await emit("TRIAGE_CONTRADICTED", contradiction)
    const entry = { round, plan_id: plan.plan_id, plan_path: requested.output, plan_markdown: requested.markdown, reviewed: false, contradictions, triage: validation.triage, execution_waves: validation.execution_waves }
    const needsReview = state.route === "planned" || contradictions.length > 0
    if (needsReview) {
      state.pending_plan = entry
      await persist()
      return {
        paused: await stop("PLAN_REVIEW_REQUIRED", `review ${requested.markdown ?? requested.output} and orchestrate again with --resume ${effectiveRunId}`, {
          resume: effectiveRunId,
          plan_path: requested.output,
          plan_markdown: requested.markdown,
          contradictions,
          repair_round: round,
        }),
      }
    }
    return runRepairPlan(plan, entry)
  }

  async function runRepairPlan(plan, entry) {
    entry.reviewed = true
    state.repair_plans.push(entry)
    registerPlan(plan, "repair-plan")
    const riskByContract = new Map(entry.triage.contracts.map((item) => [item.contract_id, item.risk_effective]))
    await emit("DAG_READY", { repair: true, round: entry.round, waves: entry.execution_waves, route: state.route, risk_effective: entry.triage.risk_effective })
    const outcome = await runWaves(plan, entry.execution_waves, riskByContract, "repair-plan")
    if (outcome.replan) return replan(outcome.replan)
    return outcome
  }

  // ---------------------------------------------------------------- Closing

  // The Goal coverage ledger: what each Goal id was claimed by, and what the
  // contracts (repairs included) and their checks actually did. Manual and
  // operational items stay pending human verification; nothing declares
  // them green.
  async function finish() {
    const results = new Map()
    for (const record of allRecords()) {
      const gate = state.final_gate.checks.find((check) => check.contract_id === record.contract_id)
      results.set(record.contract_id, {
        status: record.status,
        checks: Object.fromEntries((gate?.check_results ?? []).map((item) => [item.check_id, item.result])),
      })
    }
    state.goal_coverage = goalCoverage(mergedPlanView(plans), goal, results)
    await emit("GOAL_COVERAGE", state.goal_coverage.summary)
    if (!keepWorktrees && state.final_gate.result === "PASS") {
      for (const worktree of new Set(worktreesToRemove)) await removeWorktree({ repository: directory, directory: worktree })
    }
    state.status = state.final_gate.result === "PASS" ? "COMPLETED" : "FINAL_GATE_FAILED"
    if (state.status === "FINAL_GATE_FAILED" && !state.stop_reason) state.stop_reason = state.final_gate.reasons.join(", ")
    await emit("RUN_COMPLETED", { status: state.status, branch: state.integration_branch, head: state.integration_head, repairs: state.repairs.length })
    await persist()
    return state
  }

  async function verifyAndClose() {
    const outcome = await finalGateLoop()
    if (outcome.stopped) return outcome.stopped
    if (outcome.paused) return outcome.paused
    return finish()
  }

  // ------------------------------------------------------------------ Start

  async function start() {
    const baseRevision = await revision(directory)

    // 1. Goal and Router.
    goal = JSON.parse(await readFile(path.resolve(directory, goalPath), "utf8"))
    const goalValidation = validateGoal(goal)
    if (!goalValidation.valid) return stop("INVALID_GOAL", goalValidation.errors.join("; "))
    state.goal_id = goal.goal_id
    await emit("GOAL_LOADED", { goal_id: goal.goal_id, status: goal.status })
    const routing = routeGoal(goal)
    await emit("ROUTED", routing)
    // Only the user seals a Goal, and only a SEALED Goal reaches the Planner.
    // Deliberation is not the orchestrator's: an open Goal stops here with
    // what keeps it open (pending research, blocking questions), and the
    // supervisor takes the user to deliberate or to approve.
    if (routing.status !== "ROUTED") {
      const pending = routing.needs_deliberation ? `; deliberate first (${routing.reasons.join(", ")})` : "; approve it first"
      return stop("APPROVAL_REQUIRED", `goal status is ${goal.status}, not SEALED${pending}`, { routing })
    }
    state.route = routing.route
    state.base_revision = baseRevision

    // 2. Plan: reuse a plan the user reviewed, or ask the Planner. The direct
    //    route asks for one contract; a plan that needs more is re-routed.
    let plan
    if (planPath) {
      plan = JSON.parse(await readFile(path.resolve(directory, planPath), "utf8"))
      state.plan_path = planPath
      state.plan_reviewed = true
    } else {
      const requested = await requestPlan({ cwd: directory, route: routing.route, outputPrefix: `.codegen-plan/${effectiveRunId}` })
      if (requested.stopped) return requested.stopped
      plan = requested.plan
      state.plan_path = requested.output
      state.plan_markdown = requested.markdown
    }
    // The plan is validated against the Goal: every must requirement and every
    // automated acceptance criterion has to be claimed by some contract. The
    // Goal's triage is judged again with the plan's evidence: a direct route
    // that needs more than one contract becomes planned, and a contract's
    // effective risk is the highest of what the Planner declared and what its
    // paths imply. The code only ever raises a label; a raise is a
    // contradiction the user accepts at plan review.
    const planValidation = validatePlan(plan, { workClasses, goal, route: routing.route, riskFloors })
    await emit("PLAN_VALIDATED", { valid: planValidation.valid, errors: planValidation.errors, execution_waves: planValidation.execution_waves })
    if (!planValidation.valid) return stop("PLAN_INVALID", planValidation.errors.join("; "))
    if (plan.base_revision !== baseRevision) {
      return stop("PLAN_STALE", `plan base_revision ${plan.base_revision} is not HEAD ${baseRevision}`)
    }
    state.plan_id = plan.plan_id
    state.triage = planValidation.triage
    state.route = planValidation.triage.route_effective
    for (const contradiction of planValidation.triage.contradictions) await emit("TRIAGE_CONTRADICTED", contradiction)
    const riskByContract = new Map(planValidation.triage.contracts.map((item) => [item.contract_id, item.risk_effective]))
    await emit("DAG_READY", { waves: planValidation.execution_waves, route: state.route, risk_effective: planValidation.triage.risk_effective })

    // On the planned route, or whenever the plan contradicts the Goal's
    // triage, the user reviews PLAN.md before anyone builds: the run stops
    // here, before any worktree exists, and resumes when orchestrate is called
    // again with the reviewed plan. A direct route that fits its labels builds
    // straight through.
    const needsReview = state.route === "planned" || planValidation.triage.contradictions.length > 0
    if (needsReview && !state.plan_reviewed) {
      return stop("PLAN_REVIEW_REQUIRED", `review ${state.plan_markdown ?? state.plan_path} and orchestrate again with --plan ${state.plan_path}`, {
        plan_path: state.plan_path,
        plan_markdown: state.plan_markdown,
        contradictions: planValidation.triage.contradictions,
      })
    }
    registerPlan(plan, "plan")

    // 3. Integration branch, isolated from the user's checkout.
    await createWorktree({
      repository: directory,
      directory: state.integration_worktree,
      revision: baseRevision,
      branch: state.integration_branch,
    })
    state.integration_head = baseRevision
    await persist()

    // 4. Waves, integration, rebuilds after conflicts.
    let outcome = await runWaves(plan, planValidation.execution_waves, riskByContract, "plan")
    if (outcome.replan) outcome = await replan(outcome.replan)
    if (outcome.stopped) return outcome.stopped
    if (outcome.paused) return outcome.paused

    // 5. Final Gate, repairs, and the Goal coverage ledger.
    return verifyAndClose()
  }

  // ----------------------------------------------------------------- Resume

  // Continues a run paused for the review of a repair plan. The state on
  // disk is the source of truth; the integration branch must still be where
  // the run left it.
  async function resume() {
    let saved
    try {
      saved = JSON.parse(await readFile(stateFile, "utf8"))
    } catch {
      return stop("RESUME_FAILED", `no state for run ${effectiveRunId} under ${RUN_ROOT}/`)
    }
    state = saved
    if (state.status !== "PLAN_REVIEW_REQUIRED" || !state.pending_plan) {
      return stop("RESUME_FAILED", `run ${effectiveRunId} is ${state.status} and has no repair plan pending review`)
    }
    const head = await revision(state.integration_worktree).catch(() => null)
    if (head !== state.integration_head) {
      return stop("RESUME_STALE", `integration branch ${state.integration_branch} is at ${head}, the run left it at ${state.integration_head}`)
    }
    goal = JSON.parse(await readFile(path.resolve(directory, state.goal_path), "utf8"))
    plans = []
    registerPlan(JSON.parse(await readFile(path.resolve(directory, state.plan_path), "utf8")), "plan")
    for (const entry of state.repair_plans) registerPlan(JSON.parse(await readFile(path.resolve(directory, entry.plan_path), "utf8")), "repair-plan")
    for (const record of allRecords()) {
      worktreesToRemove.push(record.worktree)
      if (record.kind === "repair") {
        const sealed = JSON.parse(await readFile(path.join(record.worktree, ".codegen-contract/contract.json"), "utf8"))
        contracts.set(record.contract_id, { contract: sealed, phaseId: record.phase_id, kind: "repair" })
      }
    }
    for (const item of state.integration_sequence) {
      const record = allRecords().find((candidate) => candidate.contract_id === item.contract_id && candidate.result_commit === item.commit)
      if (record) gateSources.push({ contract_id: item.contract_id, source: path.join(record.worktree, ".codegen-contract") })
    }
    for (const repair of state.repairs) if (repair.kind === "rebuild") rebuilds.set(repair.parent_contract_id, Math.max(rebuilds.get(repair.parent_contract_id) ?? 0, repair.round))
    const entry = state.pending_plan
    state.pending_plan = null
    state.status = "RESUMED"
    state.stop_reason = null
    state.resumed += 1
    await emit("RUN_RESUMED", { repair_round: entry.round, plan_path: entry.plan_path, head })
    const plan = JSON.parse(await readFile(path.resolve(directory, entry.plan_path), "utf8"))
    await persist()
    const outcome = await runRepairPlan(plan, entry)
    if (outcome.stopped) return outcome.stopped
    if (outcome.paused) return outcome.paused
    return verifyAndClose()
  }

  return { start, resume }
}
