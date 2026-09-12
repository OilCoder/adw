// Draws .codegen/board.html from the facts in board.mjs: a self-refreshing
// tabbed page. "Ahora" shows the phase, what is running and the journal; the
// other tabs show contracts (graph + board), research and models/cost. One
// function per section, each returning a string; the styles are board.css,
// inlined so the page stays a single file. No data is computed here: if a
// section needs a number, boardData provides it.

import { readFileSync } from "node:fs"
import { LABEL, esc, cls, short, mins, hhmm, day, usd, cut } from "./board.mjs"

const css = () => readFileSync(new URL("./board.css", import.meta.url), "utf8")

// ---- the five facts at the top ----
function strip(d) {
  const { phase, phaseCls, phaseSub, sup, supAgo, passed, contracts, lastMerge, waitingText, costs } = d
  return `<div class="strip">
    <div><div class="k">Fase</div><div class="v ${phaseCls}">${phaseCls === "run" ? '<span class="pulse"></span>' : ""}${phase}</div><div class="sub">${esc(phaseSub)}</div></div>
    <div><div class="k">Supervisor</div><div class="v">${sup?.last ? `hace ${mins(supAgo)}` : "–"}</div><div class="sub">${sup?.last ? esc(`${hhmm(sup.last.at)} · ${sup.last.kind === "text" ? "te respondió" : sup.last.kind === "thinking" ? "pensando" : cut(sup.last.text, 60)}`) : "sin sesión de OpenCode aquí"}</div></div>
    <div><div class="k">Contratos</div><div class="v ${passed && passed === contracts.length ? "ok" : ""}">${passed}<small>de ${contracts.length} pasaron</small></div><div class="sub">${lastMerge ? `en master: ${lastMerge.commits} commits · ${hhmm(lastMerge.at)}` : contracts.length ? "nada aterrizado aún" : "sin plan"}</div></div>
    <div><div class="k">Te espera</div><div class="v ${waitingText ? "you" : ""}">${waitingText ? "sí" : "nada"}</div><div class="sub">${waitingText ? esc(cut(waitingText, 90)) : sup?.userMessages?.length ? `tu último mensaje: ${hhmm(sup.userMessages.at(-1).at)}` : ""}</div></div>
    <div><div class="k">Coste Go</div><div class="v">${costs ? usd(costs.total) : "–"}</div><div class="sub">${
      costs
        ? esc(
            Object.entries(costs.byRole)
              .map(([r, c]) => `${r} ${usd(c)}`)
              .join(" · "),
          )
        : "base de OpenCode no disponible"
    }</div></div>
  </div>`
}

// ---- what is running right now: builder cards and researcher cards ----
function runningPanel(d, { researchRun, now }) {
  const cards = []
  for (const c of d.running)
    cards.push(
      `<div class="card run"><div class="id">● ${esc(c.id)}</div><div class="t">${esc(cut(c.title ?? c.s.objective ?? "", 110))}</div><div class="m"><span>builder · ${esc(short(c.s.model))}</span><span>intento ${c.s.attempt ?? 1}</span><span>${c.s.started ? mins(now - new Date(c.s.started).getTime()) : ""}</span></div></div>`,
    )
  for (const id of d.researchRunning) {
    const q = d.lastStartQuestions.find((x) => x.id === id)
    cards.push(
      `<div class="card run sq"><div class="id">■ ${esc(id)}</div><div class="t">${esc(cut(q?.question ?? "", 110))}</div><div class="m"><span>researcher</span><span>${mins(now - new Date(researchRun.started).getTime())}</span></div></div>`,
    )
  }
  return cards.length
    ? `<div class="panel"><div class="panel-h"><span>Corriendo ahora</span><span>${cards.length}</span></div><div class="cards">${cards.join("")}</div></div>`
    : ""
}

