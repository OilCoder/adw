// The board's facts. boardData turns the files the script writes (plan, report,
// research status, journal, current run) plus a read-only look at OpenCode's
// database into one object; boardJson flattens it for project-garden and
// scripts; renderBoard hands it to board-html.mjs, which only draws.
// Redesigning the board means touching board-html.mjs and board.css, not this.

import { statSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { supervisorActivity, agentCosts } from "./opencode-db.mjs"

// ---------- formatting used by the facts (board-html.mjs imports these; a change here needs a restart, unlike board-html.mjs and board.css) ----------

export const mins = (ms) =>
  ms < 60000
    ? `${Math.max(0, Math.round(ms / 1000))} s`
    : ms < 3600000
      ? `${Math.round(ms / 60000)} min`
      : `${Math.floor(ms / 3600000)} h ${Math.round((ms % 3600000) / 60000)} min`
export const hhmm = (t) =>
  new Date(t).toLocaleTimeString("es", { hour12: false, hour: "2-digit", minute: "2-digit" })
export const cut = (s, n) => {
  s = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

// ---------- facts ----------

// The facts the board is made of, in one object: the HTML and board.json
// (read by project-garden) come from the same call, so they can never disagree.
export function boardData(args) {
  const {
    root,
    sandboxes,
    plan,
    report,
    current,
    research,
    alive,
    researchRun,
    researchAlive,
    events = [],
    now = Date.now(),
  } = args
  const contracts = (plan?.contracts ?? []).map((c) => ({
    ...c,
    deps: c.depends_on ?? [],
    s: report?.contracts?.[c.id] ?? { status: "PENDING" },
  }))
  const byId = Object.fromEntries(contracts.map((c) => [c.id, c]))
  const passed = contracts.filter((c) => c.s.status === "PASS").length
  const running = contracts.filter((c) => c.s.status === "RUNNING")
  const failed = contracts.filter(
    (c) => !["PASS", "RUNNING", "PENDING", "NOT_SELECTED", "SKIPPED"].includes(c.s.status),
  )
  // Tests pass fixed `sup` and `costs`; the script leaves them out and the
  // board reads OpenCode's database.
  const sup = "sup" in args ? args.sup : supervisorActivity(root)
  const costs = "costs" in args ? args.costs : agentCosts(root, sandboxes)
  const researchResults = research?.results ?? {}
  const researchRunning = researchAlive
    ? (researchRun?.questions ?? []).filter(
        (id) => !researchResults[id] || new Date(researchResults[id].at ?? 0) < new Date(researchRun.started),
      )
    : []

  // ---- phase ----
  const lastMerge = [...events].reverse().find((e) => e.kind === "merge")
  const supAgo = sup?.last ? now - sup.last.at : null
  let phase, phaseCls, phaseSub
  if (researchAlive) {
    phase = "investigando"
    phaseCls = "run"
    phaseSub = `desde ${hhmm(researchRun.started)} · ${mins(now - new Date(researchRun.started).getTime())} · ${researchRun.questions?.length ?? 0} preguntas`
  } else if (alive) {
    phase = "construyendo"
    phaseCls = "run"
    phaseSub = `desde ${hhmm(current.started)} · ${mins(now - new Date(current.started).getTime())} · ${running.length} en paralelo`
  } else if (sup?.last && supAgo < 3 * 60000 && sup.last.kind !== "text") {
    phase = "supervisor trabajando"
    phaseCls = "run"
    phaseSub = `última acción hace ${mins(supAgo)}`
  } else if (sup?.waiting && !alive && !researchAlive) {
    phase = "te espera"
    phaseCls = "you"
    phaseSub = `desde ${hhmm(sup.last.at)} · ${mins(supAgo)}`
  } else if (
    current &&
    !current.finished &&
    Object.values(report?.contracts ?? {}).some((c) => c.status === "RUNNING")
  ) {
    phase = "detenido"
    phaseCls = "bad"
    phaseSub = "el build murió con contratos en curso; reanuda con --resume"
  } else {
    phase = "parado"
    phaseCls = ""
    phaseSub = sup?.last ? `supervisor inactivo hace ${mins(supAgo)}` : "sin actividad registrada"
  }
  // The supervisor only "waits" when nothing is running: a status report
  // written while a build or research is alive is not a question for the user.
  const waitingText = sup?.waiting && !alive && !researchAlive ? cut(sup.waiting, 220) : null

  // ---- journal: script events + user messages + the supervisor's open question, newest first ----
  const journal = events.map((e) => ({ at: new Date(e.at).getTime(), kind: e.kind, e }))
  for (const u of sup?.userMessages ?? []) journal.push({ at: u.at, kind: "user", text: u.text })
  if (waitingText) journal.push({ at: sup.last.at, kind: "waiting", text: waitingText })
  journal.sort((a, b) => b.at - a.at)
  // Questions of the research run in progress, from its start event.
  const lastStartQuestions =
    events
      .slice()
      .reverse()
      .find((e) => e.kind === "research-start")?.questions ?? []

  // ---- dependency graph: layers by depth, positions, critical path ----
  const depth = {}
  const d = (id) =>
    depth[id] ?? (depth[id] = byId[id].deps.length ? 1 + Math.max(...byId[id].deps.map(d)) : 0)
  contracts.forEach((c) => d(c.id))
  const layers = []
  contracts.forEach((c) => (layers[depth[c.id]] ??= []).push(c))
  const NW = 150,
    colW = NW + 40,
    rowH = 50,
    top = 40
  const W = Math.max(colW * layers.length, 300),
    H = top + rowH * Math.max(1, ...layers.map((l) => l.length)) + 10
  const pos = {}
  layers.forEach((l, li) => {
    const y0 = top + (H - top - rowH * l.length) / 2 + rowH / 2
    l.forEach((c, i) => {
      pos[c.id] = { x: colW * li + 20, y: y0 + i * rowH }
    })
  })
  const longest = (id) => {
    const c = byId[id]
    if (!c.deps.length) return [id]
    return [...c.deps.map(longest).sort((a, b) => b.length - a.length)[0], id]
  }
  const sinks = contracts.filter((c) => !contracts.some((o) => o.deps.includes(c.id)))
  const crit = new Set(sinks.map((s) => longest(s.id)).sort((a, b) => b.length - a.length)[0] ?? [])
  const graph = { layers, pos, crit, NW, colW, top, W, H }

  // ---- research by run, with the question text from the start events ----
  const questionText = {}
  for (const s of events.filter((e) => e.kind === "research-start"))
    for (const q of s.questions) questionText[q.id] = q.question
  const runsOf = {}
  for (const [id, r] of Object.entries(researchResults))
    (runsOf[r.run ?? research?.run ?? "?"] ??= []).push([id, r])
  const researchRuns = Object.entries(runsOf).sort((a, b) => (a[0] < b[0] ? 1 : -1))

  // ---- attempts and passes per model and role ----
  const perRole = { builder: {}, researcher: {} }
  for (const c of contracts)
    for (const a of c.s.attempts ?? []) {
      const m = (perRole.builder[a.model] ??= { attempts: 0, passed: 0 })
      m.attempts++
      if (a.verdict === "PASS") m.passed++
    }
  for (const r of Object.values(researchResults)) {
    if (!r.model) continue
    const m = (perRole.researcher[r.model] ??= { attempts: 0, passed: 0 })
    m.attempts += r.attempt ?? 1
    if (r.status === "DONE") m.passed++
  }

  return {
    contracts,
    byId,
    passed,
    running,
    failed,
    sup,
    costs,
    researchResults,
    researchRunning,
    lastMerge,
    supAgo,
    phase,
    phaseCls,
    phaseSub,
    waitingText,
    journal,
    lastStartQuestions,
    graph,
    questionText,
    researchRuns,
    perRole,
  }
}

// board.json: the same facts, flat, for tools that read many projects at once.
export function boardJson(args) {
  const d = boardData(args)
  const { current, alive, researchAlive, events = [], merged = null, now = Date.now() } = args
  const pending = d.contracts.filter((c) => ["PENDING", "RUNNING"].includes(c.s.status)).length
  const rr = Object.values(d.researchResults)
  const lastNotify = [...events].reverse().find((e) => e.kind === "notify") ?? null
  const gateBroken = d.failed.filter((c) => /GATE BROKEN/i.test(String(c.s.reason ?? ""))).map((c) => c.id)
  const byModel = {}
  for (const c of d.contracts)
    if (c.s.status === "PASS" && c.s.model) byModel[c.s.model] = (byModel[c.s.model] ?? 0) + 1
  return {
    updatedAt: new Date(now).toISOString(),
    phase: d.phase,
    phaseCls: d.phaseCls,
    phaseSub: d.phaseSub,
    alive,
    researchAlive,
    waiting: d.waitingText,
    build: {
      run: current?.run ?? null,
      passed: d.passed,
      total: d.contracts.length,
      failed: d.failed.map((c) => c.id),
      gateBroken,
      pending,
      running: d.running.map((c) => c.id),
      integration: current?.integration ? { branch: current.integration, merged } : null,
      closedBy: byModel,
    },
    research: {
      total: rr.length,
      done: rr.filter((r) => r.status === "DONE").length,
      partial: rr.filter((r) => r.status === "PARTIAL").length,
      rejected: rr.filter((r) => r.status === "REJECTED").length,
      alive: researchAlive,
    },
    cost: d.costs ? { total: d.costs.total, byRole: d.costs.byRole, byModel: d.costs.byModel } : null,
    supervisor: d.sup?.last
      ? {
          sessionId: d.sup.sessionId ?? null,
          lastAt: new Date(d.sup.last.at).toISOString(),
          lastKind: d.sup.last.kind,
        }
      : null,
    lastNotify: lastNotify
      ? {
          at: lastNotify.at,
          text: lastNotify.text,
          delivered: Boolean(lastNotify.delivered),
          port: lastNotify.port ?? null,
          reason: lastNotify.reason ?? null,
        }
      : null,
  }
}

// The HTML. board-html.mjs is imported fresh whenever it changes on disk (and
// it reads board.css on every call), so a build that runs for hours picks up
// a redesign without a restart.
export async function renderBoard(args) {
  const file = new URL("./board-html.mjs", import.meta.url)
  const { renderBoard: draw } = await import(
    `${pathToFileURL(file.pathname).href}?v=${statSync(file).mtimeMs}`
  )
  return draw(boardData(args), args)
}
