// The fit check: the first time this project selects a configuration, one
// call of seconds proves it fits the harness (it can write a file with the
// exact content asked, through its tools). It proves fit, not skill; skill
// shows in the metalog of real runs. The verdict is appended to the metalog,
// so it runs once per configuration per project.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { runAgentProcess } from "./agent-run.mjs"
import { classifyExecution } from "./builder-runner.mjs"
import { exists, isInstalledProject } from "./cli.mjs"
import { summarizeEvents } from "./run-metrics.mjs"

export const FIT_MODES = ["run", "off"]

// `off` exists for the harness repository's own tests; an installed project
// always checks fit.
export async function resolveFitCheck(args, systemRoot) {
  const value = args["fit-check"] ?? process.env.CODEGEN_FIT_CHECK ?? "run"
  if (!FIT_MODES.includes(value)) throw new Error(`fit-check must be one of: ${FIT_MODES.join(", ")}`)
  if (value !== "run" && (await isInstalledProject(systemRoot))) {
    const error = new Error("MAINTENANCE_ONLY: the fit check cannot be skipped in an installed project; every configuration is checked before its first use")
    error.code = "MAINTENANCE_ONLY"
    throw error
  }
  return value
}

export const PROBE_FILE = "probe.json"

export function fitPrompt(model) {
  return `Create a file named ${PROBE_FILE} in the current directory whose entire content is exactly this JSON: {"fit":"ok","model":"${model}"}. Use your file-writing tool. Do not run anything else and do not explain.`
}

// Results that leave the fit unknown: the provider, the account, or the
// login said no today; the model did not get to answer. A missing login on
// one machine must not bury a working configuration for the project.
const UNKNOWN_RESULTS = new Set(["PROVIDER_RATE_LIMIT", "PROVIDER_UNAVAILABLE", "ZEN_BALANCE_EXHAUSTED", "GO_USAGE_LIMIT", "LOCAL_RUNNER_ERROR", "AUTH_ERROR"])

// The probe runs in a temporary directory that carries the project's provider
// settings (enabled providers and whitelists), so a configuration the project
// cannot use fails its fit here instead of in a real run.
async function projectProviders(systemRoot) {
  for (const candidate of ["opencode.json", ".opencode/opencode.json"]) {
    const file = path.join(systemRoot, candidate)
    if (!(await exists(file))) continue
    try {
      const config = JSON.parse(await readFile(file, "utf8"))
      return { enabled_providers: config.enabled_providers, provider: config.provider }
    } catch {
      return {}
    }
  }
  return {}
}

export async function runFitCheck({ systemRoot, configuration, display = "inline", timeoutSeconds = 120 }) {
  const model = configuration.opencode_model
  const directory = await mkdtemp(path.join(os.tmpdir(), "codegen-fit-"))
  const started = Date.now()
  try {
    const providers = await projectProviders(systemRoot)
    const config = {
      $schema: "https://opencode.ai/config.json",
      share: "disabled",
      ...(providers.enabled_providers ? { enabled_providers: providers.enabled_providers } : {}),
      ...(providers.provider ? { provider: providers.provider } : {}),
      permission: { edit: "allow" },
    }
    await writeFile(path.join(directory, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`)
    const run = await runAgentProcess({
      directory,
      args: ["run", "--format", "json", "--model", model, "--agent", "build", fitPrompt(model)],
      timeoutSeconds,
      display,
      title: `fit · ${model}`,
      firstOutputSeconds: Math.min(60, timeoutSeconds),
    })
    const probeFile = path.join(directory, PROBE_FILE)
    const written = await exists(probeFile)
    const classification = classifyExecution({
      exitCode: run.exitCode,
      signal: run.signal,
      eventsText: run.stdout,
      stderr: run.stderr,
      changedFiles: written ? [PROBE_FILE] : [],
    })
    let result = classification.classification
    let outcome
    let reason
    if (written) {
      try {
        const probe = JSON.parse(await readFile(probeFile, "utf8"))
        if (probe?.fit === "ok" && probe?.model === model) {
          outcome = "pass"
          result = "PASS"
          reason = "probe written with the exact content through a tool"
        } else {
          outcome = "fail"
          result = "FIT_MISMATCH"
          reason = `probe content differs: ${JSON.stringify(probe).slice(0, 120)}`
        }
      } catch (error) {
        outcome = "fail"
        result = "FIT_MISMATCH"
        reason = `probe is not valid JSON: ${error.message}`
      }
    } else if (UNKNOWN_RESULTS.has(result)) {
      outcome = "unknown"
      reason = `${result}: ${classification.message ?? ""}`.trim()
    } else if (result === "SUCCESS") {
      outcome = "fail"
      result = "FIT_NO_FILE"
      reason = "the model finished without writing the probe: no tool use"
    } else {
      outcome = "fail"
      reason = `${result}: ${classification.message ?? ""}`.trim()
    }
    const metrics = summarizeEvents(run.stdout)
    return {
      outcome,
      result,
      reason,
      entry: {
        kind: "fit",
        configuration_id: configuration.configuration_id,
        model,
        provider: configuration.provider,
        outcome,
        result,
        reason,
        duration_s: Math.round((Date.now() - started) / 1000),
        tokens: { input: metrics.input_tokens, output: metrics.output_tokens },
        cost: metrics.reported_cost,
      },
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
