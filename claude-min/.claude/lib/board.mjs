// The board's facts. boardData turns the files the script writes (plan, report,
// research status, journal, current run) into one object; boardJson flattens
// it for project-garden and scripts; renderBoard hands it to board-html.mjs,
// which only draws. Cost and wall time come from the attempts themselves (the
// `result` event of every claude -p run): API-equivalent dollars, since the
// subscription charges nothing per call.
// Redesigning the board means touching board-html.mjs and board.css, not this.

import { statSync, existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

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

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

// ---------- Claude subscription quota ----------

// The two windows Claude Code shows (5 hours, 7 days). The only official
// source is the `rate_limits` object Claude Code pipes to the status line
// (Pro/Max, after the first API response); templates/statusline.sh keeps the
// latest copy in ~/.claude/usage.json. Null when that file is missing or
// older than a day: the board never guesses.
export function claudeQuota() {
  try {
    const file = path.join(os.homedir(), ".claude", "usage.json")
    if (!existsSync(file)) return null
    const u = JSON.parse(readFileSync(file, "utf8"))
    if (!u.at || Date.now() - Date.parse(u.at) > 24 * 3600000) return null
    const win = (w) =>
      w && w.used_percentage != null
        ? {
            percent: Number(w.used_percentage),
            limited: Number(w.used_percentage) >= 100,
            resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null,
          }
        : null
    return { at: u.at, plan: u.plan ?? null, rolling: win(u.rate_limits?.five_hour), weekly: win(u.rate_limits?.seven_day) }
  } catch {
    return null
  }
}

// ---------- cost and time from the attempts ----------

// Every attempt (builder) and every research result carries the cost and
// duration of its claude -p call. Summed by role, by model and by contract.
export function attemptCosts(contracts, researchResults) {
  const byRole = { builder: 0, researcher: 0 }
  const byModel = { builder: {}, researcher: {} }
  const byContract = {}
  let total = 0
  const add = (role, model, cost, ms, id) => {
    const m = (byModel[role][short(model)] ??= { sessions: 0, cost: 0, ms: 0 })
    m.sessions++
    m.cost += cost ?? 0
    m.ms += ms ?? 0
    byRole[role] += cost ?? 0
    total += cost ?? 0
    if (id) byContract[id] = (byContract[id] ?? 0) + (cost ?? 0)
  }
  for (const c of contracts)
    for (const a of c.s.attempts ?? []) add("builder", a.model, a.cost, a.duration_ms, c.id)
  for (const r of Object.values(researchResults))
    if (r.model) add("researcher", r.model, r.cost, r.duration_ms, null)
  const any = Object.keys(byModel.builder).length || Object.keys(byModel.researcher).length
  return any ? { total, byRole, byModel, byContract } : null
}
const short = (m) => String(m ?? "").replace(/^[^/]+\//, "")

// ---------- Markdown, enough for a research report ----------

// Headings, paragraphs, bullet and numbered lists, fenced code, inline code,
// bold, italics, links and pipe tables. Nothing else, no dependencies.
export function renderMarkdown(md) {
  const inline = (t) =>
    esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
  const out = []
  const lines = md.replace(/\r/g, "").split("\n")
  let i = 0
  const flushPara = (buf) => {
    if (buf.length) out.push(`<p>${inline(buf.join(" "))}</p>`)
    buf.length = 0
  }
  const para = []
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      flushPara(para)
      const code = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++])
      i++
      out.push(`<pre>${esc(code.join("\n"))}</pre>`)
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)/)
    if (h) {
      flushPara(para)
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
      i++
      continue
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      flushPara(para)
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items = []
      while (i < lines.length && (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i])))
        items.push(lines[i++].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""))
      out.push(
        `<${ordered ? "ol" : "ul"}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`,
      )
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      flushPara(para)
      const cells = (l) =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => inline(c.trim()))
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push(
        `<table><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`,
      )
      continue
    }
    if (!line.trim()) {
      flushPara(para)
      i++
      continue
    }
    para.push(line.trim())
    i++
  }
  flushPara(para)
  return out.join("\n")
}

// ---------- facts ----------

// The facts the board is made of, in one object: the HTML and board.json
// (read by project-garden) come from the same call, so they can never disagree.
export function boardData(args) {
  const {
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
  // The supervisor is the user's own Claude Code session: the board has no
  // window into it (tests may pass a fixed `sup` to draw those states).
  const sup = "sup" in args ? args.sup : null
  const researchResults = research?.results ?? {}
  const costs = "costs" in args ? args.costs : attemptCosts(contracts, researchResults)
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
  const NW = 190,
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
  // A run id starts with its UTC stamp: 20260912T004212Z-research → a date.
  const runDate = (run) => {
    const m = String(run).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/)
    return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null
  }
  // Research reports rendered once here so the page can show them in a modal.
  const reportsHtml = Object.fromEntries(
    Object.entries(args.reports ?? {}).map(([id, md]) => [id, renderMarkdown(md)]),
  )
  const contractFiles = args.contractFiles ?? {}
  // Tests pass a fixed `claude`; the script leaves it out and the board reads ~/.claude/usage.json.
  const claude = "claude" in args ? args.claude : claudeQuota()

  // ---- attempts and passes per model and role ----
  const perRole = { builder: {}, researcher: {} }
  for (const c of contracts)
    for (const a of c.s.attempts ?? []) {
      // A racer killed because another passed, or a model that never answered, did not try.
      if (a.verdict === "LOST" || a.verdict === "NO_RESPONSE") continue
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
    runDate,
    reportsHtml,
    contractFiles,
    claude,
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
          title: d.sup.title ?? null,
          slug: d.sup.slug ?? null,
          lastAt: new Date(d.sup.last.at).toISOString(),
          lastKind: d.sup.last.kind,
        }
      : null,
    // Same shape as opencode-min's board.json (project-garden reads both): the
    // quotas of the other providers and the delivery of a notice do not exist
    // here (the supervisor is the session that reads the output), so they stay
    // null or true.
    quota: null,
    openai: null,
    claude: d.claude,
    lastNotify: lastNotify
      ? { at: lastNotify.at, text: lastNotify.text, delivered: true, port: null, reason: null }
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
