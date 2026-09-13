// One contract's sandbox, in the order buildOne uses it: export the integration
// branch into a fresh repo, install dependencies, run the gate, judge what the
// builder changed (scope, protected paths, the structure map, a broken gate),
// and land the diff on the integration branch. Pure functions of paths and
// git; no logging and no state files (codegen.mjs decides what to record).

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import path from "node:path"
import { git, run } from "./agent.mjs"

// Files whose path matches an entry: exact path, `dir/**`, or `*.ext`.
export function matches(file, pattern) {
  if (pattern.endsWith("/**")) return file === pattern.slice(0, -3) || file.startsWith(pattern.slice(0, -2))
  if (pattern.startsWith("*.")) return file.endsWith(pattern.slice(1))
  return file === pattern
}

// ---------- export ----------

// An export of the integration branch with its own fresh git history, so
// the builder sees an independent project and nothing it does can reach the
// user's tree. The supervisor's configuration (CLAUDE.md, .claude/) is left
// out before the base commit: Claude Code would load it into the builder and
// deny it its own files. Returns the integration commit it came from and the
// sandbox's base commit.
export function exportSandbox({ root, integration, wt, id }) {
  const integrationHead = git(["rev-parse", integration], root)
  execFileSync("bash", ["-c", `git -C "${root}" archive ${integrationHead} | tar -x -C "${wt}"`], {
    stdio: ["ignore", "ignore", "pipe"],
  })
  rmSync(path.join(wt, ".claude"), { recursive: true, force: true })
  rmSync(path.join(wt, "CLAUDE.md"), { force: true })
  git(["init", "-q"], wt)
  git(["add", "-A"], wt)
  git(
    [
      "-c",
      "user.name=codegen",
      "-c",
      "user.email=codegen@localhost",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      `sandbox ${id} from ${integrationHead}`,
    ],
    wt,
  )
  return { integrationHead, base: git(["rev-parse", "HEAD"], wt) }
}

// A copy of a prepared sandbox for one racer: the tree with its git history,
// node_modules and .venv as hard links (291 MB in las-viewer-v6; a builder that
// edits them is out of scope anyway, and npm rewrites files instead of editing
// them in place).
export function cloneSandbox(from, to) {
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  execFileSync("bash", [
    "-c",
    `cd "${from}" && tar -c --exclude=./node_modules --exclude=./.venv . | tar -x -C "${to}" && for d in node_modules .venv; do [ -d "$d" ] && cp -al "$d" "${to}/$d"; done; true`,
  ])
}

export function resetSandbox(wt, base) {
  git(["reset", "-q", "--hard", base], wt)
  git(["clean", "-qfd"], wt)
}

// ---------- dependencies ----------

// Dependencies are not in git: install them before the baseline gate so a
// missing node_modules never masquerades as a legitimate gate failure. Node
// via `npm ci` when there is a lock file; Python via a uv venv (system python
// has no pytest) that the gate and the builder see first in PATH.
// Returns { env } or { failed: <reason> }.
export async function installDeps(wt, logs, timeoutSeconds) {
  if (existsSync(path.join(wt, "package-lock.json"))) {
    const install = await run("npm", ["ci", "--no-audit", "--no-fund", "--prefer-offline"], {
      cwd: wt,
      timeoutSeconds,
      stdoutFile: path.join(logs, "npm-ci.txt"),
      stderrFile: path.join(logs, "npm-ci.stderr.txt"),
    })
    if (install.code !== 0) return { failed: install.stderr.slice(-800), step: "" }
  }
  const pyproject = existsSync(path.join(wt, "pyproject.toml")),
    reqs = existsSync(path.join(wt, "requirements.txt"))
  if (!(pyproject || reqs)) return { env: undefined }
  const uvLog = {
    cwd: wt,
    timeoutSeconds,
    stdoutFile: path.join(logs, "uv.txt"),
    stderrFile: path.join(logs, "uv.stderr.txt"),
  }
  const steps = [
    ["venv", ".venv"],
    pyproject ? ["pip", "install", "-e", ".[dev]"] : ["pip", "install", "-r", "requirements.txt"],
    ["pip", "install", "pytest"],
  ]
  for (const args of steps) {
    let r = await run("uv", args, uvLog)
    if (r.code !== 0 && args[3] === ".[dev]") r = await run("uv", ["pip", "install", "-e", "."], uvLog)
    if (r.code !== 0)
      return { failed: `uv ${args.join(" ")}: ${r.stderr.slice(-800)}`, step: ` (uv ${args.join(" ")})` }
  }
  return { env: venvEnv(wt) }
}

// The venv of a sandbox, for a racer's copy (its path differs from the original's).
export const venvEnv = (wt) =>
  existsSync(path.join(wt, ".venv"))
    ? { VIRTUAL_ENV: path.join(wt, ".venv"), PATH: `${path.join(wt, ".venv", "bin")}:${process.env.PATH}` }
    : undefined

// ---------- gate ----------

export async function runGate(id, cwd, logFile, env, timeoutSeconds) {
  const r = await run("bash", [path.join(".codegen", "contracts", id, "gate.sh")], {
    cwd,
    timeoutSeconds,
    stdoutFile: logFile,
    stderrFile: logFile + ".stderr",
    env,
  })
  return {
    pass: r.code === 0 && !r.timedOut,
    output: (r.stdout + "\n" + r.stderr).slice(-3000),
    timedOut: r.timedOut,
  }
}

