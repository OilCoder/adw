// Read-only access to OpenCode's own database (~/.local/share/opencode/opencode.db)
// for the board: what the supervisor did last, what the user asked, and what
// each agent session cost. No model is ever called from here.

import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const DB_FILE = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")

function open() {
  if (!existsSync(DB_FILE)) return null
  try {
    // node:sqlite ships with Node 22.13+; keep the board working without it.
    const { DatabaseSync } = process.getBuiltinModule?.("node:sqlite") ?? {}
    if (!DatabaseSync) return null
    return new DatabaseSync(DB_FILE, { readOnly: true })
  } catch {
    return null
  }
}

const parse = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

// The supervisor's session in `root`: user messages (for the journal), the
// last thing the supervisor did, and whether its last turn ended in text
// addressed to the user (then it is waiting).
export function supervisorActivity(root) {
  const db = open()
  if (!db) return null
  try {
    // Every supervisor session opened in this project: the user's messages come
    // from all of them, the "last action" from the most recent one.
    const sessions = db
      .prepare(
        "select id, time_updated from session where directory = ? and parent_id is null and (agent is null or agent not in ('researcher','builder')) order by time_updated",
      )
      .all(root)
    if (!sessions.length) return null
    const session = sessions.at(-1)
    const ids = sessions.map((s) => s.id)
    const messages = db
      .prepare(
        `select id, session_id, data, time_created from message where session_id in (${ids.map(() => "?").join(",")}) order by time_created`,
      )
      .all(...ids)
    const roleOf = {}
    const userMessages = []
    for (const m of messages) {
      const d = parse(m.data)
      roleOf[m.id] = d.role
      if (d.role === "user") userMessages.push({ id: m.id, at: m.time_created, text: "" })
    }
    const parts = db
      .prepare(
        `select session_id, message_id, data, time_created from part where session_id in (${ids.map(() => "?").join(",")}) order by time_created`,
      )
      .all(...ids)
    let last = null
    for (const p of parts) {
      const d = parse(p.data)
      if (roleOf[p.message_id] === "user") {
        if (d.type === "text") {
          const u = userMessages.find((x) => x.id === p.message_id)
          if (u && !u.text) u.text = d.text ?? ""
        }
        continue
      }
      if (p.session_id !== session.id) continue
      if (d.type === "tool")
        last = {
          at: p.time_created,
          kind: "tool",
          text: `${d.tool}: ${String(d.state?.input?.command ?? d.state?.input?.filePath ?? "").slice(0, 80)}`,
        }
      else if (d.type === "text" && d.text?.trim())
        last = { at: p.time_created, kind: "text", text: d.text.trim() }
      else if (d.type === "reasoning") last = { at: p.time_created, kind: "thinking", text: "" }
    }
    const lastUser = userMessages.at(-1)
    // Waiting = the supervisor's last part is text and nothing from the user came after it.
    const waiting = last?.kind === "text" && (!lastUser || lastUser.at < last.at) ? last.text : null
    // OpenCode injects "Continue if you have next steps…" on its own; it is not the user's.
    return {
      sessionId: session.id,
      last,
      waiting,
      userMessages: userMessages.filter((u) => u.text && !/^Continue if you have next steps/i.test(u.text)),
    }
  } catch {
    return null
  } finally {
    db.close()
  }
}

// Cost and tokens of the agent sessions the script launched for this
// project, by role and model (byModel[role][model]), plus wall time per
// session (time_updated - time_created): how long each model takes per task.
// project: builders run in sandboxes named after the contract, researchers
// run in the project root.
export function agentCosts(root, sandboxes) {
  const db = open()
  if (!db) return null
  try {
    const rows = db
      .prepare(
        "select directory, agent, model, cost, tokens_input, tokens_output, time_created, time_updated from session where (directory = ? and agent in ('researcher','builder')) or directory like ?",
      )
      .all(root, `${sandboxes}/%`)
    const byContract = {},
      byModel = {},
      byRole = {}
    let total = 0
    for (const r of rows) {
      const m = parse(r.model)
      const model = m.modelID ?? m.id ?? String(r.model ?? "?")
      const cost = r.cost ?? 0
      total += cost
      const role = r.agent ?? "?"
      byRole[role] = (byRole[role] ?? 0) + cost
      const bm = ((byModel[role] ??= {})[model] ??= { sessions: 0, cost: 0, input: 0, output: 0, ms: 0 })
      bm.sessions++
      bm.cost += cost
      bm.input += r.tokens_input ?? 0
      bm.output += r.tokens_output ?? 0
      bm.ms += Math.max(0, (r.time_updated ?? 0) - (r.time_created ?? 0))
      if (r.directory.startsWith(sandboxes)) {
        const id = path.basename(r.directory)
        byContract[id] = (byContract[id] ?? 0) + cost
      }
    }
    return { total, byContract, byModel, byRole }
  } catch {
    return null
  } finally {
    db.close()
  }
}
