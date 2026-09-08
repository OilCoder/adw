#!/usr/bin/env node
// Admission by public benchmarks, maintenance only:
//   check   report what the rule admits and whether the registry matches
//   apply   rewrite the registry's catalog configurations and routes from the rule
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { admissionDrift, applyAdmission } from "../lib/admission.mjs"
import { validateRegistry } from "../lib/model-selection.mjs"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const configDirectory = path.resolve(scriptDirectory, "../config")
export const EVIDENCE_FILE = path.join(configDirectory, "benchmark-evidence.json")
export const REGISTRY_FILE = path.join(configDirectory, "model-pools.json")

async function main() {
  const command = process.argv[2]
  if (!["check", "apply"].includes(command)) {
    process.stderr.write("usage: admit.mjs <check|apply>\n")
    process.exitCode = 2
    return
  }
  const registry = JSON.parse(await readFile(REGISTRY_FILE, "utf8"))
  const evidence = JSON.parse(await readFile(EVIDENCE_FILE, "utf8"))
  const result = applyAdmission(registry, evidence)
  const drift = admissionDrift(registry, evidence)
  const report = {
    evidence_as_of: evidence.generated_at,
    admitted: result.assessments.filter((a) => a.admitted).map((a) => ({ model: a.model, status: a.status, max_risk: a.max_risk, work_classes: a.work_classes })),
    candidates: result.candidates,
    routes: result.registry.routes,
    drift,
  }
  if (command === "apply") {
    const next = { ...result.registry, generated_at: new Date().toISOString() }
    validateRegistry(next)
    await writeFile(REGISTRY_FILE, `${JSON.stringify(next, null, 2)}\n`)
    report.written = path.relative(process.cwd(), REGISTRY_FILE)
    report.drift = []
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.drift.length === 0 ? 0 : 1
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 2
  })
}
