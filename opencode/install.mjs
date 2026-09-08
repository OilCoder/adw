#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { access, chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { checkRelease } from "./.opencode/codegen/lib/release.mjs"

const sourceRoot = path.dirname(fileURLToPath(import.meta.url))
const sourceOpenCode = path.join(sourceRoot, ".opencode")
const manifestRelative = ".opencode/.codegen-install.json"
// Machine-local state (runs, the metalog, the install manifest, the server
// file), plus the maintenance-only scripts (the catalog sync edits the
// registry of this repository; the smoke runs here, never in a target).
const ignoredOpenCodePaths = new Set([
  "node_modules",
  "package.json",
  "package-lock.json",
  "bun.lock",
  "codegen/runs",
  "codegen/metalog.jsonl",
  "codegen/scripts/catalog.mjs",
  "codegen/scripts/run-builder-smoke.sh",
  ".codegen-install.json",
  ".codegen-server.json",
])
const requiredIgnores = [
  ".opencode/node_modules/",
  ".opencode/package-lock.json",
  ".opencode/bun.lock",
  ".opencode/codegen/runs/",
  ".opencode/codegen/metalog.jsonl",
  ".opencode/.codegen-install.json",
  ".opencode/.codegen-server.json",
  ".codegen-goal/",
  ".codegen-plan/",
  ".codegen-research/",
  ".codegen-opinions/",
  ".codegen-run/",
]

function usage() {
  return "usage: node install.mjs <project-directory> [--dry-run] [--skip-validation] [--skip-install]"
}

function parseArgs(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")))
  const positional = argv.filter((arg) => !arg.startsWith("--"))
  const unknown = [...flags].filter((flag) => !["--dry-run", "--skip-validation", "--skip-install"].includes(flag))
  if (positional.length !== 1 || unknown.length) throw new Error(usage())
  return {
    targetRoot: path.resolve(positional[0]),
    dryRun: flags.has("--dry-run"),
    skipValidation: flags.has("--skip-validation"),
    skipInstall: flags.has("--skip-install"),
  }
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function hash(contents) {
  return createHash("sha256").update(contents).digest("hex")
}

async function readJson(filePath, fallback) {
  if (!(await exists(filePath))) return fallback
  try {
    return JSON.parse(await readFile(filePath, "utf8"))
  } catch (error) {
    throw new Error(`Cannot parse ${filePath}: ${error.message}`)
  }
}

async function collectFiles(directory, prefix = "") {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name)
    if ([...ignoredOpenCodePaths].some((ignored) => relative === ignored || relative.startsWith(`${ignored}/`))) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(absolute, relative)))
    else if (entry.isFile()) files.push(relative)
  }
  return files.sort()
}

function mergeDefaults(current, required, preserved, pointer = "") {
  if (Array.isArray(required)) {
    const values = Array.isArray(current) ? [...current] : []
    for (const item of required) {
      if (!values.some((value) => JSON.stringify(value) === JSON.stringify(item))) values.push(item)
    }
    return values
  }
  if (required && typeof required === "object") {
    const result = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {}
    for (const [key, value] of Object.entries(required)) {
      const child = pointer ? `${pointer}.${key}` : key
      if (!(key in result)) result[key] = value
      else result[key] = mergeDefaults(result[key], value, preserved, child)
    }
    return result
  }
  if (current !== required) preserved.push(pointer)
  return current
}

// The revision of this repository that is being installed; recorded in the
// manifest so a target project can say which harness it runs.
function harnessRevision() {
  const result = spawnSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : null
}

