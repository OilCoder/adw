import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { expectedBaseline } from "../.opencode/codegen/lib/contract.mjs"
import { checkGateReadiness, gateScript, materializeGate, parseGateOutput, sealContract } from "../.opencode/codegen/lib/gate.mjs"

const execFile = promisify(execFileCallback)

function contract(checks, requirements = [{ id: "R1", statement: "new behavior", kind: "change" }]) {
  return { contract_id: "c1", requirements, verification: { checks, invariants: [] } }
}

test("expected baseline follows from the kinds a check covers", () => {
  const c = contract(
    [
      { id: "C1", covers: ["R1"], command: "x" },
      { id: "C2", covers: ["R2"], command: "y" },
      { id: "C3", covers: ["R1", "R2"], command: "z" },
    ],
    [
      { id: "R1", statement: "adds", kind: "change" },
      { id: "R2", statement: "keeps", kind: "preserve" },
    ],
  )
  assert.deepEqual(c.verification.checks.map((check) => expectedBaseline(check, c)), ["fail", "pass", "fail"])
})

test("sealing points every check at its script and the wrapper runs them all with one verdict line each", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gate-test-"))
  try {
    const sealed = await materializeGate(directory, contract([
      { id: "C1", covers: ["R1"], command: "test -f present.txt" },
      { id: "C2", covers: ["R1"], command: "exit 3" },
    ]))
    assert.deepEqual(sealed.verification.checks.map((check) => [check.command, check.source_command]), [
      ["bash .codegen-contract/checks/C1.sh", "test -f present.txt"],
      ["bash .codegen-contract/checks/C2.sh", "exit 3"],
    ])
    assert.deepEqual(sealContract(contract([{ id: "C1", covers: ["R1"], command: "true" }])).verification.checks[0].command, "bash .codegen-contract/checks/C1.sh")
    const script = await readFile(path.join(directory, ".codegen-contract/gate.sh"), "utf8")
    assert.equal(script, gateScript(sealed.verification.checks))
    assert.ok(script.includes('run_check "C1"\nrun_check "C2"\n'))
    assert.ok((await readFile(path.join(directory, ".codegen-contract/checks/C2.sh"), "utf8")).endsWith("set -euo pipefail\nexit 3\n"))

    await writeFile(path.join(directory, "present.txt"), "")
    const failed = await execFile("bash", [".codegen-contract/gate.sh"], { cwd: directory }).catch((error) => error)
    assert.equal(failed.code, 1)
    assert.deepEqual(parseGateOutput(failed.stdout), [{ check_id: "C1", result: "PASS" }, { check_id: "C2", result: "FAIL" }])
    assert.ok(failed.stdout.includes("CONTRACT GATE: FAIL"))

    await writeFile(path.join(directory, ".codegen-contract/checks/C2.sh"), "#!/usr/bin/env bash\nexit 0\n")
    const passed = await execFile("bash", [".codegen-contract/gate.sh"], { cwd: directory })
    assert.deepEqual(parseGateOutput(passed.stdout), [{ check_id: "C1", result: "PASS" }, { check_id: "C2", result: "PASS" }])
    assert.ok(passed.stdout.includes("CONTRACT GATE: PASS"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("readiness: missing script and empty checks are fixable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gate-test-"))
  try {
    const missing = await checkGateReadiness({ directory, contract: contract([{ id: "C1", covers: ["R1"], command: "bash checks/gate.sh" }]) })
    assert.deepEqual(missing, { ready: false, fixable: true, reasons: ["missing-script:checks/gate.sh"], baseline: [] })
    const empty = await checkGateReadiness({ directory, contract: contract([]) })
    assert.equal(empty.ready, false)
    assert.deepEqual(empty.reasons, ["no-verification-checks"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("readiness judges every check against the requirements it covers and names the check", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gate-test-"))
  try {
    await mkdir(path.join(directory, "checks"))
    await writeFile(path.join(directory, "checks/pass.sh"), "exit 0\n")
    await writeFile(path.join(directory, "checks/fail.sh"), "exit 3\n")
    const requirements = [
      { id: "R1", statement: "adds", kind: "change" },
      { id: "R2", statement: "keeps", kind: "preserve" },
    ]

    // A change requirement covered by a check that already passes proves nothing: fixable.
    const trivial = await checkGateReadiness({ directory, contract: contract([{ id: "C1", covers: ["R1"], command: "bash checks/pass.sh" }], requirements) })
    assert.equal(trivial.ready, false)
    assert.equal(trivial.fixable, true)
    assert.deepEqual(trivial.reasons, ["check-passes-on-baseline:C1"])
    assert.deepEqual(trivial.baseline, [{ check_id: "C1", command: "bash checks/pass.sh", covers: ["R1"], expected: "fail", exit_code: 0 }])

    // Only the misbehaving check is named; the good one passes silently.
    const mixed = await checkGateReadiness({
      directory,
      contract: contract([
        { id: "C1", covers: ["R1"], command: "bash checks/fail.sh" },
        { id: "C2", covers: ["R1"], command: "bash checks/pass.sh" },
        { id: "C3", covers: ["R2"], command: "bash checks/pass.sh" },
      ], requirements),
    })
    assert.equal(mixed.ready, false)
    assert.deepEqual(mixed.reasons, ["check-passes-on-baseline:C2"])
    assert.equal(mixed.fixable, true)

    const ready = await checkGateReadiness({
      directory,
      contract: contract([
        { id: "C1", covers: ["R1"], command: "bash checks/fail.sh" },
        { id: "C3", covers: ["R2"], command: "bash checks/pass.sh" },
      ], requirements),
    })
    assert.equal(ready.ready, true)
    assert.deepEqual(ready.baseline.map((item) => [item.check_id, item.expected, item.exit_code]), [["C1", "fail", 3], ["C3", "pass", 0]])

    // A preserve check that fails on the baseline is not the designer's to fix.
    const broken = await checkGateReadiness({
      directory,
      contract: contract([
        { id: "C1", covers: ["R1"], command: "bash checks/pass.sh" },
        { id: "C3", covers: ["R2"], command: "bash checks/fail.sh" },
      ], requirements),
    })
    assert.equal(broken.ready, false)
    assert.equal(broken.fixable, false)
    assert.deepEqual(broken.reasons, ["check-passes-on-baseline:C1", "check-fails-on-baseline:C3"])

    // A pure refactor: every check must pass on the baseline.
    const refactor = await checkGateReadiness({ directory, contract: contract([{ id: "C3", covers: ["R2"], command: "bash checks/pass.sh" }], requirements) })
    assert.equal(refactor.ready, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