// ---- one journal entry: shape and colour by kind, text by kind ----
function journalEntry(j) {
  const e = j.e
  switch (j.kind) {
    case "contract":
      return {
        shape: "dot",
        cls: e.status === "PASS" ? "ok" : "bad",
        html: `<b>${esc(e.id)}</b> · builder · ${esc((e.models ?? [e.model]).map(short).join(" › "))} · ${esc(cut(e.title ?? e.objective, 120))} <span class="m">${e.status === "PASS" ? `${e.attempts} intento${e.attempts > 1 ? "s" : ""}, ${e.files} archivos` : `${esc(LABEL[e.status] ?? e.status)} tras ${e.attempts} intentos${e.detail ? ": " + esc(cut(e.detail, 100)) : ""}`}</span>`,
      }
    case "research":
      return {
        shape: "sq",
        cls: cls(e.status),
        html: `<b>${esc(e.id)}</b> · researcher · ${esc((e.models ?? [e.model]).map(short).join(" › "))} · ${esc(cut(e.question, 120))} <span class="m">${esc(LABEL[e.status] ?? e.status)}, ${e.steps} pasos${e.one_shot ? ", escrito de una vez" : ""}</span>`,
      }
    case "reject":
      return {
        shape: "sq",
        cls: "bad",
        html: `<b>${esc(e.id)}</b> · informe de ${esc(short(e.model))} rechazado por el supervisor, se relanza con el siguiente modelo`,
      }
    case "research-start":
      return {
        shape: "sq",
        cls: "run",
        html: `Research: ${e.questions.length} pregunta${e.questions.length > 1 ? "s" : ""} <span class="m">${esc(e.questions.map((q) => q.id).join(", "))}</span>`,
      }
    case "notify":
      return {
        shape: "dia",
        cls: e.delivered ? "wait" : "bad",
        html: `<b>Aviso al supervisor${e.delivered ? "" : ` (no entregado: ${esc(e.reason ?? "sin sesión")})`}:</b> ${esc(cut(e.text, 160))}`,
      }
    case "seal":
      return { shape: "dot", cls: "wait", html: `Plan sellado: ${e.contracts} contratos` }
    case "build-start":
      return {
        shape: "dot",
        cls: "run",
        html: `Build iniciado: ${e.contracts} contratos, paralelo ${e.parallel} <span class="m">${esc(e.run)}</span>`,
      }
    case "build-resume":
      return {
        shape: "dot",
        cls: "run",
        html: `Build reanudado${e.only ? ` (${esc(e.only.join(", "))})` : ""}, paralelo ${e.parallel}`,
      }
    case "build-end":
      return {
        shape: "dot",
        cls: e.passed === e.total ? "ok" : "bad",
        html: `Build terminado: ${e.passed} de ${e.total} contratos pasaron`,
      }
    case "merge":
      return {
        shape: "dot",
        cls: "merge",
        html: `<b>Aterrizado en ${esc(e.branch)}</b>: ${e.commits} commits (${e.how})${e.pending ? `, ${e.pending} contratos pendientes` : ""}`,
      }
    case "user":
      return { shape: "dia", cls: "you", html: `<b>Tú:</b> ${esc(cut(j.text, 160))}` }
    case "waiting":
      return { shape: "dia", cls: "you", html: `<b>Supervisor te espera:</b> ${esc(cut(j.text, 200))}` }
    default:
      return null
  }
}

// ---- the journal: newest first, grouped by day, 80 entries ----
function journal(d) {
  const entries = d.journal.map((j) => ({ at: j.at, ...journalEntry(j) })).filter((e) => e.html)
  let lastDay = ""
  const rows = entries
    .slice(0, 80)
    .map((e) => {
      const dd = day(e.at)
      const head = dd !== lastDay ? `<div class="jday">${esc(dd)}</div>` : ""
      lastDay = dd
      return `${head}<div class="j ${e.cls}"><div class="t">${hhmm(e.at)}</div><div class="s ${e.shape}"></div><div class="x">${e.html}</div></div>`
    })
    .join("")
  return `<div class="panel"><div class="panel-h"><span>Diario</span><span>${entries.length} entradas · ● contrato ■ research ◆ tú</span></div><div class="journal">${rows || '<div class="empty">Sin eventos todavía.</div>'}</div></div>`
}

// ---- the dependency graph as SVG: lanes per layer, edges, one node per contract ----
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
      svg += `<path class="${k}" d="M${x1},${a.y} C${mx},${a.y} ${mx},${b.y} ${x2},${b.y}"/>`
    }),
  )
  contracts.forEach((c) => {
    const p = pos[c.id],
      st = c.s.status,
      k = cls(st)
    const sub =
      st === "RUNNING"
        ? `● ${short(c.s.model)} · int. ${c.s.attempt ?? 1}`
        : st === "PASS"
          ? `${short(c.s.model)} · ${c.s.attempts?.length ?? 1} int.`
          : (LABEL[st] ?? st)
    svg += `<g><title>${esc(c.id)} — ${esc(c.title ?? "")}\n${esc(sub)}</title><rect class="node ${k}" x="${p.x}" y="${p.y - 17}" width="${NW}" height="34" rx="4"/><text x="${p.x + 8}" y="${p.y - 3}">${esc(cut(c.id, 20))}</text><text class="lbl2" x="${p.x + 8}" y="${p.y + 10}">${esc(cut(sub, 24))}</text></g>`
  })
  return `<div class="panel"><div class="panel-h"><span>Dependencias · qué frena qué</span><span>${contracts.length} contratos</span></div><div class="graph"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafo de dependencias">${svg}</svg></div><div class="legend"><span style="--c:var(--ok)">pasó</span><span style="--c:var(--run)">construyendo</span><span style="--c:var(--bad)">falló</span><span style="--c:var(--wait)">esperando</span><span style="--c:var(--accent)">camino crítico</span></div></div>`
}

