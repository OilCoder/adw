import { access, readFile } from "node:fs/promises"
import path from "node:path"

import { MINIMUM_STATUSES } from "./model-selection.mjs"
import { runProcess } from "./process.mjs"

export const INSTALL_MANIFEST = ".opencode/.codegen-install.json"

export function parseArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near: ${key ?? "end of command"}`)
    }
    result[key.slice(2)] = value
  }
  return result
}

export async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export function newRunId() {
  return `${new Date().toISOString().replaceAll(/[-:.]/g, "").slice(0, 15)}Z-${process.pid}`
}

// Run artifacts (events, summaries) live under the system's runs directory;
// CODEGEN_RUNS_DIR redirects them (the test suite points it at a temp dir so
// the harness tree stays clean).
export function runsDirectory(systemRoot, ...segments) {
  const root = process.env.CODEGEN_RUNS_DIR ?? path.join(systemRoot, ".opencode/codegen/runs")
  return path.join(root, ...segments)
}

export async function loadRegistry(systemRoot) {
  return JSON.parse(
    await readFile(path.join(systemRoot, ".opencode/codegen/config/model-pools.json"), "utf8"),
  )
}

// System ceilings and floors for model-written budgets (config/budgets.json).
export async function loadLimits(systemRoot) {
  return JSON.parse(await readFile(path.join(systemRoot, ".opencode/codegen/config/budgets.json"), "utf8"))
}

// Minimum risk implied by the paths a contract may modify (config/risk-floors.json).
export async function loadRiskFloors(systemRoot) {
  return JSON.parse(await readFile(path.join(systemRoot, ".opencode/codegen/config/risk-floors.json"), "utf8"))
}

export const SOURCE_VERIFICATIONS = ["fetch", "offline"]

// Research sources are fetched and checked by default. `offline` skips the
// network and is a maintenance option of the harness repository (tests and
// smokes); an installed project always verifies.
export async function resolveSourceVerification(args, systemRoot) {
  const value = args["source-verification"] ?? "fetch"
  if (!SOURCE_VERIFICATIONS.includes(value)) {
    throw new Error(`source-verification must be one of: ${SOURCE_VERIFICATIONS.join(", ")}`)
  }
  if (value !== "fetch" && (await isInstalledProject(systemRoot))) {
    const error = new Error(
      "MAINTENANCE_ONLY: source verification cannot be skipped in an installed project; research citations are always fetched and checked",
    )
    error.code = "MAINTENANCE_ONLY"
    throw error
  }
  return value
}

// An installed project carries the installer manifest; the harness repository
// does not. Admission below `qualified` is a maintenance option of the harness
// repository (smokes and certification) and is refused in installed projects.
export async function isInstalledProject(systemRoot) {
  return exists(path.join(systemRoot, INSTALL_MANIFEST))
}

export async function resolveMinimumStatus(args, systemRoot) {
  const value = args["minimum-status"] ?? "qualified"
  if (!MINIMUM_STATUSES.includes(value)) {
    throw new Error(`minimum-status must be one of: ${MINIMUM_STATUSES.join(", ")}`)
  }
  if (value !== "qualified" && (await isInstalledProject(systemRoot))) {
    const error = new Error(
      `MAINTENANCE_ONLY: admission level ${value} is reserved for certification inside the harness repository; installed projects run only qualified configurations`,
    )
    error.code = "MAINTENANCE_ONLY"
    throw error
  }
  return value
}

// Pinning a configuration bypasses the policy order (never the admission
// filters) and exists for certification runs only.
export async function resolvePinnedConfiguration(args, systemRoot) {
  const value = args.configuration ?? null
  if (value && (await isInstalledProject(systemRoot))) {
    const error = new Error(
      "MAINTENANCE_ONLY: pinning a configuration is reserved for certification inside the harness repository",
    )
    error.code = "MAINTENANCE_ONLY"
    throw error
  }
  return value
}

export async function requireGitHead(directory) {
  const result = await runProcess("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: directory,
    timeoutSeconds: 30,
  })
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    const error = new Error("GIT_HEAD_REQUIRED: initialize Git and create a baseline commit before running code generation")
    error.code = "GIT_HEAD_REQUIRED"
    throw error
  }
  return result.stdout.trim()
}

export function resolveInsideProject(directory, relativeOrAbsolute, label) {
  const resolved = path.resolve(directory, relativeOrAbsolute)
  const relative = path.relative(directory, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the target project`)
  }
  return { absolute: resolved, relative }
}
