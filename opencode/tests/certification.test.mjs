import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  RELEASE_ROUTE,
  checkRelease,
  recordCertification,
} from "../.opencode/codegen/lib/certification.mjs"
import { INSTALL_MANIFEST, resolveMinimumStatus, resolvePinnedConfiguration, resolveSourceVerification } from "../.opencode/codegen/lib/cli.mjs"
import { ROLES } from "../.opencode/codegen/lib/model-selection.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const registry = JSON.parse(
  await readFile(path.join(here, "..", ".opencode", "codegen", "config", "model-pools.json"), "utf8"),
)

function uncertified() {
  const copy = structuredClone(registry)
  for (const configuration of copy.configurations) delete configuration.admission?.roles
  return copy
}

const evidence = { run_id: "20260903T000000Z-1", fixture: "x", result: "PASS" }

// Release gate: the shipped registry must carry a complete qualified route.
// This test is red until every role is certified in this repository.
test("shipped registry carries a complete qualified route for every role", () => {
  const release = checkRelease(registry)
  assert.deepEqual(release.missing, [])
  assert.equal(release.ok, true)
  assert.deepEqual(Object.keys(release.roles), ROLES)
  assert.deepEqual(Object.keys(RELEASE_ROUTE).sort(), [...ROLES].sort())
})

test("release check names every uncertified role request", () => {
  const release = checkRelease(uncertified())
  assert.equal(release.ok, false)
  for (const role of ROLES) assert.ok(release.missing.some((line) => line.startsWith(`${role} has no qualified`)), role)
})

test("certification is recorded per role and the gate designer excludes the builder family", () => {
  const copy = uncertified()
  const at = "2026-09-03T00:00:00.000Z"
  recordCertification(copy, { configurationId: "builder-go-minimax-m3", role: "builder", result: "PASS", certifiedAt: at, evidence })
  let release = checkRelease(copy)
  assert.equal(release.builder_family, "minimax")
  assert.ok(release.roles.builder.every((check) => check.ok))
  assert.ok(release.missing.some((line) => line.startsWith("planner has no")))

  // Certifying the same family as gate designer does not complete the route.
  recordCertification(copy, { configurationId: "builder-go-minimax-m3", role: "gate-designer", result: "PASS", certifiedAt: at, evidence })
  release = checkRelease(copy)
  assert.ok(release.missing.some((line) => line.includes("gate-designer has no qualified configuration") && line.includes("excluding family minimax")))
  recordCertification(copy, { configurationId: "builder-go-mimo-v2.5-pro", role: "gate-designer", result: "PASS", certifiedAt: at, evidence })
  release = checkRelease(copy)
  assert.ok(release.roles["gate-designer"].every((check) => check.ok && check.selected[0] === "builder-go-mimo-v2.5-pro"))

  // Advisors need two families, and the reconciler a third.
  recordCertification(copy, { configurationId: "builder-go-gpt-5.6-luna", role: "advisor", result: "PASS", certifiedAt: at, evidence })
  assert.ok(checkRelease(copy).missing.some((line) => line.includes("2 distinct families")))
  recordCertification(copy, { configurationId: "builder-go-deepseek-v4-pro", role: "advisor", result: "PASS", certifiedAt: at, evidence })
  recordCertification(copy, { configurationId: "builder-go-gpt-5.6-luna", role: "reconciler", result: "PASS", certifiedAt: at, evidence })
  assert.ok(checkRelease(copy).missing.some((line) => line.startsWith("reconciler has no")))
  recordCertification(copy, { configurationId: "builder-go-minimax-m3", role: "reconciler", result: "PASS", certifiedAt: at, evidence })
  assert.ok(checkRelease(copy).roles.reconciler[0].ok)

  // A failed certification demotes a qualified role entry and keeps the failure.
  const demoted = recordCertification(copy, { configurationId: "builder-go-minimax-m3", role: "builder", result: "FAIL", certifiedAt: at, evidence: { ...evidence, result: "FAIL" } })
  assert.equal(demoted.status, "candidate")
  assert.equal(demoted.last_failure.result, "FAIL")
  assert.ok(checkRelease(copy).missing.some((line) => line.startsWith("builder has no")))
})

test("admission below qualified is refused in an installed project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegen-installed-"))
  try {
    assert.equal(await resolveMinimumStatus({}, root), "qualified")
    assert.equal(await resolveMinimumStatus({ "minimum-status": "candidate" }, root), "candidate")
    await mkdir(path.join(root, ".opencode"), { recursive: true })
    await writeFile(path.join(root, INSTALL_MANIFEST), "{}")
    assert.equal(await resolveMinimumStatus({}, root), "qualified")
    await assert.rejects(resolveMinimumStatus({ "minimum-status": "candidate" }, root), /MAINTENANCE_ONLY/)
    await assert.rejects(resolvePinnedConfiguration({ configuration: "builder-go-minimax-m3" }, root), /MAINTENANCE_ONLY/)
    await assert.rejects(resolveMinimumStatus({ "minimum-status": "production" }, root), /must be one of/)
    // Research citations are always fetched and checked in an installed project.
    assert.equal(await resolveSourceVerification({}, root), "fetch")
    await assert.rejects(resolveSourceVerification({ "source-verification": "offline" }, root), /MAINTENANCE_ONLY/)
    await assert.rejects(resolveSourceVerification({ "source-verification": "trust" }, root), /must be one of/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
