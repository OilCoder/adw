// Writes .codegen/board.html: a self-refreshing tabbed page. "Ahora" shows
// the phase, what is running and the journal; the other tabs show contracts
// (graph + board), research and models/cost. Pure function of the files the
// script writes plus a read-only look at OpenCode's database.

import { supervisorActivity, agentCosts } from "./opencode-db.mjs"

const CLASS = { PASS: "ok", RUNNING: "run", PENDING: "wait", NOT_SELECTED: "wait", DONE: "ok", PARTIAL: "run", REJECTED: "bad" }
const LABEL = {
  PASS: "pasó", RUNNING: "construyendo", PENDING: "esperando", NOT_SELECTED: "no seleccionado", FAIL: "falló",
  GATE_FAIL: "gate falló", OUT_OF_SCOPE: "fuera de alcance", PROTECTED_TOUCHED: "tocó protegidos", STRUCTURE: "rompe el mapa", NO_CHANGES: "sin cambios",
  TIMEOUT: "timeout", NO_MODELS: "sin modelos", GATE_TRIVIAL: "gate trivial", MERGE_CONFLICT: "conflicto de merge", SKIPPED: "omitido", INSTALL_FAILED: "npm ci falló",
  STOPPED: "detenido", ERROR: "error", DONE: "informe completo", PARTIAL: "informe parcial", NO_REPORT: "sin informe", REJECTED: "rechazado",
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
const cls = (st) => CLASS[st] ?? "bad"
const short = (m) => String(m ?? "").replace(/^[^/]+\//, "")
const mins = (ms) => (ms < 60000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${Math.floor(ms / 3600000)} h ${Math.round((ms % 3600000) / 60000)} min`)
const hhmm = (t) => new Date(t).toLocaleTimeString("es", { hour12: false, hour: "2-digit", minute: "2-digit" })
const day = (t) => new Date(t).toLocaleDateString("es", { weekday: "short", day: "2-digit", month: "short" })
const usd = (n) => `$${(n ?? 0).toFixed(2)}`
const cut = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s }

export function renderBoard({ root, sandboxes, plan, report, current, research, alive, researchRun, researchAlive, events = [], models, ladders = {}, now = Date.now() }) {
  const contracts = (plan?.contracts ?? []).map((c) => ({ ...c, deps: c.depends_on ?? [], s: report?.contracts?.[c.id] ?? { status: "PENDING" } }))
  const byId = Object.fromEntries(contracts.map((c) => [c.id, c]))
  const passed = contracts.filter((c) => c.s.status === "PASS").length
  const running = contracts.filter((c) => c.s.status === "RUNNING")
  const failed = contracts.filter((c) => !["PASS", "RUNNING", "PENDING", "NOT_SELECTED", "SKIPPED"].includes(c.s.status))
  const sup = supervisorActivity(root)
  const costs = agentCosts(root, sandboxes)
  const researchResults = research?.results ?? {}
  const researchRunning = researchAlive ? (researchRun?.questions ?? []).filter((id) => !researchResults[id] || new Date(researchResults[id].at ?? 0) < new Date(researchRun.started)) : []

  // ---- phase ----
  const lastMerge = [...events].reverse().find((e) => e.kind === "merge")
  const supAgo = sup?.last ? now - sup.last.at : null
  let phase, phaseCls, phaseSub
  if (researchAlive) { phase = "investigando"; phaseCls = "run"; phaseSub = `desde ${hhmm(researchRun.started)} · ${mins(now - new Date(researchRun.started).getTime())} · ${researchRun.questions?.length ?? 0} preguntas` }
  else if (alive) { phase = "construyendo"; phaseCls = "run"; phaseSub = `desde ${hhmm(current.started)} · ${mins(now - new Date(current.started).getTime())} · ${running.length} en paralelo` }
  else if (sup?.last && supAgo < 3 * 60000 && sup.last.kind !== "text") { phase = "supervisor trabajando"; phaseCls = "run"; phaseSub = `última acción hace ${mins(supAgo)}` }
  else if (sup?.waiting && !alive && !researchAlive) { phase = "te espera"; phaseCls = "you"; phaseSub = `desde ${hhmm(sup.last.at)} · ${mins(supAgo)}` }
  else if (current && !current.finished && Object.values(report?.contracts ?? {}).some((c) => c.status === "RUNNING")) { phase = "detenido"; phaseCls = "bad"; phaseSub = "el build murió con contratos en curso; reanuda con --resume" }
  else { phase = "parado"; phaseCls = ""; phaseSub = sup?.last ? `supervisor inactivo hace ${mins(supAgo)}` : "sin actividad registrada" }
  // The supervisor only "waits" when nothing is running: a status report
  // written while a build or research is alive is not a question for the user.
  const waitingText = sup?.waiting && !alive && !researchAlive ? cut(sup.waiting, 220) : null

  const strip = `<div class="strip">
    <div><div class="k">Fase</div><div class="v ${phaseCls}">${phaseCls === "run" ? '<span class="pulse"></span>' : ""}${phase}</div><div class="sub">${esc(phaseSub)}</div></div>
    <div><div class="k">Supervisor</div><div class="v">${sup?.last ? `hace ${mins(supAgo)}` : "–"}</div><div class="sub">${sup?.last ? esc(`${hhmm(sup.last.at)} · ${sup.last.kind === "text" ? "te respondió" : sup.last.kind === "thinking" ? "pensando" : cut(sup.last.text, 60)}`) : "sin sesión de OpenCode aquí"}</div></div>
    <div><div class="k">Contratos</div><div class="v ${passed && passed === contracts.length ? "ok" : ""}">${passed}<small>de ${contracts.length} pasaron</small></div><div class="sub">${lastMerge ? `en master: ${lastMerge.commits} commits · ${hhmm(lastMerge.at)}` : contracts.length ? "nada aterrizado aún" : "sin plan"}</div></div>
    <div><div class="k">Te espera</div><div class="v ${waitingText ? "you" : ""}">${waitingText ? "sí" : "nada"}</div><div class="sub">${waitingText ? esc(cut(waitingText, 90)) : sup?.userMessages?.length ? `tu último mensaje: ${hhmm(sup.userMessages.at(-1).at)}` : ""}</div></div>
    <div><div class="k">Coste Go</div><div class="v">${costs ? usd(costs.total) : "–"}</div><div class="sub">${costs ? esc(Object.entries(costs.byRole).map(([r, c]) => `${r} ${usd(c)}`).join(" · ")) : "base de OpenCode no disponible"}</div></div>
  </div>`

  // ---- running now ----
  const runCards = []
  for (const c of running) runCards.push(`<div class="card run"><div class="id">● ${esc(c.id)}</div><div class="t">${esc(cut(c.title ?? c.s.objective ?? "", 110))}</div><div class="m"><span>builder · ${esc(short(c.s.model))}</span><span>intento ${c.s.attempt ?? 1}</span><span>${c.s.started ? mins(now - new Date(c.s.started).getTime()) : ""}</span></div></div>`)
  for (const id of researchRunning) {
    const q = (events.slice().reverse().find((e) => e.kind === "research-start")?.questions ?? []).find((x) => x.id === id)
    runCards.push(`<div class="card run sq"><div class="id">■ ${esc(id)}</div><div class="t">${esc(cut(q?.question ?? "", 110))}</div><div class="m"><span>researcher</span><span>${mins(now - new Date(researchRun.started).getTime())}</span></div></div>`)
  }
  const runningPanel = runCards.length ? `<div class="panel"><div class="panel-h"><span>Corriendo ahora</span><span>${runCards.length}</span></div><div class="cards">${runCards.join("")}</div></div>` : ""

  // ---- journal: script events + user messages + supervisor questions ----
  const entries = []
  for (const e of events) {
    const at = new Date(e.at).getTime()
    if (e.kind === "contract") entries.push({ at, shape: "dot", cls: e.status === "PASS" ? "ok" : "bad", html: `<b>${esc(e.id)}</b> · builder · ${esc((e.models ?? [e.model]).map(short).join(" › "))} · ${esc(cut(e.title ?? e.objective, 120))} <span class="m">${e.status === "PASS" ? `${e.attempts} intento${e.attempts > 1 ? "s" : ""}, ${e.files} archivos` : `${esc(LABEL[e.status] ?? e.status)} tras ${e.attempts} intentos${e.detail ? ": " + esc(cut(e.detail, 100)) : ""}`}</span>` })
    else if (e.kind === "research") entries.push({ at, shape: "sq", cls: cls(e.status), html: `<b>${esc(e.id)}</b> · researcher · ${esc((e.models ?? [e.model]).map(short).join(" › "))} · ${esc(cut(e.question, 120))} <span class="m">${esc(LABEL[e.status] ?? e.status)}, ${e.steps} pasos</span>` })
    else if (e.kind === "reject") entries.push({ at, shape: "sq", cls: "bad", html: `<b>${esc(e.id)}</b> · informe de ${esc(short(e.model))} rechazado por el supervisor, se relanza con el siguiente modelo` })
    else if (e.kind === "research-start") entries.push({ at, shape: "sq", cls: "run", html: `Research: ${e.questions.length} pregunta${e.questions.length > 1 ? "s" : ""} <span class="m">${esc(e.questions.map((q) => q.id).join(", "))}</span>` })
    else if (e.kind === "notify") entries.push({ at, shape: "dia", cls: e.delivered ? "wait" : "bad", html: `<b>Aviso al supervisor${e.delivered ? "" : " (sin sesión, no entregado)"}:</b> ${esc(cut(e.text, 160))}` })
    else if (e.kind === "seal") entries.push({ at, shape: "dot", cls: "wait", html: `Plan sellado: ${e.contracts} contratos` })
    else if (e.kind === "build-start") entries.push({ at, shape: "dot", cls: "run", html: `Build iniciado: ${e.contracts} contratos, paralelo ${e.parallel} <span class="m">${esc(e.run)}</span>` })
    else if (e.kind === "build-resume") entries.push({ at, shape: "dot", cls: "run", html: `Build reanudado${e.only ? ` (${esc(e.only.join(", "))})` : ""}, paralelo ${e.parallel}` })
    else if (e.kind === "build-end") entries.push({ at, shape: "dot", cls: e.passed === e.total ? "ok" : "bad", html: `Build terminado: ${e.passed} de ${e.total} contratos pasaron` })
    else if (e.kind === "merge") entries.push({ at, shape: "dot", cls: "merge", html: `<b>Aterrizado en ${esc(e.branch)}</b>: ${e.commits} commits (${e.how})${e.pending ? `, ${e.pending} contratos pendientes` : ""}` })
  }
  for (const u of sup?.userMessages ?? []) entries.push({ at: u.at, shape: "dia", cls: "you", html: `<b>Tú:</b> ${esc(cut(u.text, 160))}` })
  if (waitingText) entries.push({ at: sup.last.at, shape: "dia", cls: "you", html: `<b>Supervisor te espera:</b> ${esc(cut(waitingText, 200))}` })
  entries.sort((a, b) => b.at - a.at)
  let lastDay = ""
  const journal = entries.slice(0, 80).map((e) => {
    const d = day(e.at); const head = d !== lastDay ? `<div class="jday">${esc(d)}</div>` : ""; lastDay = d
    return `${head}<div class="j ${e.cls}"><div class="t">${hhmm(e.at)}</div><div class="s ${e.shape}"></div><div class="x">${e.html}</div></div>`
  }).join("")

  // ---- graph ----
  const depth = {}
  const d = (id) => depth[id] ?? (depth[id] = byId[id].deps.length ? 1 + Math.max(...byId[id].deps.map(d)) : 0)
  contracts.forEach((c) => d(c.id))
  const layers = []
  contracts.forEach((c) => (layers[depth[c.id]] ??= []).push(c))
  const NW = 150, colW = NW + 40, rowH = 50, top = 40
  const W = Math.max(colW * layers.length, 300), H = top + rowH * Math.max(1, ...layers.map((l) => l.length)) + 10
  const pos = {}
  layers.forEach((l, li) => { const y0 = top + (H - top - rowH * l.length) / 2 + rowH / 2; l.forEach((c, i) => { pos[c.id] = { x: colW * li + 20, y: y0 + i * rowH } }) })
  const longest = (id) => { const c = byId[id]; if (!c.deps.length) return [id]; return [...c.deps.map(longest).sort((a, b) => b.length - a.length)[0], id] }
  const sinks = contracts.filter((c) => !contracts.some((o) => o.deps.includes(c.id)))
  const crit = new Set(sinks.map((s) => longest(s.id)).sort((a, b) => b.length - a.length)[0] ?? [])
  let svg = ""
  layers.forEach((l, li) => { const x = colW * li; svg += `<line class="lane" x1="${x + 8}" y1="${top - 14}" x2="${x + 8}" y2="${H - 6}"/><text class="lane-lbl" x="${x + 14}" y="${top - 20}">CAPA ${li}</text>` })
  contracts.forEach((c) => c.deps.forEach((dep) => { const a = pos[dep], b = pos[c.id], x1 = a.x + NW, x2 = b.x, mx = (x1 + x2) / 2; const k = byId[dep].s.status === "PASS" && c.s.status !== "PENDING" ? "edge done" : crit.has(dep) && crit.has(c.id) ? "edge crit" : "edge"; svg += `<path class="${k}" d="M${x1},${a.y} C${mx},${a.y} ${mx},${b.y} ${x2},${b.y}"/>` }))
  contracts.forEach((c) => { const p = pos[c.id], st = c.s.status, k = cls(st); const sub = st === "RUNNING" ? `● ${short(c.s.model)} · int. ${c.s.attempt ?? 1}` : st === "PASS" ? `${short(c.s.model)} · ${c.s.attempts?.length ?? 1} int.` : LABEL[st] ?? st; svg += `<g><title>${esc(c.id)} — ${esc(c.title ?? "")}\n${esc(sub)}</title><rect class="node ${k}" x="${p.x}" y="${p.y - 17}" width="${NW}" height="34" rx="4"/><text x="${p.x + 8}" y="${p.y - 3}">${esc(cut(c.id, 20))}</text><text class="lbl2" x="${p.x + 8}" y="${p.y + 10}">${esc(cut(sub, 24))}</text></g>` })

  // ---- contracts board ----
  const card = (c) => {
    const s = c.s, st = s.status, k = cls(st), cost = costs?.byContract?.[c.id]
    let meta
    if (st === "RUNNING") meta = `<span><span class="pulse"></span>${esc(short(s.model))}</span><span>intento ${s.attempt ?? 1}</span><span>${s.started ? mins(now - new Date(s.started).getTime()) : ""}</span>`
    else if (st === "PASS") meta = `<span>${esc(short(s.model))}</span><span>${s.attempts?.length ?? 1} intento${(s.attempts?.length ?? 1) > 1 ? "s" : ""}</span><span>${s.duration_ms ? mins(s.duration_ms) : ""}</span>${cost != null ? `<span>${usd(cost)}</span>` : ""}`
    else if (st === "PENDING") { const w = c.deps.filter((x) => byId[x].s.status !== "PASS"); meta = `<span>espera ${w.length === 1 ? esc(w[0]) : w.length + " dependencias"}</span>` }
    else meta = `<span>${esc(LABEL[st] ?? st)}</span>${s.attempts?.length ? `<span>${s.attempts.length} intentos</span>` : ""}${cost != null ? `<span>${usd(cost)}</span>` : ""}${s.reason ? `<span class="reason">${esc(cut(String(s.reason).split("\n")[0], 140))}</span>` : ""}`
    return `<div class="card ${k}"><div class="id">${esc(c.id)}</div><div class="t">${esc(c.title ?? "")}</div><div class="m">${meta}</div></div>`
  }
  const board = [["wait", "Pendiente"], ["run", "En curso"], ["ok", "Pasó"], ["bad", "Falló"]].map(([k, name]) => { const items = contracts.filter((c) => cls(c.s.status) === k); return `<div class="col"><div class="col-h"><span class="eyebrow">${name}</span><span class="n">${items.length}</span></div>${items.map(card).join("")}</div>` }).join("")

  // ---- research tab ----
  const starts = events.filter((e) => e.kind === "research-start")
  const questionText = {}
  for (const s of starts) for (const q of s.questions) questionText[q.id] = q.question
  const runsOf = {}
  for (const [id, r] of Object.entries(researchResults)) (runsOf[r.run ?? research?.run ?? "?"] ??= []).push([id, r])
  const researchTab = Object.keys(researchResults).length ? Object.entries(runsOf).sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([run, rows]) => `<tr class="grp"><td colspan="5">TANDA ${esc(run)}</td></tr>${rows.map(([id, r]) => `<tr><td class="mono"><b>${esc(id)}</b><div class="q">${esc(cut(questionText[id] ?? "", 140))}</div></td><td><span class="pill ${cls(r.status)}">${esc(r.status)}</span>${r.rejected?.length ? `<div class="q">sin informe con: ${esc(r.rejected.map(short).join(", "))}</div>` : ""}</td><td class="mono">${esc(short(r.model))}</td><td class="num">${r.steps ?? ""}</td><td class="mono">${esc(r.report ?? "")}</td></tr>`).join("")}`).join("") : null
  const researchTable = researchTab ? `<table class="rs"><colgroup><col style="width:44%"><col style="width:20%"><col style="width:12%"><col style="width:6%"><col style="width:18%"></colgroup><tr><th>Pregunta</th><th>Estado</th><th>Modelo</th><th>Pasos</th><th>Informe</th></tr>${researchTab}</table>` : `<div class="empty">Sin research todavía.</div>`

  // ---- models tab ----
  const perRole = { builder: {}, researcher: {} }
  for (const c of contracts) for (const a of c.s.attempts ?? []) { const m = (perRole.builder[a.model] ??= { attempts: 0, passed: 0 }); m.attempts++; if (a.verdict === "PASS") m.passed++ }
  for (const r of Object.values(researchResults)) { if (!r.model) continue; const m = (perRole.researcher[r.model] ??= { attempts: 0, passed: 0 }); m.attempts += r.attempt ?? 1; if (r.status === "DONE") m.passed++ }
  const modelTable = (role, title) => { const rows = Object.entries(perRole[role]).map(([m, v]) => { const cost = costs?.byModel?.[role]?.[short(m)]; return `<tr><td class="mono">${esc(short(m))}</td><td class="num">${v.attempts}</td><td class="num">${v.passed}</td><td class="num">${v.attempts ? Math.round(100 * v.passed / v.attempts) : 0} %</td><td class="num">${cost ? usd(cost.cost) : "–"}</td><td class="num">${cost ? cost.sessions : "–"}</td><td class="num">${cost?.ms ? mins(cost.ms) : "–"}</td><td class="num">${cost?.ms && cost.sessions ? mins(cost.ms / cost.sessions) : "–"}</td></tr>` }).join(""); return `<div class="group">${title}</div><table><tr><th>Modelo</th><th class="num">Intentos</th><th class="num">Pasó</th><th class="num">Tasa</th><th class="num">Coste</th><th class="num">Sesiones</th><th class="num">Tiempo</th><th class="num">Por sesión</th></tr>${rows || `<tr><td colspan="8" class="empty">Sin datos todavía.</td></tr>`}</table>` }
  const modelsTab = `<div class="strip s3"><div><div class="k">Escalera builder</div><div class="v sm">${esc((ladders.builder ?? []).map(short).join(" › "))}</div></div><div><div class="k">Escalera researcher</div><div class="v sm">${esc((ladders.researcher ?? []).map(short).join(" › "))}</div></div><div><div class="k">Regla</div><div class="v sm">2 intentos por peldaño · ${models?.max_models_per_item ?? 3} peldaños por ítem · si un modelo te falla seguido, bájalo en models.json</div></div></div>
    ${modelTable("builder", "BUILDERS · contratos")}
    ${modelTable("researcher", "RESEARCHERS · preguntas")}
    <div class="q" style="padding:8px 16px 12px">Intentos y tasa salen de report.json; coste, sesiones y tiempo (inicio a fin de cada sesión) de la base de datos de OpenCode (solo lectura, sin llamadas a modelos).</div>`

  const tabBadge = (n, k = "") => `<span class="n ${k}">${n}</span>`
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${alive || researchAlive ? 10 : 30}"><title>Avance · ${esc(root.split("/").pop())}</title>
<style>
:root{--bg:#F4F6F2;--surface:#fff;--ink:#1A2330;--ink-2:#4B5563;--ink-3:#7C8794;--line:#D8DDD6;--line-2:#E9ECE6;--accent:#31628F;--accent-soft:#E2ECF5;
--ok:#2E8B57;--ok-soft:#DDF0E4;--run:#C77D0A;--run-soft:#FBEBCF;--bad:#B8402F;--bad-soft:#F6DCD7;--wait:#9AA3AE;--wait-soft:#EDF0EE;--you:#6B4FBB;--you-soft:#EAE4F7;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#141A21;--surface:#1C242E;--ink:#E8ECEF;--ink-2:#B4BCC6;--ink-3:#7F8A96;--line:#2E3946;--line-2:#26303B;--accent:#7FB0DE;--accent-soft:#213547;
--ok:#5CBF86;--ok-soft:#1E3A2B;--run:#E6A23C;--run-soft:#3F2F14;--bad:#E0715E;--bad-soft:#42221C;--wait:#6B7681;--wait-soft:#232B34;--you:#A992E6;--you-soft:#2D2545}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5}
.wrap{max-width:none;margin:0 auto;padding:18px 24px 60px}
h1{font-size:19px;font-weight:600;margin:0}.subt{color:var(--ink-3);font-family:var(--mono);font-size:12px;margin:2px 0 12px}
.strip{display:grid;grid-template-columns:1.3fr 1fr 1fr 1fr .8fr;border:1px solid var(--line);border-radius:6px;background:var(--surface);margin-bottom:14px}
.strip.s3{grid-template-columns:1fr 1fr 1fr;border:0;border-bottom:1px solid var(--line-2);border-radius:0;margin:0}
.strip>div{padding:10px 14px;border-right:1px solid var(--line-2);min-width:0}.strip>div:last-child{border-right:0}
.k{font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3)}
.v{font-size:22px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums}.v.sm{font-size:13px;font-family:var(--mono);font-weight:500;line-height:1.4}
.v small{font-size:12px;font-weight:400;color:var(--ink-2);margin-left:5px}.v.ok{color:var(--ok)}.v.run{color:var(--run)}.v.bad{color:var(--bad)}.v.you{color:var(--you)}
.sub{font-family:var(--mono);font-size:11px;color:var(--ink-3);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--run);margin-right:7px;vertical-align:2px;animation:p 1.4s ease-in-out infinite}@keyframes p{0%,100%{opacity:.35}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.pulse{animation:none}}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:0}
.tabs label{padding:8px 14px;font-family:var(--mono);font-size:12px;color:var(--ink-3);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}.tabs label:hover{color:var(--ink)}
.tabs .n{display:inline-block;margin-left:6px;padding:0 6px;border-radius:9px;background:var(--wait-soft);color:var(--ink-2);font-size:10.5px}.tabs .n.run{background:var(--run-soft);color:var(--run)}.tabs .n.ok{background:var(--ok-soft);color:var(--ok)}.tabs .n.bad{background:var(--bad-soft);color:var(--bad)}
input[name="tb"]{position:absolute;opacity:0;pointer-events:none}.pane{display:none;background:var(--surface);border:1px solid var(--line);border-top:0;border-radius:0 0 6px 6px}
#t1:checked~.tabs label[for="t1"],#t2:checked~.tabs label[for="t2"],#t3:checked~.tabs label[for="t3"],#t4:checked~.tabs label[for="t4"]{color:var(--ink);border-bottom-color:var(--accent)}
#t1:checked~.p1,#t2:checked~.p2,#t3:checked~.p3,#t4:checked~.p4{display:block}
.panel{border-bottom:1px solid var(--line-2)}.panel:last-child{border-bottom:0}
.panel-h{padding:8px 14px;font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);border-bottom:1px solid var(--line-2);display:flex;justify-content:space-between}
.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;padding:10px 14px}
.card{border:1px solid var(--line);border-left-width:4px;border-radius:4px;padding:7px 9px;background:var(--surface)}
.card .id{font-family:var(--mono);font-size:12.5px;font-weight:500}.card .t{font-size:12.5px;color:var(--ink-2);line-height:1.35;margin:2px 0 5px}
.card .m{display:flex;gap:8px;flex-wrap:wrap;font-family:var(--mono);font-size:11px;color:var(--ink-3)}.card .m .reason{flex-basis:100%;color:var(--bad)}
.card.ok{border-left-color:var(--ok)}.card.run{border-left-color:var(--run)}.card.bad{border-left-color:var(--bad)}.card.wait{border-left-color:var(--wait)}
.journal{padding:4px 14px 10px}.jday{font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);padding:10px 0 4px}
.j{display:grid;grid-template-columns:44px 14px 1fr;gap:0 10px;align-items:start;padding:4px 0}
.j .t{font-family:var(--mono);font-size:11.5px;color:var(--ink-3);padding-top:2px}.j .x{line-height:1.4;font-size:13px}.j .x .m{font-family:var(--mono);font-size:11px;color:var(--ink-3)}
.j .s{width:10px;height:10px;margin-top:5px;background:var(--wait)}.j .s.dot{border-radius:50%}.j .s.sq{border-radius:1px}.j .s.dia{transform:rotate(45deg) scale(.85);border-radius:1px}
.j.ok .s{background:var(--ok)}.j.run .s{background:var(--run)}.j.bad .s{background:var(--bad)}.j.you .s{background:var(--you)}.j.merge .s{background:var(--accent)}.j.wait .s{background:var(--wait)}
.graph{overflow-x:auto;padding:12px 8px 4px}
svg text{font-family:var(--mono);font-size:11.5px;fill:var(--ink)}svg .lbl2{fill:var(--ink-3);font-size:10.5px}
svg .edge{stroke:var(--line);stroke-width:1.5;fill:none}svg .edge.done{stroke:var(--ok);opacity:.55}svg .edge.crit{stroke:var(--accent);stroke-width:2}
svg .lane{stroke:var(--line-2)}svg .lane-lbl{fill:var(--ink-3);font-size:10.5px;letter-spacing:.06em}
svg .node{stroke-width:2}svg .node.ok{fill:var(--ok-soft);stroke:var(--ok)}svg .node.run{fill:var(--run-soft);stroke:var(--run)}svg .node.bad{fill:var(--bad-soft);stroke:var(--bad)}svg .node.wait{fill:var(--surface);stroke:var(--wait)}
.legend{display:flex;gap:16px;flex-wrap:wrap;padding:8px 14px 10px;font-family:var(--mono);font-size:11px;color:var(--ink-2);border-top:1px solid var(--line-2)}
.legend span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px;background:var(--c)}
.board{display:grid;grid-template-columns:repeat(4,1fr)}.col{padding:10px 10px 14px;border-right:1px solid var(--line-2)}.col:last-child{border-right:0}
.col-h{display:flex;justify-content:space-between;margin-bottom:8px}.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2)}.n{font-family:var(--mono);font-size:12px;color:var(--ink-3)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:7px 14px;border-top:1px solid var(--line-2);vertical-align:top}
th{font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);font-weight:500;border-top:0}
td.mono,.mono{font-family:var(--mono);font-size:12px}td.num,th.num{font-variant-numeric:tabular-nums;text-align:right}.q{font-family:var(--sans);font-size:12px;color:var(--ink-3);margin-top:2px}
table.rs{table-layout:fixed;width:100%}table.rs td{word-break:break-word}tr.grp td{padding:12px 14px 4px;font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:var(--ink-3);border-bottom:0}.group{padding:10px 14px 4px;font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:var(--ink-3)}.empty{padding:14px;color:var(--ink-3)}
.pill{display:inline-block;padding:1px 7px;border-radius:10px;font-family:var(--mono);font-size:11px}.pill.ok{background:var(--ok-soft);color:var(--ok)}.pill.run{background:var(--run-soft);color:var(--run)}.pill.bad{background:var(--bad-soft);color:var(--bad)}.pill.wait{background:var(--wait-soft);color:var(--ink-2)}
@media (max-width:900px){.strip{grid-template-columns:repeat(2,1fr)}.board,.cards{grid-template-columns:repeat(2,1fr)}.col:nth-child(2){border-right:0}}
</style></head><body><div class="wrap">
<h1>Avance de ${esc(root.split("/").pop())}</h1>
<div class="subt">${esc(current?.integration ?? "sin rama de integración")} · actualizado ${hhmm(now)} · se refresca cada ${alive || researchAlive ? 10 : 30} s</div>
${strip}
<input type="radio" name="tb" id="t1" checked><input type="radio" name="tb" id="t2"><input type="radio" name="tb" id="t3"><input type="radio" name="tb" id="t4">
<div class="tabs"><label for="t1">Ahora ${phaseCls === "run" ? tabBadge(phase, "run") : phaseCls === "you" ? tabBadge("te espera", "bad") : ""}</label><label for="t2">Contratos ${tabBadge(`${passed}/${contracts.length}`, passed === contracts.length && contracts.length ? "ok" : "")}</label><label for="t3">Research ${tabBadge(`${Object.values(researchResults).filter((r) => r.status === "DONE").length}/${Object.keys(researchResults).length}`, researchAlive ? "run" : "")}</label><label for="t4">Modelos y coste</label></div>
<div class="pane p1">${runningPanel}<div class="panel"><div class="panel-h"><span>Diario</span><span>${entries.length} entradas · ● contrato ■ research ◆ tú</span></div><div class="journal">${journal || '<div class="empty">Sin eventos todavía.</div>'}</div></div></div>
<div class="pane p2"><div class="panel"><div class="panel-h"><span>Dependencias · qué frena qué</span><span>${contracts.length} contratos</span></div><div class="graph"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafo de dependencias">${svg}</svg></div><div class="legend"><span style="--c:var(--ok)">pasó</span><span style="--c:var(--run)">construyendo</span><span style="--c:var(--bad)">falló</span><span style="--c:var(--wait)">esperando</span><span style="--c:var(--accent)">camino crítico</span></div></div><div class="panel"><div class="panel-h"><span>Contratos por estado</span></div><div class="board">${board}</div></div></div>
<div class="pane p3">${researchTable}</div>
<div class="pane p4">${modelsTab}</div>
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
