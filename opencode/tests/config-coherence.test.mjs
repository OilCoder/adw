// opencode.json and model-pools.json describe the same models from two sides.
// This keeps them from drifting: every registry configuration must be
// reachable through the provider configuration OpenCode loads, automatic
// routes stay on OpenCode providers, and every enabled provider is defined.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { ROLES } from "../.opencode/codegen/lib/model-selection.mjs"

const config = JSON.parse(await readFile(new URL("../opencode.json", import.meta.url), "utf8"))
const registry = JSON.parse(await readFile(new URL("../.opencode/codegen/config/model-pools.json", import.meta.url), "utf8"))
const BUILTIN_PROVIDERS = new Set(["opencode", "opencode-go", "openai", "anthropic", "openrouter", "ollama"])

test("every registry configuration is whitelisted (or declared) by its provider in opencode.json", () => {
  for (const configuration of registry.configurations) {
    const [provider, ...rest] = configuration.opencode_model.split("/")
    const model = rest.join("/")
    assert.equal(provider, configuration.provider, `${configuration.configuration_id}: provider mismatch`)
    assert.ok(config.enabled_providers.includes(provider), `${configuration.configuration_id}: provider ${provider} is not enabled`)
    const block = config.provider?.[provider] ?? {}
    const declared = block.whitelist ?? Object.keys(block.models ?? {})
    assert.ok(declared.includes(model), `${configuration.configuration_id}: ${model} is not whitelisted for ${provider}`)
  }
})

test("automatic routes use OpenCode providers, plus the user's OpenAI subscription for the Planner and the Goal Manager; OpenRouter is manual", () => {
  for (const role of ROLES) {
    const policy = registry.runner_policies[role]
    assert.ok(policy, `runner policy for ${role}`)
    const allowed = ["planner", "goal-manager"].includes(role) ? ["openai", "opencode-go"] : ["opencode-go"]
    assert.deepEqual(policy.providers, allowed, `${role} provider tiers`)
    assert.equal(policy.configuration_ids, undefined, `${role} order is computed from price, never written by hand`)
  }
  assert.equal(registry.configurations.filter((c) => c.provider === "openrouter").length, 0)
  assert.equal(registry.configurations.filter((c) => c.provider === "opencode").length, 0, "Zen left the registry (user decision 2026-09-08)")
  assert.ok(!config.enabled_providers.includes("opencode"))
})

test("every enabled provider is a built-in provider or has a provider block", () => {
  for (const provider of config.enabled_providers) {
    assert.ok(BUILTIN_PROVIDERS.has(provider) || config.provider?.[provider], `${provider} is enabled but undefined`)
  }
  assert.ok(config.enabled_providers.includes("openai"), "openai supplies the Planner's first tier (user decision 2026-09-08)")
  assert.deepEqual(config.provider.openai.whitelist, ["gpt-5.6-sol", "gpt-5.6-terra"])
})
