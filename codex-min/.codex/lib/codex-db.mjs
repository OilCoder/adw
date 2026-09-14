// Read-only access to Codex's own session files (~/.codex/sessions/**/rollout-*.jsonl,
// ~/.codex/session_index.jsonl) for the script and the board: which TUI thread is
// the supervisor of this project (so `codex queue` can wake it), what the user
// asked, and what the supervisor did last. No model is ever called from here.

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")

const parse = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

// Every rollout file, newest first (sessions/YYYY/MM/DD/rollout-<stamp>-<id>.jsonl).
function rollouts() {
  const dir = path.join(CODEX_HOME, "sessions")
  if (!existsSync(dir)) return []
  const out = []
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) walk(p)
      else if (f.name.startsWith("rollout-") && f.name.endsWith(".jsonl")) out.push({ file: p, mtime: statSync(p).mtimeMs })
    }
  }
  walk(dir)
  return out.sort((a, b) => b.mtime - a.mtime)
}

// The first line of a rollout is its session_meta: read up to its newline
// (it carries the whole base prompt, well over 8 KB) and nothing more.
function meta(file) {
  const fd = openSync(file, "r")
  try {
    const chunks = []
    const buf = Buffer.alloc(65536)
    let pos = 0
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos)
      if (n <= 0) break
      const nl = buf.indexOf(10, 0, "utf8")
      const upto = nl >= 0 && nl < n ? nl : n
      chunks.push(Buffer.from(buf.subarray(0, upto)))
      if (nl >= 0 && nl < n) break
      pos += n
      if (pos > 4 * 1024 * 1024) break
    }
    return parse(Buffer.concat(chunks).toString("utf8"))?.payload ?? null
  } finally {
    closeSync(fd)
  }
}

// The supervisor: the newest TUI thread (originator codex-tui) opened in `root`
// within the last week. Agents are `codex exec --ephemeral` and leave no file.
export function supervisorThread(root) {
  const since = Date.now() - 7 * 86400000
  for (const r of rollouts()) {
    if (r.mtime < since) break
    const m = meta(r.file)
    if (!m || m.cwd !== root || m.originator !== "codex-tui") continue
    return { id: m.id ?? m.session_id, file: r.file, updatedAt: r.mtime }
  }
  return null
}

// What the TUI's session list shows for a thread (session_index.jsonl keeps the
// latest name per id).
function threadName(id) {
  const file = path.join(CODEX_HOME, "session_index.jsonl")
  if (!existsSync(file)) return null
  let name = null
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const e = parse(line)
    if (e?.id === id && e.thread_name) name = e.thread_name
  }
  return name
}

// The supervisor's session in `root`: user messages (for the journal), the
// last thing the supervisor did, and whether its last turn ended in text
// addressed to the user (then it is waiting).
export function supervisorActivity(root) {
  const t = supervisorThread(root)
  if (!t) return null
  try {
    const userMessages = []
    let last = null
    for (const line of readFileSync(t.file, "utf8").split("\n")) {
      const e = parse(line)
      if (!e) continue
      const at = Date.parse(e.timestamp)
      const p = e.payload ?? {}
      if (e.type === "event_msg" && p.type === "item_completed" && p.item?.type === "UserMessage") {
        const text = (p.item.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n")
          .trim()
        userMessages.push({ id: p.item.id, at, text })
      } else if (e.type === "response_item") {
        if (p.type === "custom_tool_call" || p.type === "function_call")
          last = { at, kind: "tool", text: `${p.name}: ${String(p.input ?? p.arguments ?? "").slice(0, 80)}` }
        else if (p.type === "reasoning") last = { at, kind: "thinking", text: "" }
        else if (p.type === "message" && p.role === "assistant") {
          const text = (p.content ?? [])
            .map((c) => c.text ?? "")
            .join("\n")
            .trim()
          if (text) last = { at, kind: "text", text }
        }
      }
    }
    const lastUser = userMessages.at(-1)
    // Waiting = the supervisor's last item is text and nothing from the user came after it.
    const waiting = last?.kind === "text" && (!lastUser || lastUser.at < last.at) ? last.text : null
    return {
      sessionId: t.id,
      title: threadName(t.id),
      slug: null,
      last,
      waiting,
      // The script's [codegen] notices arrive as user messages: they are not the user.
      userMessages: userMessages.filter((u) => u.text && !/^\[codegen\]/.test(u.text)),
    }
  } catch {
    return null
  }
}
