#!/usr/bin/env node
// Behaviour freeze for the harness: every scenario in tests/scenarios/*.json runs
// codegen.mjs against a fixture with the fake opencode (no models, no cost) and
// its normalized outputs must equal tests/golden/<scenario>/. Usage:
//   node tests/golden.mjs            compare (writes missing goldens)
//   node tests/golden.mjs --update   rewrite every golden from the current code
//   node tests/golden.mjs name…      only those scenarios
// A scenario: { fixture, pre?: {path: content}, models?: {…merged into models.json},
//               script: {…for the fake, see tests/fake-opencode/opencode},
//               runs: [[args…], …] }   each run is `node .opencode/codegen.mjs args… --wait`.

import { spawnSync, spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const HERE = path.dirname(new URL(import.meta.url).pathname)
const SRC = path.dirname(HERE)
const args = process.argv.slice(2)
const update = args.includes("--update")
const only = args.filter((a) => !a.startsWith("--"))
const scenarios = readdirSync(path.join(HERE, "scenarios")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((n) => !only.length || only.includes(n))

const sh = (cmd, cwd, env = {}) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", env: { ...process.env, ...env } })

function normalize(text, work) {
  const sandboxes = path.join(path.dirname(work), `.${path.basename(work)}-codegen-sandboxes`)
  return text
    .split(sandboxes).join("$SANDBOXES").split(work).join("$WORK")
    .replace(/\d{8}T\d{6}Z/g, "STAMP")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "TS")
    .replace(/^\d{2}:\d{2}:\d{2} /gm, "")
    .replace(/\(pid \d+\)/g, "(pid N)").replace(/pid \d+/g, "pid N").replace(/process \d+/g, "process N")
    .replace(/"pid": \d+/g, '"pid": N')
    // A FAIL notice quotes the state line of that instant; parallel contracts make it vary.
    .replace(/Build so far: [^.]*\. The run continues/g, "Build so far: <state>. The run continues")
    .replace(/in \d+\.\d+s/g, "in Xs")
    .replace(/"(duration_ms|updatedAt|lastAt|at|started|finished|time_created|time_updated|ms)": [^,\n}]+,?/g, "")
    .replace(/[0-9a-f]{40}/g, "SHA").replace(/\b[0-9a-f]{7}\b(?= )/g, "sha")
}