// ---- contracts by state, four columns ----
function kanban(d, { now }) {
  const { contracts, byId, costs } = d
  const card = (c) => {
    const s = c.s,
      st = s.status,
      k = cls(st),
      cost = costs?.byContract?.[c.id]
    let meta
    if (st === "RUNNING")
      meta = `<span><span class="pulse"></span>${esc(short(s.model))}</span><span>intento ${s.attempt ?? 1}</span><span>${s.started ? mins(now - new Date(s.started).getTime()) : ""}</span>`
    else if (st === "PASS")
      meta = `<span>${esc(short(s.model))}</span><span>${s.attempts?.length ?? 1} intento${(s.attempts?.length ?? 1) > 1 ? "s" : ""}</span><span>${s.duration_ms ? mins(s.duration_ms) : ""}</span>${cost != null ? `<span>${usd(cost)}</span>` : ""}`
    else if (st === "PENDING") {
      const w = c.deps.filter((x) => byId[x].s.status !== "PASS")
      meta = `<span>espera ${w.length === 1 ? esc(w[0]) : w.length + " dependencias"}</span>`
    } else
      meta = `<span>${esc(LABEL[st] ?? st)}</span>${s.attempts?.length ? `<span>${s.attempts.length} intentos</span>` : ""}${cost != null ? `<span>${usd(cost)}</span>` : ""}${s.reason ? `<span class="reason">${esc(cut(String(s.reason).split("\n")[0], 140))}</span>` : ""}`
    return `<div class="card ${k}"><div class="id">${esc(c.id)}</div><div class="t">${esc(c.title ?? "")}</div><div class="m">${meta}</div></div>`
  }
  const cols = [
    ["wait", "Pendiente"],
    ["run", "En curso"],
    ["ok", "Pasó"],
    ["bad", "Falló"],
  ]
    .map(([k, name]) => {
      const items = contracts.filter((c) => cls(c.s.status) === k)
      return `<div class="col"><div class="col-h"><span class="eyebrow">${name}</span><span class="n">${items.length}</span></div>${items.map(card).join("")}</div>`
    })
    .join("")
  return `<div class="panel"><div class="panel-h"><span>Contratos por estado</span></div><div class="board">${cols}</div></div>`
}

// ---- research: one table, grouped by run ----
function researchTable(d) {
  const { researchResults, researchRuns, questionText } = d
  const rows = Object.keys(researchResults).length
    ? researchRuns
        .map(
          ([run, rows]) =>
            `<tr class="grp"><td colspan="5">TANDA ${esc(run)}</td></tr>${rows.map(([id, r]) => `<tr><td class="mono"><b>${esc(id)}</b><div class="q">${esc(cut(questionText[id] ?? "", 140))}</div></td><td><span class="pill ${cls(r.status)}">${esc(r.status)}</span>${r.rejected?.length ? `<div class="q">sin informe con: ${esc(r.rejected.map(short).join(", "))}</div>` : ""}</td><td class="mono">${esc(short(r.model))}</td><td class="num">${r.steps ?? ""}</td><td class="mono">${esc(r.report ?? "")}</td></tr>`).join("")}`,
        )
        .join("")
    : null
  return rows
    ? `<table class="rs"><colgroup><col style="width:44%"><col style="width:20%"><col style="width:12%"><col style="width:6%"><col style="width:18%"></colgroup><tr><th>Pregunta</th><th>Estado</th><th>Modelo</th><th>Pasos</th><th>Informe</th></tr>${rows}</table>`
    : `<div class="empty">Sin research todavía.</div>`
}

