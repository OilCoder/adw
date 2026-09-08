import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { loadRegistry } from "../.opencode/codegen/lib/cli.mjs"
import { PROBE_FILE, fitPrompt, runFitCheck } from "../.opencode/codegen/lib/fit-check.mjs"
import { readMetalog, summarizeMetalog } from "../.opencode/codegen/lib/metalog.mjs"
import { selectConfiguration } from "../.opencode/codegen/lib/select-configuration.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(here, "..")

// Fake `opencode` for the probe: FAKE_FIT decides what the model does with
// the prompt. It records the model, the agent, and the opencode.json of the
// directory it ran in.
const fakeOpenCode = `#!/usr/bin/env node
const fs = require("node:fs")
const argv = process.argv
const model = argv[argv.indexOf("--model") + 1]
const agent = argv[argv.indexOf("--agent") + 1]
const prompt = argv[argv.length - 1]
const config = fs.existsSync("opencode.json") ? JSON.parse(fs.readFileSync("opencode.json", "utf8")) : null
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ model, agent, prompt, cwd: process.cwd(), enabled_providers: config?.enabled_providers ?? null }) + "\\n")
const mode = process.env.FAKE_FIT_MODEL && process.env.FAKE_FIT_MODEL !== model ? "pass" : (process.env.FAKE_FIT || "pass")
if (mode === "pass") fs.writeFileSync("${PROBE_FILE}", JSON.stringify({ fit: "ok", model }))
if (mode === "wrong") fs.writeFileSync("${PROBE_FILE}", JSON.stringify({ fit: "ok", model: "someone-else" }))
if (mode === "garbage") fs.writeFileSync("${PROBE_FILE}", "not json")
if (mode === "rate-limit") { console.log(JSON.stringify({type:"error",error:{name:"APIError",data:{statusCode:429,message:"Too many requests",isRetryable:true}}})); process.exit(1) }
if (mode === "auth") { console.log(JSON.stringify({type:"error",error:{name:"APIError",data:{statusCode:401,message:"Unauthorized",isRetryable:false}}})); process.exit(1) }
console.log(JSON.stringify({type:"step_finish",part:{cost:0.002,tokens:{input:7,output:3,reasoning:0,cache:{read:0,write:0}}}}))
`

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegen-fit-test-"))
  const bin = path.join(root, "bin")
  await mkdir(bin)
  await writeFile(path.join(bin, "opencode"), fakeOpenCode, { mode: 0o755 })
  await writeFile(path.join(root, "opencode.json"), `${JSON.stringify({ enabled_providers: ["opencode-go", "openai"], provider: { openai: { whitelist: ["gpt-5.6-sol"] } } })}\n`)
  const env = { PATH: process.env.PATH, CODEGEN_METALOG: process.env.CODEGEN_METALOG, CODEGEN_FIT_CHECK: process.env.CODEGEN_FIT_CHECK, FAKE_LOG: process.env.FAKE_LOG, FAKE_FIT: process.env.FAKE_FIT, FAKE_FIT_MODEL: process.env.FAKE_FIT_MODEL }
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
  process.env.CODEGEN_METALOG = path.join(root, "metalog.jsonl")
  process.env.CODEGEN_FIT_CHECK = "run"
  process.env.FAKE_LOG = path.join(root, "fake.log")
  delete process.env.FAKE_FIT
  delete process.env.FAKE_FIT_MODEL
  const restore = async () => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
  const log = async () => (await readFile(path.join(root, "fake.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  return { root, restore, log }
}

const registry = await loadRegistry(systemRoot)
const configuration = registry.configurations.find((item) => item.configuration_id === "builder-go-qwen3.8-flash")

test("the fit check runs one call in a temporary directory that carries the project's providers, and passes on an exact probe", async () => {
  const { root, restore, log } = await harness()
  try {
    const fit = await runFitCheck({ systemRoot: root, configuration, timeoutSeconds: 30 })
    assert.equal(fit.outcome, "pass")
    assert.equal(fit.result, "PASS")
    assert.equal(fit.entry.kind, "fit")
    assert.equal(fit.entry.configuration_id, "builder-go-qwen3.8-flash")
    assert.equal(fit.entry.tokens.input, 7)
    const [call] = await log()
    assert.equal(call.model, "opencode-go/qwen3.8-flash")
    assert.equal(call.prompt, fitPrompt("opencode-go/qwen3.8-flash"))
    assert.deepEqual(call.enabled_providers, ["opencode-go", "openai"], "the probe directory carries the project's provider settings")
    assert.ok(!call.cwd.startsWith(root), "the probe never runs inside the project")
  } finally {
    await restore()
  }
})

test("a wrong probe, garbage, or no file fails the fit; a provider limit or a missing login leaves it unknown", async () => {
  const { root, restore } = await harness()
  try {
    const cases = [
      ["wrong", "fail", "FIT_MISMATCH"],
      ["garbage", "fail", "FIT_MISMATCH"],
      ["none", "fail", "FIT_NO_FILE"],
      ["rate-limit", "unknown", "PROVIDER_RATE_LIMIT"],
      ["auth", "unknown", "AUTH_ERROR"],
    ]
    for (const [mode, outcome, result] of cases) {
      process.env.FAKE_FIT = mode
      const fit = await runFitCheck({ systemRoot: root, configuration, timeoutSeconds: 30 })
      assert.equal(fit.outcome, outcome, mode)
      assert.equal(fit.result, result, mode)
    }
  } finally {
    await restore()
  }
})

test("selectConfiguration checks fit once per configuration and project, records it, and steps past a failed fit", async () => {
  const { root, restore, log } = await harness()
  try {
    const request = { workClass: "localized-low-risk-code-change", risk: "low", requiresTools: true, requiresCodeEditing: true }
    const first = await selectConfiguration({ systemRoot: root, registry, role: "builder", request, timeoutSeconds: 30 })
    assert.equal(first.status, "READY")
    assert.equal(first.primary.configuration_id, "builder-go-glm-5.3-flash")
    assert.deepEqual(first.fits.map((item) => [item.configuration_id, item.outcome]), [["builder-go-glm-5.3-flash", "pass"]])
    const second = await selectConfiguration({ systemRoot: root, registry, role: "builder", request, timeoutSeconds: 30 })
    assert.deepEqual(second.fits, [], "a passed fit is not repeated")
    assert.equal((await log()).length, 1)

    // The next rung has no verdict yet and does not fit: the selector records it and steps past it.
    const secondRung = registry.configurations.find((item) => item.configuration_id === first.ladder[1])
    process.env.FAKE_FIT = "none"
    process.env.FAKE_FIT_MODEL = secondRung.opencode_model
    const third = await selectConfiguration({ systemRoot: root, registry, role: "builder", request: { ...request, excludeConfigurations: ["builder-go-glm-5.3-flash"] }, timeoutSeconds: 30 })
    assert.equal(third.status, "READY")
    assert.equal(third.primary.configuration_id, first.ladder[2], "one failed fit later, the third rung is first")
    assert.deepEqual(third.fits.map((item) => [item.configuration_id, item.outcome]), [[first.ladder[1], "fail"], [first.ladder[2], "pass"]])
    const summary = summarizeMetalog(await readMetalog(root))
    assert.equal(summary.configurations[first.ladder[1]].fit, "fail")
    assert.equal(summary.configurations["builder-go-glm-5.3-flash"].fit, "pass")

    // A provider limit leaves the verdict unknown: skipped now, tried again next time.
    const fourthRung = registry.configurations.find((item) => item.configuration_id === first.ladder[3])
    process.env.FAKE_FIT = "rate-limit"
    process.env.FAKE_FIT_MODEL = fourthRung.opencode_model
    const fourth = await selectConfiguration({ systemRoot: root, registry, role: "builder", request: { ...request, excludeConfigurations: first.ladder.slice(0, 3) }, timeoutSeconds: 30 })
    assert.equal(fourth.status, "READY")
    assert.equal(fourth.primary.configuration_id, first.ladder[4])
    assert.deepEqual(fourth.fits.map((item) => [item.configuration_id, item.outcome]), [[first.ladder[3], "unknown"], [first.ladder[4], "pass"]])
    assert.equal(summarizeMetalog(await readMetalog(root)).configurations[first.ladder[3]]?.fit ?? null, null, "an unknown verdict is not remembered as a failure")
  } finally {
    await restore()
  }
})

test("with the fit check off (maintenance) nothing is probed", async () => {
  const { root, restore } = await harness()
  try {
    process.env.CODEGEN_FIT_CHECK = "off"
    const plan = await selectConfiguration({ systemRoot: root, registry, role: "builder", request: { workClass: "localized-low-risk-code-change", risk: "low", requiresTools: true, requiresCodeEditing: true } })
    assert.equal(plan.status, "READY")
    assert.deepEqual(plan.fits, [])
    assert.deepEqual(await readMetalog(root), [])
  } finally {
    await restore()
  }
})
