#!/usr/bin/env node
// release-check.mjs [check|status]
//   check   every production request resolves to an admitted configuration
//   status  the ordered list per role and request, with this project's metalog applied
import path from "node:path"
import { fileURLToPath } from "node:url"

import { loadRegistry } from "../lib/cli.mjs"
import { loadMetalogSummary } from "../lib/metalog.mjs"
import { checkRelease } from "../lib/release.mjs"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const systemRoot = path.resolve(scriptDirectory, "../../..")

async function main() {
  const command = process.argv[2] ?? "check"
  const registry = await loadRegistry(systemRoot)
  if (command === "check") {
    const release = checkRelease(registry)
    process.stdout.write(`${JSON.stringify(release, null, 2)}\n`)
    process.exitCode = release.ok ? 0 : 1
    return
  }
  if (command === "status") {
    const metalog = await loadMetalogSummary(systemRoot)
    const release = checkRelease(registry, { metalog })
    const rows = []
    for (const [role, checks] of Object.entries(release.roles)) {
      for (const check of checks) {
        rows.push({ role, work_class: check.work_class, risk: check.risk, ok: check.ok, ladder: check.ladder.map((id) => { const item = metalog.configurations[id]; return { configuration_id: id, fit: item?.fit ?? null, consecutive_failures: item?.roles?.[role]?.consecutive_failures ?? 0 } }) })
      }
    }
    process.stdout.write(`${JSON.stringify({ ok: release.ok, missing: release.missing, rows }, null, 2)}\n`)
    process.exitCode = release.ok ? 0 : 1
    return
  }
  throw new Error("usage: release-check.mjs [check|status]")
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 2
})