async function prepareManagedFiles(targetRoot) {
  const manifestPath = path.join(targetRoot, manifestRelative)
  const previous = await readJson(manifestPath, { files: {} })
  const files = await collectFiles(sourceOpenCode)
  const copies = []
  const hashes = {}
  const conflicts = []
  const removals = []

  for (const relative of files) {
    const source = path.join(sourceOpenCode, relative)
    const target = path.join(targetRoot, ".opencode", relative)
    const sourceContents = await readFile(source)
    const sourceHash = hash(sourceContents)
    hashes[relative] = sourceHash
    if (!(await exists(target))) {
      copies.push({ source, target })
      continue
    }
    const targetHash = hash(await readFile(target))
    if (targetHash === sourceHash) continue
    if (previous.files?.[relative] === targetHash) copies.push({ source, target })
    else conflicts.push(path.join(".opencode", relative))
  }
  // Files the harness dropped since the previous installation are removed
  // when they are still the installed copy; a locally modified one conflicts.
  for (const [relative, previousHash] of Object.entries(previous.files ?? {})) {
    if (relative in hashes) continue
    const target = path.join(targetRoot, ".opencode", relative)
    if (!(await exists(target))) continue
    if (hash(await readFile(target)) === previousHash) removals.push(target)
    else conflicts.push(`${path.join(".opencode", relative)} (removed from the harness but modified locally)`)
  }
  return {
    copies,
    removals,
    conflicts,
    manifestPath,
    manifest: { schema_version: 2, harness_revision: harnessRevision(), installed_at: new Date().toISOString(), files: hashes },
  }
}

// .opencode/package.json declares the runtime dependency of the tools and the
// plugin. A target may already have one (created by hand): its entries are
// kept and the required dependencies are added, so it is merged, never hashed.
async function prepareRuntimePackage(targetRoot) {
  const source = await readJson(path.join(sourceOpenCode, "package.json"), {})
  const targetPath = path.join(targetRoot, ".opencode", "package.json")
  const target = await readJson(targetPath, {})
  const merged = { private: true, ...target, dependencies: { ...(target.dependencies ?? {}) } }
  for (const [name, version] of Object.entries(source.dependencies ?? {})) merged.dependencies[name] ??= version
  return { path: targetPath, contents: `${JSON.stringify(merged, null, 2)}\n` }
}

async function prepareRootFiles(targetRoot) {
  const sourceConfig = await readJson(path.join(sourceRoot, "opencode.json"), {})
  const targetConfigPath = path.join(targetRoot, "opencode.json")
  const targetConfig = await readJson(targetConfigPath, {})
  const preserved = []
  const mergedConfig = mergeDefaults(targetConfig, sourceConfig, preserved)

  const sourcePackage = await readJson(path.join(sourceRoot, "package.json"), {})
  const targetPackagePath = path.join(targetRoot, "package.json")
  const hasPackage = await exists(targetPackagePath)
  const targetPackage = await readJson(targetPackagePath, hasPackage ? {} : { private: true })
  const scriptConflicts = []
  targetPackage.scripts ??= {}
  for (const [name, command] of Object.entries(sourcePackage.scripts ?? {})) {
    if (["test", "install:target", "catalog", "release:check"].includes(name)) continue
    if (targetPackage.scripts[name] && targetPackage.scripts[name] !== command) scriptConflicts.push(`package.json scripts.${name}`)
    else targetPackage.scripts[name] = command
  }

  const gitignorePath = path.join(targetRoot, ".gitignore")
  const gitignore = (await exists(gitignorePath)) ? await readFile(gitignorePath, "utf8") : ""
  const missingIgnores = requiredIgnores.filter((entry) => !gitignore.split(/\r?\n/).includes(entry))
  const mergedGitignore = `${gitignore}${gitignore && !gitignore.endsWith("\n") ? "\n" : ""}${missingIgnores.join("\n")}${missingIgnores.length ? "\n" : ""}`

  return {
    conflicts: scriptConflicts,
    preserved,
    writes: [
      { path: targetConfigPath, contents: `${JSON.stringify(mergedConfig, null, 2)}\n` },
      { path: targetPackagePath, contents: `${JSON.stringify(targetPackage, null, 2)}\n` },
      { path: gitignorePath, contents: mergedGitignore },
    ],
  }
}