// ---- models: the two ladders and one table per role ----
function modelsTab(d, { models, ladders = {} }) {
  const { perRole, costs } = d
  const table = (role, title) => {
    const rows = Object.entries(perRole[role])
      .map(([m, v]) => {
        const cost = costs?.byModel?.[role]?.[short(m)]
        return `<tr><td class="mono">${esc(short(m))}</td><td class="num">${v.attempts}</td><td class="num">${v.passed}</td><td class="num">${v.attempts ? Math.round((100 * v.passed) / v.attempts) : 0} %</td><td class="num">${cost ? usd(cost.cost) : "–"}</td><td class="num">${cost ? cost.sessions : "–"}</td><td class="num">${cost?.ms ? mins(cost.ms) : "–"}</td><td class="num">${cost?.ms && cost.sessions ? mins(cost.ms / cost.sessions) : "–"}</td></tr>`
      })
      .join("")
    return `<div class="group">${title}</div><table><tr><th>Modelo</th><th class="num">Intentos</th><th class="num">Pasó</th><th class="num">Tasa</th><th class="num">Coste</th><th class="num">Sesiones</th><th class="num">Tiempo</th><th class="num">Por sesión</th></tr>${rows || `<tr><td colspan="8" class="empty">Sin datos todavía.</td></tr>`}</table>`
  }
  return `<div class="strip s3"><div><div class="k">Escalera builder</div><div class="v sm">${esc((ladders.builder ?? []).map(short).join(" › "))}</div></div><div><div class="k">Escalera researcher</div><div class="v sm">${esc((ladders.researcher ?? []).map(short).join(" › "))}</div></div><div><div class="k">Regla</div><div class="v sm">2 intentos por peldaño · ${models?.max_models_per_item ?? 3} peldaños por ítem · si un modelo te falla seguido, bájalo en models.json</div></div></div>
    ${table("builder", "BUILDERS · contratos")}
    ${table("researcher", "RESEARCHERS · preguntas")}
    <div class="q" style="padding:8px 16px 12px">Intentos y tasa salen de report.json; coste, sesiones y tiempo (inicio a fin de cada sesión) de la base de datos de OpenCode (solo lectura, sin llamadas a modelos).</div>`
}

// ---- the page: head, title line, strip, tabs, four panes, the script that keeps tab and scroll ----
export function renderBoard(d, args) {
  const { root, current, alive, researchAlive, now = Date.now() } = args
  const { contracts, passed, researchResults, phase, phaseCls } = d
  const badge = (n, k = "") => `<span class="n ${k}">${n}</span>`
  const refresh = alive || researchAlive ? 10 : 30
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${refresh}"><title>Avance · ${esc(root.split("/").pop())}</title>
<style>
${css()}</style></head><body><div class="wrap">
<h1>Avance de ${esc(root.split("/").pop())}</h1>
<div class="subt">${esc(current?.integration ?? "sin rama de integración")} · actualizado ${hhmm(now)} · se refresca cada ${refresh} s</div>
${strip(d)}
<input type="radio" name="tb" id="t1" checked><input type="radio" name="tb" id="t2"><input type="radio" name="tb" id="t3"><input type="radio" name="tb" id="t4">
<div class="tabs"><label for="t1">Ahora ${phaseCls === "run" ? badge(phase, "run") : phaseCls === "you" ? badge("te espera", "bad") : ""}</label><label for="t2">Contratos ${badge(`${passed}/${contracts.length}`, passed === contracts.length && contracts.length ? "ok" : "")}</label><label for="t3">Research ${badge(`${Object.values(researchResults).filter((r) => r.status === "DONE").length}/${Object.keys(researchResults).length}`, researchAlive ? "run" : "")}</label><label for="t4">Modelos y coste</label></div>
<div class="pane p1">${runningPanel(d, args)}${journal(d)}</div>
<div class="pane p2">${graph(d)}${kanban(d, args)}</div>
<div class="pane p3">${researchTable(d)}</div>
<div class="pane p4">${modelsTab(d, args)}</div>
</div>
<script>
// The page reloads itself; keep the chosen tab (in the URL hash) and the scroll position.
(function(){
  try {
    var m = (location.hash || "#" + (sessionStorage.getItem("board-tab") || "")).match(/^#(t[1-4])$/); if (m) { var r = document.getElementById(m[1]); if (r) r.checked = true }
    document.querySelectorAll('input[name="tb"]').forEach(function (r) { r.addEventListener("change", function () { history.replaceState(null, "", "#" + r.id); sessionStorage.setItem("board-tab", r.id); sessionStorage.setItem("board-scroll", "0") }) })
    var y = Number(sessionStorage.getItem("board-scroll") || 0); if (y) window.scrollTo(0, y)
    window.addEventListener("scroll", function () { sessionStorage.setItem("board-scroll", String(window.scrollY)) }, { passive: true })
    // Horizontal scroll of the dependency graph survives reloads too.
    document.querySelectorAll(".graph").forEach(function (g, i) { var k = "board-graph-x-" + i; var x = Number(sessionStorage.getItem(k) || 0); if (x) g.scrollLeft = x; g.addEventListener("scroll", function () { sessionStorage.setItem(k, String(g.scrollLeft)) }, { passive: true }) })
  } catch (e) {}
})()
</script>
</body></html>`
}
