// Draws .codegen/board.html from the facts in board.mjs: a self-refreshing
// tabbed page. "Ahora" shows the phase, what is running and
// the journal; then Research, Contratos (graph + board) and Modelos y coste.
// One function per section, each returning a string; the styles are
// board.css, inlined so the page stays a single file that opens from disk.
// No data is computed here: if a section needs a number, boardData provides it.
// Icons are an inline SVG sprite (Lucide-style strokes), no network.

import { readFileSync } from "node:fs"
import { mins, hhmm, cut } from "./board.mjs"

// ---- labels and formatting for the page ----
export const CLASS = {
  PASS: "ok",
  RUNNING: "run",
  PENDING: "wait",
  NOT_SELECTED: "wait",
  DONE: "ok",
  PARTIAL: "run",
  REJECTED: "bad",
}
export const LABEL = {
  PASS: "pasó",
  RUNNING: "construyendo",
  PENDING: "esperando",
  NOT_SELECTED: "no seleccionado",
  FAIL: "falló",
  GATE_FAIL: "gate falló",
  OUT_OF_SCOPE: "fuera de alcance",
  PROTECTED_TOUCHED: "tocó protegidos",
  STRUCTURE: "rompe el mapa",
  NO_CHANGES: "sin cambios",
  TIMEOUT: "timeout",
  NO_MODELS: "sin modelos",
  GATE_TRIVIAL: "gate trivial",
  MERGE_CONFLICT: "conflicto de merge",
  SKIPPED: "omitido",
  INSTALL_FAILED: "instalación falló",
  STOPPED: "detenido",
  ERROR: "error",
  DONE: "informe completo",
  PARTIAL: "informe parcial",
  NO_REPORT: "sin informe",
  REJECTED: "rechazado",
}
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
export const cls = (st) => CLASS[st] ?? "bad"
export const short = (m) => String(m ?? "").replace(/^[^/]+\//, "")
export const usd = (n) => `$${(n ?? 0).toFixed(2)}`
export const day = (t) =>
  new Date(t).toLocaleDateString("es", { weekday: "short", day: "2-digit", month: "short" })
const dayShort = (t) => new Date(t).toLocaleDateString("es", { day: "2-digit", month: "short" })

const css = () => readFileSync(new URL("./board.css", import.meta.url), "utf8")

// ---- icons: one <symbol> each, referenced with <use> ----
const A =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
const ICONS = {
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  checksq: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  flask:
    '<path d="M10 2v7.5L4.6 19a2 2 0 0 0 1.7 3h11.4a2 2 0 0 0 1.7-3L14 9.5V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
  chart: '<path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/>',
  pause: '<circle cx="12" cy="12" r="10"/><path d="M10 15V9"/><path d="M14 15V9"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M10 13h4"/><path d="M10 17h4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  coins:
    '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  branch:
    '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  checkc: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  xc: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  loader: '<circle cx="12" cy="12" r="10" stroke-dasharray="4 4"/>',
  circle: '<circle cx="12" cy="12" r="10"/>',
  skip: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
  belloff:
    '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="M17 17H4l1.4-1.4A2 2 0 0 0 6 14.2V11a6 6 0 0 1 .3-2"/><path d="M8.7 3A6 6 0 0 1 18 8v3.3"/><path d="m2 2 20 20"/>',
  bell: '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>',
  play: '<path d="m6 3 14 9-14 9V3z"/>',
  msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  alert:
    '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  stamp: '<path d="M12 3v6"/><path d="M5 9h14"/><path d="M6 13h12v4H6z"/><path d="M4 21h16"/>',
  wrench:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
}
const sprite = () =>
  `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${Object.entries(ICONS)
    .map(([k, v]) => `<symbol id="i-${k}" ${A}>${v}</symbol>`)
    .join("")}</svg>`
const icon = (name, extra = "") => `<svg class="i${extra ? " " + extra : ""}"><use href="#i-${name}"/></svg>`
const stateIcon = (st) =>
  ({
    ok: "checkc",
    run: "loader",
    wait: st === "SKIPPED" || st === "NOT_SELECTED" ? "skip" : "circle",
    bad: "xc",
  })[cls(st)]
const rateColor = (attempts, pct) =>
  attempts < 3 ? "var(--wait)" : pct >= 70 ? "var(--ok)" : pct >= 40 ? "var(--run)" : "var(--bad)"
const bar = (pct, color, width = "") =>
  `<span class="bar"${width ? ` style="width:${width}"` : ""}><i style="width:${Math.max(0, Math.min(100, pct))}%;background:${color}"></i></span>`

// ---- header: project, branches, the supervisor's session, the clock ----
function header(d, { root, current, alive, researchAlive, now }) {
  const name = root.split("/").pop()
  const sup = d.sup
  const sess = sup?.title
    ? `<div class="sub sess">${icon("bot")}Sesión del supervisor: <b>${esc(sup.title)}</b>${sup.slug ? ` · <span class="slug">${esc(sup.slug)}</span>` : ""}${sup.last ? ` · hace ${mins(d.supAgo)}` : ""}</div>`
    : `<div class="sub sess">${icon("bot")}Supervisor: tu sesión de Claude Code en este proyecto</div>`
  return `<div class="hdr"><div class="mark">${esc(name.slice(0, 1).toUpperCase())}</div><div><h1>Avance de ${esc(name)}</h1><div class="sub">${icon("branch")}${esc(current?.integration ?? "sin rama de integración")}${current?.user_branch ? ` · ${esc(current.user_branch)}` : ""}</div>${sess}</div><div class="right">${icon("clock")}Actualizado ${hhmm(now)} · cada ${alive || researchAlive ? 10 : 30} s</div></div>`
}

// ---- the five facts at the top ----
function strip(d, { alive, researchAlive }) {
  const { phase, phaseCls, phaseSub, sup, supAgo, passed, contracts, lastMerge, waitingText, costs } = d
  const phaseIcon =
    phaseCls === "run" ? "activity" : phaseCls === "you" ? "user" : phaseCls === "bad" ? "alert" : "pause"
  const supText = sup?.last
    ? `${hhmm(sup.last.at)} · ${sup.last.kind === "text" ? "te respondió" : sup.last.kind === "thinking" ? "pensando" : cut(sup.last.text, 60)}`
    : "la sesión de Claude Code que lanza el script"
  const cell = (k, icn, v, s, extra = "") =>
    `<div class="${extra}">${icon(icn)}<div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`
  return `<div class="strip">
${cell("Fase", phaseIcon, `${phaseCls === "run" ? '<span class="pulse"></span>' : ""}${esc(phase)}`, esc(phaseSub), phaseCls)}
${cell("Supervisor", "bot", sup?.last ? `hace ${mins(supAgo)}` : "tú", esc(supText))}
${cell("Contratos", "file", `${passed}<small>de ${contracts.length} pasaron</small>`, lastMerge ? `en ${esc(lastMerge.branch ?? "master")}: ${lastMerge.commits} commits · ${hhmm(lastMerge.at)}` : contracts.length ? "nada aterrizado aún" : "sin plan", passed && passed === contracts.length ? "ok" : "")}
${cell("Te espera", waitingText ? "user" : "clock", waitingText ? "sí" : "nada", waitingText ? esc(cut(waitingText, 90)) : sup?.userMessages?.length ? `tu último mensaje: ${hhmm(sup.userMessages.at(-1).at)}` : "sin decisiones pendientes", waitingText ? "you" : "")}
${cell(
  "Coste (equiv. API)",
  "coins",
  costs ? usd(costs.total) : "–",
  costs
    ? esc(
        Object.entries(costs.byRole)
          .map(([r, c]) => `${r} ${usd(c)}`)
          .join(" · "),
      )
    : "sin intentos todavía",
)}
</div>`
}

// ---- detail of one contract, for the modal ----
function contractDetail(d, id) {
  const c = d.byId[id]
  if (!c) return ""
  const file = d.contractFiles[id]
  const s = c.s
  const rows = []
  if (file?.objective) rows.push(["Objetivo", esc(file.objective)])
  else if (c.title) rows.push(["Título", esc(c.title)])
  if (file?.allowed_to_modify?.length)
    rows.push(["Puede tocar", `<span class="mono">${esc(file.allowed_to_modify.join(", "))}</span>`])
  if (c.deps.length) rows.push(["Depende de", `<span class="mono">${esc(c.deps.join(", "))}</span>`])
  rows.push([
    "Estado",
    `${esc(LABEL[s.status] ?? s.status)}${s.model ? ` · ${esc(short(s.model))}` : ""}${s.duration_ms ? ` · ${mins(s.duration_ms)}` : ""}`,
  ])
  if (s.attempts?.length)
    rows.push([
      "Intentos",
      `<table><tr><th>#</th><th>Modelo</th><th>Veredicto</th><th class="num">Pasos</th><th class="num">Archivos</th></tr>${s.attempts
        .map(
          (a) =>
            `<tr><td>${a.attempt}</td><td class="mono">${esc(short(a.model))}</td><td>${esc(LABEL[a.verdict] ?? a.verdict)}</td><td class="num">${a.steps ?? ""}</td><td class="num">${a.files?.length ?? ""}</td></tr>`,
        )
        .join("")}</table>`,
    ])
  const last = s.attempts?.at(-1)
  if (last?.detail)
    rows.push([
      last.verdict === "GATE_FAIL" ? "Último gate" : "Último detalle",
      `<pre>${esc(last.detail.split("\n").slice(-25).join("\n"))}</pre>`,
    ])
  if (s.reason && !last?.detail) rows.push(["Motivo", `<pre>${esc(String(s.reason).slice(-1500))}</pre>`])
  if (s.status !== "PENDING" && s.status !== "NOT_SELECTED")
    rows.push(["Logs", `<span class="mono">.codegen/runs/&lt;run&gt;/${esc(id)}/</span>`])
  return `<div class="jd">${rows.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join("")}</div>`
}

// ---- the running panel ----
function runningPanel(d, { researchRun, now }) {
  const cards = []
  for (const c of d.running)
    cards.push(
      `<div class="node run x" data-detail="c-${esc(c.id)}">${icon("loader")}<div class="id">${esc(c.id)}</div><div class="s">builder · ${esc(short(c.s.model))} · intento ${c.s.attempt ?? 1}${c.s.started ? ` · ${mins(now - new Date(c.s.started).getTime())}` : ""}</div></div>`,
    )
  for (const id of d.researchRunning) {
    const q = d.lastStartQuestions.find((x) => x.id === id)
    cards.push(
      `<div class="node run">${icon("flask")}<div class="id">${esc(id)}</div><div class="s">researcher · ${mins(now - new Date(researchRun.started).getTime())}${q ? ` · ${esc(cut(q.question, 90))}` : ""}</div></div>`,
    )
  }
  return cards.length
    ? `<div class="panel"><div class="panel-h"><span>Corriendo ahora</span><span>${cards.length}</span></div><div class="cards">${cards.join("")}</div></div>`
    : ""
}

// ---- one journal entry: icon and colour by kind, title and detail by kind ----
function journalEntry(d, j) {
  const e = j.e
  const models = (x) => esc((x.models ?? [x.model]).filter(Boolean).map(short).join(" › "))
  switch (j.kind) {
    case "contract": {
      const ok = e.status === "PASS"
      return {
        cls: ok ? "ok" : "bad",
        icon: "file",
        title: e.id,
        meta: ok
          ? `builder · ${models(e)} · ${e.attempts} intento${e.attempts > 1 ? "s" : ""} · ${e.files} archivos`
          : `${esc(LABEL[e.status] ?? e.status)} tras ${e.attempts} intentos${e.detail ? `: ${esc(cut(e.detail, 120))}` : ""}${e.models?.length ? ` · ${models(e)}` : ""}`,
        detail: d.byId[e.id] ? `c-${e.id}` : null,
      }
    }
    case "research":
      return {
        cls: cls(e.status),
        icon: "flask",
        title: e.id,
        meta: `researcher · ${models(e)} · ${esc(LABEL[e.status] ?? e.status)} · ${e.steps} pasos${e.one_shot ? " · escrito de una vez" : ""}`,
        detail: d.reportsHtml[e.id] ? `r-${e.id}` : null,
      }
    case "reject":
      return {
        cls: "bad",
        icon: "flask",
        title: e.id,
        meta: `informe de ${esc(short(e.model))} rechazado por el supervisor · se relanza con el siguiente modelo`,
      }
    case "research-start":
      return {
        cls: "acc",
        icon: "play",
        title: `Research: ${e.questions.length} pregunta${e.questions.length > 1 ? "s" : ""}`,
        meta: esc(e.questions.map((q) => q.id).join(", ")),
      }
    case "notify":
      return {
        cls: "acc",
        icon: "bell",
        title: "Aviso al supervisor",
        meta: esc(cut(e.text, 160)),
      }
    case "seal":
      return { cls: "acc", icon: "stamp", title: "Plan sellado", meta: `${e.contracts} contratos` }
    case "build-start":
      return {
        cls: "run",
        icon: "play",
        title: "Build iniciado",
        meta: `${e.contracts} contratos · paralelo ${e.parallel} · ${esc(e.run)}`,
      }
    case "build-resume":
      return {
        cls: "run",
        icon: "play",
        title: "Build reanudado",
        meta: `${e.only ? `${esc(e.only.join(", "))} · ` : ""}paralelo ${e.parallel}`,
      }
    case "build-end":
      return {
        cls: e.passed === e.total ? "ok" : "bad",
        icon: e.passed === e.total ? "checkc" : "xc",
        title: e.passed === e.total ? "Build terminado" : "Build terminado con fallos",
        meta: `${e.passed} de ${e.total} contratos pasaron`,
      }
    case "merge":
      return {
        cls: "merge",
        icon: "branch",
        title: `Aterrizado en ${esc(e.branch)}`,
        meta: `${e.commits} commits · ${esc(e.how)}${e.pending ? ` · ${e.pending} contratos pendientes` : ""}`,
      }
    case "user":
      return { cls: "you", icon: "msg", title: "Tú", meta: esc(cut(j.text, 160)) }
    case "waiting":
      return { cls: "you", icon: "bot", title: "El supervisor te espera", meta: esc(cut(j.text, 200)) }
    default:
      return null
  }
}

// ---- the journal: newest first, grouped by day, 80 entries ----
function journal(d) {
  const entries = d.journal.map((j) => ({ at: j.at, ...journalEntry(d, j) })).filter((e) => e.title)
  let lastDay = ""
  const rows = entries
    .slice(0, 80)
    .map((e) => {
      const dd = day(e.at)
      const head = dd !== lastDay ? `<div class="jday">${esc(dd)}</div>` : ""
      lastDay = dd
      return `${head}<div class="j ${e.cls}${e.detail ? " x" : ""}"${e.detail ? ` data-detail="${esc(e.detail)}"` : ""}><div class="t">${hhmm(e.at)}</div><div class="d"></div>${icon(e.icon)}<div><b>${esc(e.title)}</b><span class="m">${e.meta}</span></div></div>`
    })
    .join("")
  const legend = `<span class="leg"><span><i style="background:var(--ok)"></i>Contrato</span><span><i style="background:var(--accent)"></i>Research</span><span><i style="background:var(--you)"></i>Tú</span></span>`
  return `<div class="panel"><div class="panel-h"><span>Diario · ${entries.length} entradas · clic en un contrato o research abre su detalle</span>${legend}</div>${rows || '<div class="empty">Sin eventos todavía.</div>'}</div>`
}

// ---- research: one table, grouped by run, rows open the rendered report ----
function researchTable(d) {
  const { researchResults, researchRuns, questionText, runDate, reportsHtml } = d
  if (!Object.keys(researchResults).length)
    return `<div class="panel"><div class="empty">Sin research todavía.</div></div>`
  const stIcon = (st) =>
    ({ DONE: "checkc", PARTIAL: "loader", REJECTED: "xc", NO_REPORT: "xc", TIMEOUT: "xc", NO_MODELS: "xc" })[
      st
    ] ?? "circle"
  const rows = researchRuns
    .map(([run, items]) => {
      const t = runDate(run)
      return `<tr class="grp"><td colspan="5">Tanda · ${t ? `${dayShort(t)}, ${hhmm(t)}` : esc(run)}</td></tr>${items
        .map(([id, r]) => {
          const has = Boolean(reportsHtml[id])
          return `<tr${has ? ` class="rx" data-detail="r-${esc(id)}"` : ""}><td><b class="mono">${esc(id)}</b><div class="q">${esc(cut(questionText[id] ?? "", 160))}</div></td><td><span class="st ${cls(r.status)}">${icon(stIcon(r.status))}${esc(LABEL[r.status] ?? r.status)}</span>${r.one_shot ? '<div class="q">escrito de una vez</div>' : ""}${r.rejected?.length ? `<div class="q">sin informe con: ${esc(r.rejected.map(short).join(", "))}</div>` : ""}</td><td class="mono">${esc(short(r.model))}</td><td class="num">${r.steps ?? ""}</td><td class="mono">${r.report ? `${icon("file", "ri")}${esc(r.report.split("/").pop())}` : "—"}</td></tr>`
        })
        .join("")}`
    })
    .join("")
  return `<div class="panel"><table class="rs"><colgroup><col style="width:44%"><col style="width:20%"><col style="width:14%"><col style="width:6%"><col style="width:16%"></colgroup><tr><th>Pregunta</th><th>Estado</th><th>Modelo</th><th class="num">Pasos</th><th>Informe</th></tr>${rows}</table></div>`
}

// ---- the dependency graph as SVG; nodes carry their deps for the click-to-highlight script ----
function graph(d) {
  const { contracts, byId } = d
  const { layers, pos, crit, NW, colW, top, W, H } = d.graph
  let svg = ""
  layers.forEach((l, li) => {
    const x = colW * li
    svg += `<line class="lane" x1="${x + 8}" y1="${top - 14}" x2="${x + 8}" y2="${H - 6}"/><text class="lane-lbl" x="${x + 14}" y="${top - 20}">CAPA ${li}</text>`
  })
  contracts.forEach((c) =>
    c.deps.forEach((dep) => {
      const a = pos[dep],
        b = pos[c.id],
        x1 = a.x + NW,
        x2 = b.x,
        mx = (x1 + x2) / 2
      const k =
        byId[dep].s.status === "PASS" && c.s.status !== "PENDING"
          ? "edge done"
          : crit.has(dep) && crit.has(c.id)
            ? "edge crit"
            : "edge"
      svg += `<path class="${k}" data-from="${esc(dep)}" data-to="${esc(c.id)}" d="M${x1},${a.y} C${mx},${a.y} ${mx},${b.y} ${x2},${b.y}"/>`
    }),
  )
  contracts.forEach((c) => {
    const p = pos[c.id],
      st = c.s.status,
      k = cls(st)
    const sub =
      st === "RUNNING"
        ? `${short(c.s.model)} · int. ${c.s.attempt ?? 1}`
        : st === "PASS"
          ? `${short(c.s.model)} · ${c.s.attempts?.length ?? 1} int.`
          : (LABEL[st] ?? st)
    svg += `<g class="gn ${k}" data-id="${esc(c.id)}" data-deps="${esc(c.deps.join(","))}"><title>${esc(c.id)} — ${esc(c.title ?? "")}\n${esc(sub)}</title><rect x="${p.x}" y="${p.y - 18}" width="${NW}" height="36" rx="5"/><svg class="ico" x="${p.x + 7}" y="${p.y - 8}" width="16" height="16"><use href="#i-${stateIcon(st)}"/></svg><text x="${p.x + 28}" y="${p.y - 3}">${esc(cut(c.id, 17))}</text><text class="lbl2" x="${p.x + 28}" y="${p.y + 10}">${esc(cut(sub, 20))}</text></g>`
  })
  const legend = `<div class="legend"><span class="ok">${icon("checkc")}pasó</span><span class="run">${icon("loader")}en curso</span><span class="bad">${icon("xc")}falló</span><span class="wait">${icon("circle")}pendiente</span><span class="crit"><i></i>camino crítico</span><span>clic en un nodo ilumina su camino</span></div>`
  return `<div class="panel"><div class="panel-h"><span>Dependencias · qué frena qué</span><span>${contracts.length} contratos</span></div><div class="graph"><svg id="dep" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafo de dependencias">${svg}</svg></div>${legend}</div>`
}

// ---- contracts by state, four columns ----
function kanban(d, { now }) {
  const { contracts, byId, costs } = d
  const card = (c) => {
    const s = c.s,
      st = s.status,
      k = cls(st),
      cost = costs?.byContract?.[c.id]
    let sub
    if (st === "RUNNING")
      sub = `${esc(short(s.model))} · intento ${s.attempt ?? 1}${s.started ? ` · ${mins(now - new Date(s.started).getTime())}` : ""}`
    else if (st === "PASS")
      sub = `${esc(short(s.model))} · ${s.attempts?.length ?? 1} intento${(s.attempts?.length ?? 1) > 1 ? "s" : ""}${s.duration_ms ? ` · ${mins(s.duration_ms)}` : ""}${cost != null ? ` · ${usd(cost)}` : ""}`
    else if (st === "PENDING") {
      const w = c.deps.filter((x) => byId[x].s.status !== "PASS")
      sub = `espera ${w.length === 1 ? esc(w[0]) : w.length + " dependencias"}`
    } else
      sub = `${esc(LABEL[st] ?? st)}${s.attempts?.length ? ` · ${s.attempts.length} intentos` : ""}${cost != null ? ` · ${usd(cost)}` : ""}`
    const reason =
      st !== "PASS" && st !== "RUNNING" && st !== "PENDING" && s.reason
        ? `<div class="reason">${esc(cut(String(s.reason).split("\n")[0], 140))}</div>`
        : ""
    return `<div class="node ${k} x" data-detail="c-${esc(c.id)}">${icon(stateIcon(st))}<div class="id">${esc(c.id)}</div><div class="s">${sub}</div>${reason}</div>`
  }
  const cols = [
    ["wait", "circle", "Pendiente", "No hay contratos pendientes"],
    ["run", "loader", "En curso", "No hay contratos en curso"],
    ["ok", "checkc", "Pasó", "Ningún contrato ha pasado"],
    ["bad", "xc", "Falló", "No hay contratos fallidos"],
  ]
    .map(([k, icn, name, none]) => {
      const items = contracts.filter((c) => cls(c.s.status) === k)
      return `<div class="col"><div class="ch ${k}">${icon(icn)}${name} <i>${items.length}</i></div>${items.length ? items.map(card).join("") : `<div class="none">${none}</div>`}</div>`
    })
    .join("")
  return `<div class="panel"><div class="panel-h"><span>Contratos por estado</span><span>clic en una tarjeta abre su detalle</span></div><div class="board">${cols}</div></div>`
}

// ---- models: the two ladders and one table per role ----
function modelsTab(d, { models, ladders = {} }) {
  const { perRole, costs } = d
  const table = (role, title, unit) => {
    const rows = Object.entries(perRole[role])
      .map(([m, v]) => {
        const cost = costs?.byModel?.[role]?.[short(m)]
        const pct = v.attempts ? Math.round((100 * v.passed) / v.attempts) : 0
        return `<tr><td class="mono">${esc(short(m))}</td><td class="num">${v.attempts}</td><td class="num">${v.passed}</td><td class="num">${pct} %${bar(pct, rateColor(v.attempts, pct))}${v.attempts < 3 ? '<div class="q">menos de 3 intentos</div>' : ""}</td><td class="num">${cost ? usd(cost.cost) : "–"}</td><td class="num">${cost ? cost.sessions : "–"}</td><td class="num">${cost?.ms ? mins(cost.ms) : "–"}</td><td class="num">${cost?.ms && cost.sessions ? mins(cost.ms / cost.sessions) : "–"}</td></tr>`
      })
      .join("")
    return `<div class="panel"><table><tr><th>${title} · ${unit}</th><th class="num">Intentos</th><th class="num">Pasó</th><th class="num">Tasa</th><th class="num">Coste</th><th class="num">Sesiones</th><th class="num">Tiempo</th><th class="num">Por sesión</th></tr>${rows || `<tr><td colspan="8" class="empty">Sin datos todavía.</td></tr>`}</table></div>`
  }
  const cards = `<div class="mcards"><div>${icon("wrench")}<div class="k">Escalera builder</div><div class="v mono">${esc((ladders.builder ?? []).map(short).join(" › "))}</div></div><div>${icon("flask")}<div class="k">Escalera researcher</div><div class="v mono">${esc((ladders.researcher ?? []).map(short).join(" › "))}</div></div><div>${icon("branch")}<div class="k">Regla</div><div class="v">2 intentos por peldaño · ${models?.max_models_per_item ?? 3} peldaños por ítem</div><div class="s">si un modelo te falla seguido, bájalo en models.json</div></div></div>`
  return `${cards}${table("builder", "Builders", "contratos")}${table("researcher", "Researchers", "preguntas")}<div class="foot"><span>Intentos y tasa: report.json y research/status.json · coste, sesiones y tiempo: el evento final de cada llamada a claude -p</span><span>Coste equivalente API · no representa necesariamente un cobro real</span></div>`
}

// ---- hidden details for the modal: one per contract, one per report ----
function details(d) {
  const c = d.contracts.map(
    (x) =>
      `<div hidden id="c-${esc(x.id)}" data-title="${esc(x.id)}" data-cls="${cls(x.s.status)}" data-icon="${stateIcon(x.s.status)}" data-sub="${esc(LABEL[x.s.status] ?? x.s.status)}">${contractDetail(d, x.id)}</div>`,
  )
  const r = Object.entries(d.reportsHtml).map(([id, html]) => {
    const res = d.researchResults[id]
    return `<div hidden id="r-${esc(id)}" data-title="${esc(id)}" data-cls="acc" data-icon="flask" data-sub="${esc(res ? `${LABEL[res.status] ?? res.status} · ${short(res.model)} · ${res.steps} pasos` : "informe")}"><div class="md">${html}</div></div>`
  })
  return c.concat(r).join("")
}

const SCRIPT = `<script>
// The page reloads itself: keep the chosen tab (URL hash), the scroll, the
// graph's horizontal scroll and the highlighted path. Clicks open details
// in a modal; clicking a graph node lights its whole path.
(function(){
  try {
    var m = (location.hash || "#" + (sessionStorage.getItem("board-tab") || "")).match(/^#(t[1-4])$/); if (m) { var r = document.getElementById(m[1]); if (r) r.checked = true }
    document.querySelectorAll('input[name="tb"]').forEach(function (r) { r.addEventListener("change", function () { history.replaceState(null, "", "#" + r.id); sessionStorage.setItem("board-tab", r.id); sessionStorage.setItem("board-scroll", "0") }) })
    var y = Number(sessionStorage.getItem("board-scroll") || 0); if (y) window.scrollTo(0, y)
    window.addEventListener("scroll", function () { sessionStorage.setItem("board-scroll", String(window.scrollY)) }, { passive: true })
    document.querySelectorAll(".graph").forEach(function (g, i) { var k = "board-graph-x-" + i; var x = Number(sessionStorage.getItem(k) || 0); if (x) g.scrollLeft = x; g.addEventListener("scroll", function () { sessionStorage.setItem(k, String(g.scrollLeft)) }, { passive: true }) })
    // modal
    var modal = document.getElementById("modal"), mb = document.getElementById("mb"), mt = document.getElementById("mt"), ms = document.getElementById("ms"), mh = document.getElementById("mh"), mx = document.getElementById("mx")
    function closeM() { modal.classList.remove("on"); sessionStorage.removeItem("board-modal") }
    function openM(id) { var src = document.getElementById(id); if (!src) return; mb.innerHTML = src.innerHTML; mt.textContent = src.dataset.title; ms.textContent = src.dataset.sub || ""; mh.className = "mh " + (src.dataset.cls || ""); mh.querySelector("use").setAttribute("href", "#i-" + (src.dataset.icon || "file")); modal.classList.add("on"); sessionStorage.setItem("board-modal", id); mx.focus() }
    mx.addEventListener("click", closeM); modal.addEventListener("click", function (e) { if (e.target === modal) closeM() }); document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeM() })
    document.querySelectorAll("[data-detail]").forEach(function (el) { el.addEventListener("click", function () { openM(el.dataset.detail) }) })
    var openId = sessionStorage.getItem("board-modal"); if (openId) openM(openId)
    // graph path
    var dep = document.getElementById("dep")
    if (dep) {
      var nodes = [].slice.call(dep.querySelectorAll(".gn")), edges = [].slice.call(dep.querySelectorAll(".edge")), deps = {}
      nodes.forEach(function (n) { deps[n.dataset.id] = n.dataset.deps ? n.dataset.deps.split(",") : [] })
      function up(id, set) { (deps[id] || []).forEach(function (d) { if (!set.has(d)) { set.add(d); up(d, set) } }) }
      function down(id, set) { Object.keys(deps).forEach(function (k) { if (deps[k].indexOf(id) >= 0 && !set.has(k)) { set.add(k); down(k, set) } }) }
      function clear() { dep.classList.remove("sel"); nodes.concat(edges).forEach(function (x) { x.classList.remove("lit") }); sessionStorage.removeItem("board-path") }
      function light(id) { clear(); var set = new Set([id]); up(id, set); down(id, set); dep.classList.add("sel"); nodes.forEach(function (x) { if (set.has(x.dataset.id)) x.classList.add("lit") }); edges.forEach(function (x) { if (set.has(x.dataset.from) && set.has(x.dataset.to)) x.classList.add("lit") }); sessionStorage.setItem("board-path", id) }
      nodes.forEach(function (n) { n.addEventListener("click", function (e) { e.stopPropagation(); if (sessionStorage.getItem("board-path") === n.dataset.id) clear(); else light(n.dataset.id) }) })
      dep.addEventListener("click", clear)
      var lit = sessionStorage.getItem("board-path"); if (lit && deps[lit]) light(lit)
    }
  } catch (e) {}
})()
</script>`

// ---- the page ----
export function renderBoard(d, given) {
  const args = { ...given, now: given.now ?? Date.now() }
  const { root, alive, researchAlive, now } = args
  const { contracts, passed, researchResults, phase, phaseCls } = d
  const badge = (n, k = "") => `<span class="n ${k}">${n}</span>`
  const refresh = alive || researchAlive ? 10 : 30
  const done = Object.values(researchResults).filter((r) => r.status === "DONE").length
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${refresh}"><title>Avance · ${esc(root.split("/").pop())}</title>
<style>
${css()}</style></head><body>${sprite()}<div class="wrap">
${header(d, args)}
${strip(d, args)}
<input type="radio" name="tb" id="t1" checked><input type="radio" name="tb" id="t2"><input type="radio" name="tb" id="t3"><input type="radio" name="tb" id="t4">
<div class="tabs"><label for="t1">${icon("activity")}Ahora ${phaseCls === "run" ? badge(esc(phase), "run") : phaseCls === "you" ? badge("te espera", "bad") : ""}</label><label for="t2">${icon("flask")}Research ${badge(`${done}/${Object.keys(researchResults).length}`, researchAlive ? "run" : "")}</label><label for="t3">${icon("checksq")}Contratos ${badge(`${passed}/${contracts.length}`, passed === contracts.length && contracts.length ? "ok" : "")}</label><label for="t4">${icon("chart")}Modelos y coste</label></div>
<div class="pane p1">${runningPanel(d, args)}${journal(d)}</div>
<div class="pane p2">${researchTable(d)}</div>
<div class="pane p3">${graph(d)}${kanban(d, args)}</div>
<div class="pane p4">${modelsTab(d, args)}</div>
</div>
${details(d)}
<div class="modal" id="modal" role="dialog" aria-modal="true"><div class="mbox"><div class="mh" id="mh">${icon("file")}<b id="mt"></b><span class="sub" id="ms"></span><button class="mx" id="mx" aria-label="Cerrar">×</button></div><div class="mb" id="mb"></div></div></div>
${SCRIPT}
</body></html>`
}
