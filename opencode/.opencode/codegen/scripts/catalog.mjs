#!/usr/bin/env node
// catalog.mjs diff | apply [--source <url or file>]
//   diff   compare the registry with the live OpenCode catalog (models.dev):
//          models the catalog dropped, Go models the registry does not know,
//          and price or context changes of known configurations
//   apply  copy price and context of known configurations from the catalog
//          into the registry. Membership (routes) never changes here: a new
//          model enters the routes by hand, with its public benchmark evidence.
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { loadRegistry, parseArguments } from "../lib/cli.mjs"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(scriptDirectory, "../../..")
const registryFile = path.join(systemRoot, ".opencode/codegen/config/model-pools.json")
export const CATALOG_URL = "https://models.dev/api.json"

async function loadCatalog(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`catalog ${source} answered ${response.status}`)
    return response.json()
  }
  return JSON.parse(await readFile(path.resolve(source), "utf8"))
}

function catalogEconomics(model, provider) {
  const cost = model.cost ?? {}
  const quota = provider === "opencode-go"
  const key = (name) => (quota ? `${name}_per_million_quota_value` : `${name}_per_million`)
  return {
    currency: "USD",
    [key("input")]: cost.input ?? 0,
    [key("output")]: cost.output ?? 0,
    [key("cached_input")]: cost.cache_read ?? 0,
    price_type: quota ? "opencode-go-subscription-quota" : provider === "openai" ? "openai-subscription" : "opencode-zen-snapshot",
  }
}

function economicsView(economics = {}) {
  return {
    input: economics.input_per_million ?? economics.input_per_million_quota_value ?? null,
    output: economics.output_per_million ?? economics.output_per_million_quota_value ?? null,
    cached: economics.cached_input_per_million ?? economics.cached_input_per_million_quota_value ?? null,
  }
}

// The fields the catalog governs: the three prices and the context window.
// Everything else in `economics` (price type, notes, cache write prices) is
// the registry's own and is never touched.
function fieldKey(configuration, name) {
  const quota = configuration.provider === "opencode-go"
  return quota ? `${name}_per_million_quota_value` : `${name}_per_million`
}

function differencesOf(configuration, model) {
  const current = economicsView(configuration.economics)
  const next = economicsView(catalogEconomics(model, configuration.provider))
  const differences = []
  for (const field of ["input", "output", "cached"]) {
    if (current[field] !== next[field]) differences.push({ field, from: current[field], to: next[field] })
  }
  const context = model.limit?.context ?? null
  if (context && configuration.capabilities?.context_tokens !== context) {
    differences.push({ field: "context_tokens", from: configuration.capabilities?.context_tokens ?? null, to: context })
  }
  return differences
}

function catalogModel(catalog, configuration) {
  const providerCatalog = catalog[configuration.provider]
  if (!providerCatalog) return undefined
  return providerCatalog.models?.[configuration.opencode_model.slice(configuration.provider.length + 1)] ?? null
}

export function diffCatalog(registry, catalog) {
  const providers = [...new Set(registry.configurations.map((item) => item.provider))].filter((provider) => catalog[provider])
  const dropped = []
  const changed = []
  for (const configuration of registry.configurations) {
    const model = catalogModel(catalog, configuration)
    if (model === undefined) continue
    if (model === null) {
      dropped.push({ configuration_id: configuration.configuration_id, model: configuration.opencode_model })
      continue
    }
    const differences = differencesOf(configuration, model)
    if (differences.length > 0) changed.push({ configuration_id: configuration.configuration_id, model: configuration.opencode_model, differences })
  }
  // New models are reported for OpenCode Go only: that is the catalog the
  // routes are built from. Zen lists a hundred models, most never routed.
  const known = new Set(registry.configurations.map((item) => item.opencode_model))
  const unknown = Object.entries(catalog["opencode-go"]?.models ?? {})
    .filter(([id]) => !known.has(`opencode-go/${id}`))
    .map(([id, model]) => ({ model: `opencode-go/${id}`, name: model.name, context: model.limit?.context ?? null, input: model.cost?.input ?? null, output: model.cost?.output ?? null, release_date: model.release_date ?? null }))
    .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""))
  return { providers, dropped, changed, unknown_go_models: unknown }
}

export function applyCatalog(registry, catalog) {
  const applied = []
  const keys = { input: "input", output: "output", cached: "cached_input" }
  for (const configuration of registry.configurations) {
    const model = catalogModel(catalog, configuration)
    if (!model) continue
    const differences = differencesOf(configuration, model)
    if (differences.length === 0) continue
    configuration.economics ??= { currency: "USD" }
    for (const difference of differences) {
      if (difference.field === "context_tokens") {
        configuration.capabilities ??= {}
        configuration.capabilities.context_tokens = difference.to
      } else {
        configuration.economics[fieldKey(configuration, keys[difference.field])] = difference.to
      }
    }
    applied.push({ configuration_id: configuration.configuration_id, model: configuration.opencode_model, differences })
  }
  return applied
}

async function main() {
  const command = process.argv[2]
  const args = parseArguments(process.argv.slice(3))
  if (!["diff", "apply"].includes(command)) throw new Error("usage: catalog.mjs diff | apply [--source <url or file>]")
  const registry = await loadRegistry(systemRoot)
  const catalog = await loadCatalog(args.source ?? CATALOG_URL)
  if (command === "diff") {
    process.stdout.write(`${JSON.stringify(diffCatalog(registry, catalog), null, 2)}\n`)
    return
  }
  const applied = applyCatalog(registry, catalog)
  registry.generated_at = new Date().toISOString()
  await writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ applied, remaining: diffCatalog(registry, catalog) }, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 2
  })
}