let failed = 0
for (const name of scenarios) {
  const sc = JSON.parse(readFileSync(path.join(HERE, "scenarios", `${name}.json`), "utf8"))
  const tmp = mkdtempSync(path.join(os.tmpdir(), "golden-"))
  const work = path.join(tmp, "project")
  const state = path.join(tmp, "state")
  mkdirSync(state, { recursive: true })
  cpSync(path.join(HERE, "fixtures", sc.fixture), work, { recursive: true })
  for (const [rel, content] of Object.entries(sc.pre ?? {})) { mkdirSync(path.dirname(path.join(work, rel)), { recursive: true }); writeFileSync(path.join(work, rel), content) }
  sh(`bash "${SRC}/install.sh" "${work}" >/dev/null`, work)
  // The freeze tests the flat ladder (one model per rung) unless a scenario brings its own
  // models: the installed models.json groups the free models, which would turn every
  // scenario into a race.
  { const f = path.join(work, ".opencode", "models.json"); const m = JSON.parse(readFileSync(f, "utf8")); for (const role of ["researcher", "builder"]) m[role] = m[role].flat(); writeFileSync(f, JSON.stringify({ ...m, ...(sc.models ?? {}), timeouts_seconds: { ...m.timeouts_seconds, ...(sc.models?.timeouts_seconds ?? {}) } }, null, 2)) }
  sh(`git init -q && git add -A && git -c user.name=golden -c user.email=golden@localhost commit -qm fixture`, work)
  const scriptFile = path.join(tmp, "script.json")
  writeFileSync(scriptFile, JSON.stringify(sc.script ?? {}))
  // HOME points at the temp dir: no OpenCode database, no auth.json, so the board sees no supervisor, no cost and no quota.
  const env = { HOME: tmp, PATH: `${path.join(HERE, "fake-opencode")}:${process.env.PATH}`, FAKE_OPENCODE_SCRIPT: scriptFile, FAKE_OPENCODE_STATE: state, OPENCODE_PORT: "1", TZ: "UTC", GIT_AUTHOR_NAME: "golden", GIT_AUTHOR_EMAIL: "g@l", GIT_COMMITTER_NAME: "golden", GIT_COMMITTER_EMAIL: "g@l" }
  const out = {}
  let runs = ""
  const record = (run, r) => {
    // Parallel contracts finish in any order: sort the log lines of each run.
    const lines = normalize(r.stdout + r.stderr, work).split("\n").filter(Boolean).sort()
    runs += `$ codegen ${run.join(" ")}  → exit ${r.status}\n${lines.join("\n")}\n\n`
  }
  // A run is an argv array, or { run, during: [{ after, edit?, run }] }: the
  // inner commands fire while the outer one is still alive (requeue scenarios).
  for (const entry of sc.runs) {
    const run = Array.isArray(entry) ? entry : entry.run
    const wait = ["build", "research"].includes(run[0]) ? ["--wait"] : []
    const opts = { cwd: work, encoding: "utf8", env: { ...process.env, ...env } }
    if (Array.isArray(entry)) { record(run, spawnSync("node", [".opencode/codegen.mjs", ...run, ...wait], opts)); continue }
    const main = spawn("node", [".opencode/codegen.mjs", ...run, ...wait], opts)
    let out = ""
    main.stdout.on("data", (d) => (out += d)); main.stderr.on("data", (d) => (out += d))
    const t0 = Date.now()
    for (const d of entry.during) {
      await new Promise((r) => setTimeout(r, Math.max(0, t0 + d.after * 1000 - Date.now())))
      for (const [rel, content] of Object.entries(d.edit ?? {})) writeFileSync(path.join(work, rel), content)
      record([`(${d.after}s)`, ...d.run], spawnSync("node", [".opencode/codegen.mjs", ...d.run], opts))
    }
    const status = await new Promise((r) => main.on("close", r))
    record(run, { stdout: out, stderr: "", status })
  }
  const status = spawnSync("node", [".opencode/codegen.mjs", "status"], { cwd: work, encoding: "utf8", env: { ...process.env, ...env } })
  const structure = spawnSync("node", [".opencode/codegen.mjs", "structure"], { cwd: work, encoding: "utf8", env: { ...process.env, ...env } })
  out["runs.txt"] = runs
  out["status.txt"] = normalize(status.stdout + status.stderr, work)
  out["structure.txt"] = `exit ${structure.status}\n${normalize(structure.stdout + structure.stderr, work)}`
  const current = existsSync(path.join(work, ".codegen/runs/current.json")) ? JSON.parse(readFileSync(path.join(work, ".codegen/runs/current.json"), "utf8")) : null
  if (current) out["report.json"] = normalize(readFileSync(path.join(work, ".codegen/runs", current.run, "report.json"), "utf8"), work)
  for (const [k, f] of [["research-status.json", ".codegen/research/status.json"], ["board.json", ".codegen/board.json"], ["notify.log", "../state/notify.log"], ["calls.log", "../state/calls.log"]]) {
    const p = path.join(work, f); if (existsSync(p)) out[k] = normalize(readFileSync(p, "utf8"), work)
    // Parallel contracts call the fake in any order.
    if (k === "calls.log" && out[k]) out[k] = out[k].split("\n").filter(Boolean).sort().join("\n") + "\n"
  }
  if (existsSync(path.join(work, ".codegen/journal.jsonl"))) out["journal.jsonl"] = normalize(readFileSync(path.join(work, ".codegen/journal.jsonl"), "utf8"), work).split("\n").filter(Boolean).sort().join("\n") + "\n"
  const branches = sh(`git for-each-ref --format='%(refname:short)' refs/heads | sort`, work).stdout
  // Commit subjects per branch, sorted: parallel contracts land in any order.
  const log = sh(`for b in $(git for-each-ref --format='%(refname:short)' refs/heads | sort); do echo "== $b"; git log --format='%s' "$b" | sort; done`, work).stdout
  // Which parallel contract lands second (and names the merge commit) is not deterministic.
  out["git.txt"] = normalize(branches + log, work).replace(/^codegen: merge \S+$/gm, "codegen: merge <contract>")
  const golden = path.join(HERE, "golden", name)
  const fresh = !existsSync(golden)
  if (update || fresh) { rmSync(golden, { recursive: true, force: true }); mkdirSync(golden, { recursive: true }); for (const [f, c] of Object.entries(out)) writeFileSync(path.join(golden, f), c); console.log(`${fresh ? "wrote" : "updated"} ${name}`) }
  else {
    const diffs = []
    const files = new Set([...Object.keys(out), ...readdirSync(golden)])
    for (const f of files) {
      const want = existsSync(path.join(golden, f)) ? readFileSync(path.join(golden, f), "utf8") : null
      const got = out[f] ?? null
      if (want !== got) { const gotFile = path.join(tmp, f); writeFileSync(gotFile, got ?? ""); diffs.push(`  ${f}:\n${sh(`diff -u "${path.join(golden, f)}" "${gotFile}" | head -40`, tmp).stdout}`) }
    }
    if (diffs.length) { failed++; console.log(`FAIL ${name}\n${diffs.join("\n")}`) } else console.log(`ok   ${name}`)
  }
  rmSync(tmp, { recursive: true, force: true })
  rmSync(path.join(tmp, "..", `.project-codegen-sandboxes`), { recursive: true, force: true })
}
console.log(failed ? `\n${failed} scenario(s) differ from golden` : `\nall ${scenarios.length} scenarios match golden`)
process.exit(failed ? 1 : 0)
