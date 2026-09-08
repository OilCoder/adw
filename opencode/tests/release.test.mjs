import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { INSTALL_MANIFEST, resolvePinnedConfiguration, resolveSourceVerification } from "../.opencode/codegen/lib/cli.mjs"
import { resolveFitCheck } from "../.opencode/codegen/lib/fit-check.mjs"
import { summarizeMetalog } from "../.opencode/codegen/lib/metalog.mjs"
import { ROLES } from "../.opencode/codegen/lib/model-selection.mjs"
import { RELEASE_ROUTE, admittedForRole, builderFamily, checkRelease, independentFamilies } from "../.opencode/codegen/lib/release.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const registry = JSON.parse(
  await readFile(path.join(here, "..", ".opencode", "codegen", "config", "model-pools.json"), "utf8"),
)

// Release gate: every request production issues resolves to an admitted
// configuration. This is what the installer checks before copying anything.
test("shipped registry resolves every production request", () => {
  const release = checkRelease(registry)
  assert.deepEqual(release.missing, [])
  assert.equal(release.ok, true)
  assert.deepEqual(Object.keys(release.roles), ROLES)
  assert.deepEqual(Object.keys(RELEASE_ROUTE).sort(), [...ROLES].sort())
  assert.equal(release.builder_family, "glm", "the cheapest admitted builder is first in line")
  for (const check of release.roles["gate-designer"]) {
    assert.equal(check.exclude_family, "glm")
    assert.ok(check.ladder.length > 0)
  }
  const advisors = release.roles.advisor[0]
  assert.equal(advisors.required_families, 2)
  assert.equal(new Set(advisors.selected.map((id) => registry.configurations.find((c) => c.configuration_id === id).family)).size, 2)
  const reconciler = release.roles.reconciler[0].selected[0]
  const reconcilerFamily = registry.configurations.find((c) => c.configuration_id === reconciler).family
  assert.ok(!advisors.selected.map((id) => registry.configurations.find((c) => c.configuration_id === id).family).includes(reconcilerFamily))
})

test("the release check names every request nothing is admitted for", () => {
  const copy = structuredClone(registry)
  for (const role of ROLES) copy.runner_policies[role] = { providers: ["ollama"] }
  const release = checkRelease(copy)
  assert.equal(release.ok, false)
  for (const role of ROLES) assert.ok(release.missing.some((line) => line.startsWith(`${role} has no admitted configuration`)), role)
})

test("the metalog of a project changes who is first in line, never who is admitted", () => {
  const ladder = admittedForRole(registry, "builder", RELEASE_ROUTE.builder[0]).eligible.map((c) => c.configuration_id)
  const failure = (id) => ({ kind: "call", role: "builder", configuration_id: id, outcome: "failure" })
  const metalog = summarizeMetalog([failure(ladder[0]), failure(ladder[0])])
  const demoted = admittedForRole(registry, "builder", RELEASE_ROUTE.builder[0], { metalog }).eligible.map((c) => c.configuration_id)
  assert.deepEqual(new Set(demoted), new Set(ladder))
  assert.equal(demoted.at(-1), ladder[0])
  assert.notEqual(builderFamily(registry, { metalog }), builderFamily(registry))
  assert.equal(checkRelease(registry, { metalog }).ok, true)
  assert.deepEqual(independentFamilies(admittedForRole(registry, "advisor", RELEASE_ROUTE.advisor[0]).eligible).map((c) => c.family).slice(0, 3), ["glm", "qwen", "grok"])
})

test("maintenance flags are refused in an installed project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegen-installed-"))
  const previousFit = process.env.CODEGEN_FIT_CHECK
  delete process.env.CODEGEN_FIT_CHECK
  try {
    assert.equal(await resolveFitCheck({ "fit-check": "off" }, root), "off")
    assert.equal(await resolvePinnedConfiguration({ configuration: "builder-go-minimax-m3" }, root), "builder-go-minimax-m3")
    await mkdir(path.join(root, ".opencode"), { recursive: true })
    await writeFile(path.join(root, INSTALL_MANIFEST), "{}")
    assert.equal(await resolveFitCheck({}, root), "run")
    await assert.rejects(resolveFitCheck({ "fit-check": "off" }, root), /MAINTENANCE_ONLY/)
    await assert.rejects(resolveFitCheck({ "fit-check": "skip" }, root), /must be one of/)
    await assert.rejects(resolvePinnedConfiguration({ configuration: "builder-go-minimax-m3" }, root), /MAINTENANCE_ONLY/)
    // Research citations are always fetched and checked in an installed project.
    assert.equal(await resolveSourceVerification({}, root), "fetch")
    await assert.rejects(resolveSourceVerification({ "source-verification": "offline" }, root), /MAINTENANCE_ONLY/)
    await assert.rejects(resolveSourceVerification({ "source-verification": "trust" }, root), /must be one of/)
    process.env.CODEGEN_FIT_CHECK = "off"
    await assert.rejects(resolveFitCheck({}, root), /MAINTENANCE_ONLY/, "the environment cannot skip the fit check either")
  } finally {
    if (previousFit === undefined) delete process.env.CODEGEN_FIT_CHECK
    else process.env.CODEGEN_FIT_CHECK = previousFit
    await rm(root, { recursive: true, force: true })
  }
})
