import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { appendMetalog, callEntry, metalogPath, outcomeOf, readMetalog, stopEntry, summarizeMetalog } from "../.opencode/codegen/lib/metalog.mjs"

const selection = { configuration_id: "builder-go-qwen3.8-flash", model: "opencode-go/qwen3.8-flash", provider: "opencode-go", rank: 1, ladder: ["builder-go-qwen3.8-flash", "builder-go-glm-5.3-flash"] }

test("only failures attributable to the model count; provider, account, and harness failures are neutral", () => {
  assert.equal(outcomeOf("PASS", { success: true }), "success")
  assert.equal(outcomeOf("GATE_FAIL", { success: false }), "failure")
  assert.equal(outcomeOf("PLAN_INVALID", { success: false }), "failure")
  for (const neutral of ["AUTH_ERROR", "PROVIDER_RATE_LIMIT", "PROVIDER_UNAVAILABLE", "ZEN_BALANCE_EXHAUSTED", "GO_USAGE_LIMIT", "LOCAL_RUNNER_ERROR", "CONTRACT_BLOCKED", "NO_BUILDER_ADMITTED"]) {
    assert.equal(outcomeOf(neutral, { success: false }), "neutral", neutral)
  }
})

test("call and stop entries carry the rung and the ladder the selector used", () => {
  const call = callEntry({ role: "builder", selection, result: "GATE_FAIL", success: false, runId: "r1", execution: { attempts: [{ metrics: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 1, reported_cost: 0.01 } }] }, reason: "failing checks: C1", context: { contract_id: "alpha" } })
  assert.equal(call.kind, "call")
  assert.equal(call.outcome, "failure")
  assert.equal(call.rank, 1)
  assert.deepEqual(call.ladder, selection.ladder)
  assert.deepEqual(call.tokens, { input: 10, output: 5, cache_read: 1 })
  assert.equal(call.cost, 0.01)
  assert.equal(call.contract_id, "alpha")
  const stop = stopEntry({ role: "builder", selection, reason: "no progress", runId: "r1" })
  assert.equal(stop.kind, "stop")
  assert.equal(stop.result, "NO_PROGRESS")
  assert.equal(stop.outcome, "failure")
})

test("the summary counts failures in a row per role, resets on success, ignores neutral results, and keeps the fit verdict", () => {
  const entry = (outcome, role = "builder", kind = "call") => ({ kind, role, configuration_id: "c1", outcome, at: "2026-09-08T00:00:00Z" })
  const summary = summarizeMetalog([
    { kind: "fit", configuration_id: "c1", outcome: "unknown", reason: "rate limit" },
    entry("failure"),
    entry("neutral"),
    entry("failure"),
    entry("success"),
    entry("failure"),
    entry("failure", "planner"),
    entry("failure", "builder", "stop"),
    { kind: "fit", configuration_id: "c2", outcome: "fail", reason: "no tool use" },
    { kind: "fit", configuration_id: "c2", outcome: "pass" },
    { kind: "noise" },
  ])
  assert.equal(summary.configurations.c1.fit, null, "an unknown fit is not a verdict")
  assert.deepEqual(summary.configurations.c1.roles.builder, { consecutive_failures: 2, calls: 5, failures: 4, last_outcome: "failure", last_at: "2026-09-08T00:00:00Z" })
  assert.equal(summary.configurations.c1.roles.planner.consecutive_failures, 1)
  assert.equal(summary.configurations.c2.fit, "pass", "the last verdict wins")
  assert.equal(summary.configurations.c2.fit_reason, null)
})

test("the metalog is an append-only JSONL file named by CODEGEN_METALOG, tolerant to a broken line", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegen-metalog-"))
  const previous = process.env.CODEGEN_METALOG
  process.env.CODEGEN_METALOG = path.join(root, "nested", "metalog.jsonl")
  try {
    assert.equal(metalogPath(root), path.join(root, "nested", "metalog.jsonl"))
    assert.deepEqual(await readMetalog(root), [])
    const written = await appendMetalog(root, { kind: "fit", configuration_id: "c1", outcome: "pass" })
    assert.ok(written.at)
    await appendMetalog(root, { kind: "call", role: "builder", configuration_id: "c1", outcome: "success" })
    const raw = await readFile(process.env.CODEGEN_METALOG, "utf8")
    assert.equal(raw.trim().split("\n").length, 2)
    const { appendFile } = await import("node:fs/promises")
    await appendFile(process.env.CODEGEN_METALOG, "{not json\n")
    const entries = await readMetalog(root)
    assert.equal(entries.length, 2)
    assert.equal(summarizeMetalog(entries).configurations.c1.fit, "pass")
  } finally {
    if (previous === undefined) delete process.env.CODEGEN_METALOG
    else process.env.CODEGEN_METALOG = previous
    await rm(root, { recursive: true, force: true })
  }
})