async function writeIfChanged(filePath, contents) {
  if ((await exists(filePath)) && (await readFile(filePath, "utf8")) === contents) return false
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, contents)
  return true
}

async function main() {
  const { targetRoot, dryRun, skipValidation, skipInstall } = parseArgs(process.argv.slice(2))
  if (!(await exists(targetRoot)) || !(await stat(targetRoot)).isDirectory()) throw new Error(`Target is not a directory: ${targetRoot}`)
  if (targetRoot === sourceRoot) throw new Error("Source and target directories must be different")

  // A target project receives a complete system: every request production
  // issues must resolve to at least one admitted configuration.
  const registry = await readJson(path.join(sourceRoot, ".opencode/codegen/config/model-pools.json"), null)
  if (!registry) throw new Error("Source registry .opencode/codegen/config/model-pools.json is missing")
  const release = checkRelease(registry)
  if (!release.ok) {
    throw new Error(`Release check failed; add admitted configurations to the routes of model-pools.json before installing:\n- ${release.missing.join("\n- ")}`)
  }

  const managed = await prepareManagedFiles(targetRoot)
  const runtimePackage = await prepareRuntimePackage(targetRoot)
  const root = await prepareRootFiles(targetRoot)
  const conflicts = [...managed.conflicts, ...root.conflicts]
  if (conflicts.length) throw new Error(`Installation conflicts:\n- ${conflicts.join("\n- ")}`)

  console.log(`${dryRun ? "Would install" : "Installing"} OpenCode code-generation system into ${targetRoot}`)
  console.log(`Release check: every role has an admitted configuration (builder family first in line: ${release.builder_family})`)
  console.log(`Harness revision: ${managed.manifest.harness_revision ?? "unknown (source is not a Git checkout)"}`)
  console.log(`Managed files to copy: ${managed.copies.length}`)
  if (managed.removals.length) console.log(`Files dropped by the harness to remove: ${managed.removals.map((file) => path.relative(targetRoot, file)).join(", ")}`)
  if (root.preserved.length) console.log(`Project settings preserved: ${root.preserved.join(", ")}`)
  if (dryRun) return

  for (const { source, target } of managed.copies) {
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(source, target)
    await chmod(target, (await stat(source)).mode)
  }
  for (const file of managed.removals) await rm(file, { force: true })
  for (const write of root.writes) await writeIfChanged(write.path, write.contents)
  await writeIfChanged(runtimePackage.path, runtimePackage.contents)
  await writeIfChanged(managed.manifestPath, `${JSON.stringify(managed.manifest, null, 2)}\n`)

  // The tools and the plugin import @opencode-ai/plugin from
  // .opencode/node_modules; without it the supervisor's tool does not load.
  if (!skipInstall) {
    const result = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: path.join(targetRoot, ".opencode"), encoding: "utf8" })
    if (result.error) throw new Error(`Cannot run npm install in .opencode: ${result.error.message}`)
    if (result.status !== 0) throw new Error(`npm install in .opencode failed:\n${result.stderr || result.stdout}`)
    console.log("Runtime dependencies: installed in .opencode/node_modules")
  } else {
    console.log("Runtime dependencies: skipped (--skip-install); run npm install inside .opencode before starting OpenCode")
  }

  if (!skipValidation) {
    const result = spawnSync("opencode", ["debug", "config"], { cwd: targetRoot, encoding: "utf8" })
    if (result.error) throw new Error(`Cannot run opencode debug config: ${result.error.message}`)
    if (result.status !== 0) throw new Error(`opencode debug config failed:\n${result.stderr || result.stdout}`)
    console.log("OpenCode configuration: valid")
  }
  console.log(`Installation complete. Commit the .opencode changes (harness ${managed.manifest.harness_revision ?? "unknown"}) and restart OpenCode in the target project.`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