// A gate that only reports errors in files the builder may not touch (its
// own test file, another domain, missing types elsewhere) cannot be fixed
// by any builder: (a) the gate's own test file does not parse or compile;
// (b) a type checker reports errors, and every one is in a file outside scope.
export function gateBroken(out, wt, contract) {
  if (
    /\.codegen\/\S+:\d+(?::\d+)?:? *(?:ERROR|error|SyntaxError)/.test(out) ||
    /Transform failed[\s\S]{0,300}\.codegen\//.test(out)
  )
    return true
  const ts = [
    ...new Set(
      [
        ...out.matchAll(
          /(?:^|[\s'"(])(\/?(?:\.?[\w.@-]+\/)*[\w.@-]+\.[a-zA-Z]{1,5})\(\d+,\d+\): error TS\d+/gm,
        ),
      ].map((m) => m[1]),
    ),
  ].map((f) => (f.startsWith(wt + "/") ? f.slice(wt.length + 1) : f.replace(/^\.\//, "")))
  return ts.length > 0 && ts.every((f) => !contract.allowed_to_modify.some((p) => matches(f, p)))
}

// ---------- what the builder changed ----------

export function changedFiles(cwd) {
  const tracked = git(["diff", "--name-only", "HEAD", "--"], cwd)
  const untracked = git(["ls-files", "--others", "--exclude-standard"], cwd)
  const junk =
    /(^|\/)(__pycache__|\.pytest_cache|node_modules|\.venv|\.mypy_cache|\.ruff_cache)\/|\.pyc$|\.egg-info\//
  return [...new Set(`${tracked}\n${untracked}`.split("\n").filter((f) => f && !junk.test(f)))].sort()
}

export function checkScope(contract, files) {
  const protectedPatterns = [".codegen/**", ".claude/**", "CLAUDE.md", ...(contract.protected ?? [])]
  const outside = files.filter((f) => !contract.allowed_to_modify.some((p) => matches(f, p)))
  const touchedProtected = files.filter((f) => protectedPatterns.some((p) => matches(f, p)))
  return { outside, touchedProtected }
}

// ---------- the structure map ----------

// The map: .codegen/structure.md, written by the supervisor. Machine-readable
// part = every bullet that starts with a backticked path under "## Folders"
// ("- `src/core/**`: pure logic", "- `*`: root config files" for top-level
// files) and under "## Repeated names allowed" ("- `index.ts`").
export function loadStructure(stateDir) {
  const file = path.join(stateDir, "structure.md")
  if (!existsSync(file)) return null
  const folders = [],
    repeated = ["index.*", "__init__.py", "mod.rs", "README.md"]
  let section = ""
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const h = line.match(/^##\s+(.*)/)
    if (h) {
      section = h[1].trim().toLowerCase()
      continue
    }
    const b = line.match(/^\s*[-*]\s+`([^`]+)`/)
    if (!b) continue
    if (section.startsWith("folders")) folders.push(b[1])
    else if (section.startsWith("repeated names")) repeated.push(b[1])
  }
  if (!folders.length)
    throw new Error("structure: .codegen/structure.md has no `path` bullets under ## Folders")
  return { folders, repeated }
}

export const inMap = (file, map) =>
  map.folders.some((p) =>
    p === "*" ? !file.includes("/") : matches(file, p) || matches(file, p.replace(/\/\*\*$/, "")),
  )
const PROVISIONAL =
  /(^|\/)(todo|placeholder|tmp|temp|old|backup|untitled|new)([._-][^/]*)?$|\.(tmp|bak|orig|old|swp|rej)$|~$/i

// Files that break the map: outside every declared folder, provisional, or a
// new file whose name already exists elsewhere (unless the name is conventional).
export function checkStructure(map, files, cwd, before = new Set()) {
  if (!map) return []
  const tree = git(["ls-files"], cwd).split("\n").filter(Boolean)
  const byName = {}
  for (const f of tree) (byName[path.basename(f)] ??= []).push(f)
  const problems = []
  for (const f of files) {
    if (!inMap(f, map)) problems.push(`${f}: outside the map`)
    else if (PROVISIONAL.test(f)) problems.push(`${f}: provisional file`)
    else if (!before.has(f)) {
      const name = path.basename(f)
      const twins = (byName[name] ?? []).filter((x) => x !== f)
      if (
        twins.length &&
        !map.repeated.some((p) =>
          new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(name),
        )
      )
        problems.push(`${f}: same name as ${twins[0]}`)
    }
  }
  return problems
}

// ---------- landing ----------

// Takes the sandbox diff and lands it on a contract branch cut from the
// integration base this sandbox started from, then merges. All git calls are
// synchronous, so parallel contracts land one after another. On conflict the
// merge is aborted, the contract branch is pushed for the supervisor, and the
// reason is returned.
export function landContract({
  id,
  wt,
  base,
  patch,
  branch,
  integration,
  integrationHead,
  integrationDir,
  message,
}) {
  git(["add", "-A"], wt)
  writeFileSync(patch, execFileSync("git", ["diff", "--cached", "--binary", base], { cwd: wt }))
  try {
    git(["checkout", "-q", "-B", branch, integrationHead], integrationDir)
    git(["apply", "--index", patch], integrationDir)
    git(["commit", "-q", "-m", message], integrationDir)
    git(["checkout", "-q", integration], integrationDir)
    git(["merge", "-q", "--no-edit", "-m", `codegen: merge ${id}`, branch], integrationDir)
    git(["push", "-q", "origin", `${integration}:${integration}`], integrationDir)
    git(["branch", "-q", "-D", branch], integrationDir)
    return { landed: true }
  } catch (e) {
    try {
      git(["merge", "--abort"], integrationDir)
    } catch {}
    try {
      git(["checkout", "-q", "-f", integration], integrationDir)
      git(["push", "-q", "origin", `${branch}:${branch}`], integrationDir)
    } catch {}
    return { landed: false, reason: String(e.stderr ?? e.message).slice(-800) }
  }
}
