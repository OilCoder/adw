import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const execFile = promisify(execFileCallback)
const here = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(here, "..")

test("CLI stops after one Go call and requests a Zen recharge", async () => {
  const worktree = await mkdtemp(path.join(os.tmpdir(), "builder-runner-test-"))
  const bin = path.join(worktree, "bin")
  try {
    await cp(path.join(here, "fixtures/builder-basic"), worktree, { recursive: true })
    await mkdir(path.join(worktree, ".opencode"), { recursive: true })
    await cp(path.join(systemRoot, ".opencode/agents"), path.join(worktree, ".opencode/agents"), {
      recursive: true,
    })
    await cp(
      path.join(systemRoot, ".opencode/instructions"),
      path.join(worktree, ".opencode/instructions"),
      { recursive: true },
    )
    await cp(path.join(systemRoot, "opencode.json"), path.join(worktree, "opencode.json"))
    await mkdir(bin)
    const fakeOpenCode = path.join(bin, "opencode")
    await writeFile(
      fakeOpenCode,
      `#!/usr/bin/env node
const fs = require("node:fs")
const model = process.argv[process.argv.indexOf("--model") + 1]
if (process.env.PWD !== process.cwd()) {
  console.error("PWD does not match cwd")
  process.exit(70)
}
console.log(JSON.stringify({type:"error",error:{name:"APIError",data:{statusCode:402,message:"Insufficient credit balance. Add credits to continue.",isRetryable:false}}}))
process.exit(1)
`,
      { mode: 0o755 },
    )

    await execFile("git", ["init", "-q"], { cwd: worktree })
    await execFile("git", ["config", "user.name", "Builder Runner Test"], { cwd: worktree })
    await execFile("git", ["config", "user.email", "runner-test@localhost"], {
      cwd: worktree,
    })
    await execFile("git", ["add", "."], { cwd: worktree })
    await execFile("git", ["commit", "-q", "-m", "test: seal fixture"], { cwd: worktree })

    let failure
    try {
      await execFile(
        process.execPath,
        [
          path.join(systemRoot, ".opencode/codegen/scripts/run-builder.mjs"),
          "--directory",
          worktree,
          "--contract",
          ".codegen-contract/contract.json",
          "--work-class",
          "localized-low-risk-code-change",
        ],
        { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEGEN_METALOG: path.join(worktree, "metalog.jsonl") } },
      )
    } catch (error) {
      failure = error
    }
    assert.equal(failure?.code, 1)
    const report = JSON.parse(failure.stdout)

    assert.equal(report.result, "ZEN_BALANCE_EXHAUSTED")
    assert.match(report.user_action, /Recharge the Zen balance/)
    assert.deepEqual(report.attempts.map((attempt) => attempt.configuration.provider), ["opencode-go"])
  } finally {
    await rm(worktree, { recursive: true, force: true })
  }
})
