#!/usr/bin/env node
// Freezes the board's HTML and JSON for a fixed state (tests/fixtures/board-state,
// a real las-viewer-v5 run edited to show every status) with a fixed clock and
// fixed database facts. The HTML must match byte for byte: a redesign changes it
// on purpose and then regenerates with --update.
//   node tests/golden-board.mjs [--update]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

const HERE = path.dirname(new URL(import.meta.url).pathname)
const SRC = path.dirname(HERE)
const update = process.argv.includes("--update")
const { renderBoard, boardJson } = await import(path.join(SRC, ".opencode", "board.mjs"))

const root = "/home/user/las-viewer-v5"
const F = path.join(HERE, "fixtures", "board-state", ".codegen")
const json = (f) => JSON.parse(readFileSync(path.join(F, f), "utf8"))
const events = readFileSync(path.join(F, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const models = JSON.parse(readFileSync(path.join(SRC, ".opencode", "models.json"), "utf8"))
const ladder = (role) => models[role].slice(0, models.max_models_per_item)
const now = Date.parse("2026-09-12T17:05:00Z")
const T = (m) => now - m * 60000
const costs = {
  total: 4.61, byRole: { builder: 3.2, researcher: 1.41 },
  byContract: { "create-las-facade": 0.12, "design-icons": 0.31, "archive-change": 0.05 },
  byModel: {
    builder: { "glm-5.3-flash": { sessions: 12, cost: 2.1, input: 1000000, output: 200000, ms: 3600000 }, "mimo-v2.5-free": { sessions: 5, cost: 0, input: 400000, output: 80000, ms: 600000 } },
    researcher: { "glm-5.3-flash": { sessions: 4, cost: 1.41, input: 500000, output: 90000, ms: 1200000 } },
  },
}
const supBusy = { sessionId: "ses_fixed", title: "Desarrollo profesional de visor de registros", slug: "quiet-knight", last: { at: T(1), kind: "tool", text: "bash: node .opencode/codegen.mjs status" }, waiting: null, userMessages: [{ id: "m1", at: T(30), text: "resume el estado y dime qué falta" }] }
const supWaiting = { sessionId: "ses_fixed", title: "Desarrollo profesional de visor de registros", slug: "quiet-knight", last: { at: T(4), kind: "text", text: "El plan tiene 23 contratos en 4 capas. ¿Apruebas el build?" }, waiting: "El plan tiene 23 contratos en 4 capas. ¿Apruebas el build?", userMessages: [{ id: "m1", at: T(30), text: "resume el estado y dime qué falta" }] }
const reports = Object.fromEntries(["web-stack", "las-standard"].map((id) => [id, readFileSync(path.join(F, "research", `${id}.md`), "utf8")]))
const contractFiles = Object.fromEntries(["design-icons", "archive-change"].map((id) => [id, json(`contracts/${id}/contract.json`)]))
const quota = { at: new Date(T(2)).toISOString(), rolling: { percent: 0, limited: false, resetsAt: new Date(T(-300)).toISOString() }, weekly: { percent: 100, limited: true, resetsAt: new Date(T(-2000)).toISOString() }, monthly: { percent: 81, limited: false, resetsAt: new Date(T(-28000)).toISOString() } }
const base = { root, reports, contractFiles, quota, sandboxes: "/home/user/.las-viewer-v5-codegen-sandboxes", plan: json("plan.json"), report: json("runs/20260911T153542Z-build/report.json"), current: json("runs/current.json"), research: json("research/status.json"), researchRun: json("runs/current-research.json"), events, models, ladders: { builder: ladder("builder"), researcher: ladder("researcher") }, now, costs }
const cases = {
  building: { ...base, alive: true, researchAlive: false, sup: supBusy, merged: false },
  waiting: { ...base, alive: false, researchAlive: false, sup: supWaiting, merged: false },
  researching: { ...base, alive: false, researchAlive: true, researchRun: { ...base.researchRun, pid: 1, started: new Date(T(12)).toISOString(), questions: ["net-pay-gaps", "web-stack"] }, sup: supBusy, merged: null },
  nodb: { ...base, alive: false, researchAlive: false, sup: null, costs: null, quota: null, merged: true },
}
const golden = path.join(HERE, "golden", "board")
mkdirSync(golden, { recursive: true })
let failed = 0
for (const [name, args] of Object.entries(cases)) {
  const out = { [`${name}.html`]: await renderBoard(args), [`${name}.json`]: JSON.stringify(boardJson(args), null, 2) + "\n" }
  for (const [f, got] of Object.entries(out)) {
    const file = path.join(golden, f)
    if (update || !existsSync(file)) { writeFileSync(file, got); console.log(`wrote ${f}`); continue }
    if (readFileSync(file, "utf8") !== got) {
      failed++
      const tmp = `/tmp/golden-board-${f}`; writeFileSync(tmp, got)
      console.log(`FAIL ${f}\n${spawnSync("diff", ["-u", file, tmp], { encoding: "utf8" }).stdout.split("\n").slice(0, 30).join("\n")}`)
    } else console.log(`ok   ${f}`)
  }
}
process.exit(failed ? 1 : 0)
