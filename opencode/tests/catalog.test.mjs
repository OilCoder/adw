import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { applyCatalog, diffCatalog } from "../.opencode/codegen/scripts/catalog.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const registry = JSON.parse(await readFile(path.join(here, "..", ".opencode", "codegen", "config", "model-pools.json"), "utf8"))

function catalogFrom(registryCopy, overrides = {}) {
  const catalog = { "opencode-go": { models: {} }, opencode: { models: {} }, openai: { models: {} } }
  for (const configuration of registryCopy.configurations) {
    if (!catalog[configuration.provider]) continue
    const id = configuration.opencode_model.slice(configuration.provider.length + 1)
    const economics = configuration.economics
    catalog[configuration.provider].models[id] = {
      name: id,
      cost: { input: economics.input_per_million ?? economics.input_per_million_quota_value, output: economics.output_per_million ?? economics.output_per_million_quota_value, cache_read: economics.cached_input_per_million ?? economics.cached_input_per_million_quota_value },
      limit: { context: configuration.capabilities.context_tokens },
    }
  }
  for (const [provider, models] of Object.entries(overrides)) Object.assign(catalog[provider].models, models)
  return catalog
}

test("a catalog equal to the registry reports nothing but the Go models the registry does not know", () => {
  const catalog = catalogFrom(registry, { "opencode-go": { "brand-new": { name: "Brand New", cost: { input: 0.1, output: 0.2 }, limit: { context: 1000 }, release_date: "2026-09-08" } } })
  const diff = diffCatalog(registry, catalog)
  assert.deepEqual(diff.dropped, [])
  assert.deepEqual(diff.changed, [])
  assert.deepEqual(diff.unknown_go_models.map((item) => item.model), ["opencode-go/brand-new"])
})

test("price and context changes are reported and applied; a dropped model is reported and never touched; membership never changes", () => {
  const catalog = catalogFrom(registry)
  delete catalog["opencode-go"].models["minimax-m3"]
  catalog["opencode-go"].models["qwen3.8-flash"].cost.output = 0.99
  catalog["opencode-go"].models["qwen3.8-flash"].limit.context = 1000000
  const diff = diffCatalog(registry, catalog)
  assert.deepEqual(diff.dropped.map((item) => item.configuration_id), ["builder-go-minimax-m3"])
  assert.deepEqual(diff.changed.map((item) => item.configuration_id), ["builder-go-qwen3.8-flash"], JSON.stringify(diff.changed))
  assert.deepEqual(diff.changed[0].differences, [{ field: "output", from: 0.47, to: 0.99 }, { field: "context_tokens", from: 131072, to: 1000000 }])

  const copy = structuredClone(registry)
  const routesBefore = JSON.stringify(copy.routes)
  const applied = applyCatalog(copy, catalog)
  assert.deepEqual(applied.map((item) => item.configuration_id), ["builder-go-qwen3.8-flash"])
  const flash = copy.configurations.find((item) => item.configuration_id === "builder-go-qwen3.8-flash")
  assert.equal(flash.economics.output_per_million_quota_value, 0.99)
  assert.equal(flash.capabilities.context_tokens, 1000000)
  assert.equal(copy.configurations.find((item) => item.configuration_id === "builder-go-minimax-m3").economics.output_per_million_quota_value, 1.2)
  assert.equal(JSON.stringify(copy.routes), routesBefore)
  assert.deepEqual(diffCatalog(copy, catalog).changed, [])
})
