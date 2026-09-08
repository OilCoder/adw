import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { materializeGate } from "../.opencode/codegen/lib/gate.mjs"

const execFile = promisify(execFileCallback)
const here = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(here, "..")

// Fake gate designer: rewrites the check script of C1 so it fails until alpha
// is implemented, with a helper test next to it. FAKE_SCOPE_LEAK makes it
// also touch product code; FAKE_CONTRACT_LEAK makes it rewrite the sealed
// contract. The runner must reject both.
const fakeOpenCode = `#!/usr/bin/env node
const fs = require("node:fs")
fs.writeFileSync(".codegen-contract/checks/test_alpha_contract.py", "import unittest\\nfrom lib.alpha import alpha\\nclass T(unittest.TestCase):\\n    def test(self):\\n        self.assertEqual(alpha(2), 4)\\n")
fs.writeFileSync(".codegen-contract/checks/C1.sh", "#!/usr/bin/env bash\\nset -euo pipefail\\npython3 -m unittest .codegen-contract/checks/test_alpha_contract.py\\n")
if (process.env.FAKE_SCOPE_LEAK) fs.writeFileSync("lib/alpha.py", "def alpha(value):\\n    return value * 2\\n")
if (process.env.FAKE_CONTRACT_LEAK) {
  const contract = JSON.parse(fs.readFileSync(".codegen-contract/contract.json", "utf8"))
  contract.requirements[0].kind = "preserve"
  fs.writeFileSync(".codegen-contract/contract.json", JSON.stringify(contract, null, 2) + "\\n")
}
console.log(JSON.stringify({type:"step_finish",part:{cost:0.001,tokens:{input:5,output:5,reasoning:0,cache:{read:0,write:0}}}}))
`

async function project() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gate-designer-test-"))
  const bin = path.join(directory, "bin-fake")
  await mkdir(bin)
  await writeFile(path.join(bin, "opencode"), fakeOpenCode, { mode: 0o755 })
  await cp(path.join(here, "fixtures/orchestrator-basic/lib"), path.join(directory, "lib"), { recursive: true })
  await mkdir(path.join(directory, ".codegen-contract"))
  // Sealed exactly as the orchestrator seals it: a check that passes on the
  // baseline judges nothing.
  const sealed = await materializeGate(directory, {
    contract_id: "alpha",
    objective: "Implement alpha",
    allowed_to_modify: ["lib/alpha.py"],
    requirements: [{ id: "R1", statement: "alpha doubles its input", kind: "change", verification: "automated" }],
    verification: { checks: [{ id: "C1", covers: ["R1"], command: "true" }], invariants: [] },
  })
  await writeFile(path.join(directory, ".codegen-contract/contract.json"), `${JSON.stringify(sealed, null, 2)}\n`)
  await writeFile(path.join(directory, ".gitignore"), "bin-fake/\n__pycache__/\n")
  const git = (...args) => execFile("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { cwd: directory })
  await git("init", "-q", "-b", "main")
  await git("add", ".")
  await git("commit", "-q", "-m", "baseline")
  return { directory, bin }
}

function run(tree, env = {}) {
  return execFile(
    process.execPath,
    [path.join(systemRoot, ".opencode/codegen/scripts/run-gate-designer.mjs"), "--contract", ".codegen-contract/contract.json", "--work-class", "localized-low-risk-code-change", "--minimum-status", "candidate", "--exclude-family", "qwen"],
    { cwd: tree.directory, env: { ...process.env, PATH: `${tree.bin}${path.delimiter}${process.env.PATH}`, PYTHONDONTWRITEBYTECODE: "1", ...env } },
  ).then(
    (result) => ({ code: 0, ...result }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  )
}

test("gate designer turns a trivial check into one that fails on the baseline", async () => {
  const tree = await project()
  try {
    const result = await run(tree)
    assert.equal(result.code, 0, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.result, "GATE_READY")
    assert.deepEqual(summary.readiness_before.reasons, ["check-passes-on-baseline:C1"])
    assert.equal(summary.readiness_after.ready, true)
    assert.deepEqual(summary.readiness_after.baseline.map((item) => [item.check_id, item.expected, item.exit_code !== 0]), [["C1", "fail", true]])
    assert.deepEqual(summary.changed_files, [".codegen-contract/checks/C1.sh", ".codegen-contract/checks/test_alpha_contract.py"])
    assert.equal(summary.attempts[0].configuration.family, "minimax")
    assert.ok((await readFile(path.join(tree.directory, "lib/alpha.py"), "utf8")).includes("NotImplementedError"))
    // The wrapper is untouched and reports the check by id.
    const gate = await execFile("bash", [".codegen-contract/gate.sh"], { cwd: tree.directory }).catch((error) => error)
    assert.equal(gate.code, 1)
    assert.ok(gate.stdout.includes("CHECK C1: FAIL"))
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("gate designer that touches product code is rejected", async () => {
  const tree = await project()
  try {
    const result = await run(tree, { FAKE_SCOPE_LEAK: "1" })
    assert.equal(result.code, 1)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.result, "SCOPE_FAIL")
    assert.deepEqual(summary.outside_scope, ["lib/alpha.py"])
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})

test("gate designer that rewrites the sealed contract is rejected and readiness still judges the sealed contract", async () => {
  const tree = await project()
  try {
    const result = await run(tree, { FAKE_CONTRACT_LEAK: "1" })
    assert.equal(result.code, 1)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.result, "SCOPE_FAIL")
    assert.deepEqual(summary.outside_scope, [".codegen-contract/contract.json"])
    assert.equal(summary.readiness_after, null)
  } finally {
    await rm(tree.directory, { recursive: true, force: true })
  }
})
