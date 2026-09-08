import { access, appendFile, lstat, mkdir, readFile, symlink } from "node:fs/promises"
import path from "node:path"

import { runProcess } from "./process.mjs"

// Commits made by the system carry a fixed identity so runs work in
// environments without a configured Git user.
const IDENTITY = ["-c", "user.name=OpenCode Codegen", "-c", "user.email=codegen@localhost"]

export async function git(directory, args, { timeoutSeconds = 120, allowFailure = false } = {}) {
  const result = await runProcess("git", [...IDENTITY, ...args], { cwd: directory, timeoutSeconds })
  if (result.exitCode !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed in ${directory}: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export async function revision(directory, ref = "HEAD") {
  return (await git(directory, ["rev-parse", ref])).stdout.trim()
}

// Adds a pattern to .git/info/exclude of the repository that owns `directory`
// so run artifacts never touch the tracked .gitignore.
export async function ensureExcluded(directory, pattern) {
  const commonDir = (await git(directory, ["rev-parse", "--git-common-dir"])).stdout.trim()
  const excludeFile = path.resolve(directory, commonDir, "info/exclude")
  await mkdir(path.dirname(excludeFile), { recursive: true })
  const current = (await exists(excludeFile)) ? await readFile(excludeFile, "utf8") : ""
  if (current.split("\n").includes(pattern)) return false
  await appendFile(excludeFile, `${current.endsWith("\n") || current === "" ? "" : "\n"}${pattern}\n`)
  return true
}

export async function createWorktree({ repository, directory, revision: rev, branch = null }) {
  await mkdir(path.dirname(directory), { recursive: true })
  const args = branch
    ? ["worktree", "add", "-b", branch, directory, rev]
    : ["worktree", "add", "--detach", directory, rev]
  await git(repository, args)
  return directory
}

export async function removeWorktree({ repository, directory }) {
  await git(repository, ["worktree", "remove", "--force", directory], { allowFailure: true })
  await git(repository, ["worktree", "prune"], { allowFailure: true })
}

export async function listWorktrees(repository) {
  const output = (await git(repository, ["worktree", "list", "--porcelain"])).stdout
  return output
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("worktree "))?.slice(9))
    .filter(Boolean)
}

// The OpenCode layer (.opencode/, opencode.json) is often untracked in the
// target project, so a fresh worktree lacks it. Link what is missing so the
// same agents, tools, and instructions apply inside the worktree.
// A worktree needs the OpenCode layer to run agents. Untracked pieces are
// symlinked from the project; when .opencode is tracked (checked out in the
// worktree), its machine-local node_modules is linked too. Without it,
// OpenCode installs the runtime dependencies while bootstrapping the
// worktree instance, which took more than two minutes on 2026-09-04 and
// starved the Builder past its first-output deadline.
export async function linkOpenCodeLayer(project, worktree) {
  const linked = []
  for (const entry of [".opencode", "opencode.json", ".opencode/node_modules", ".opencode/package-lock.json"]) {
    const source = path.join(project, entry)
    const target = path.join(worktree, entry)
    if ((await exists(source)) && !(await exists(target)) && (await exists(path.dirname(target)))) {
      await symlink(source, target)
      linked.push(entry)
    }
  }
  return linked
}

export async function isSymbolicLink(filePath) {
  try {
    return (await lstat(filePath)).isSymbolicLink()
  } catch {
    return false
  }
}

// Linked layer entries are symlinks and never count as project changes.
export async function changedFilesSince(directory, rev) {
  const tracked = (await git(directory, ["diff", "--name-only", rev, "--"])).stdout
  const untracked = (await git(directory, ["ls-files", "--others", "--exclude-standard"])).stdout
  const candidates = [...new Set(`${tracked}\n${untracked}`.split("\n").map((line) => line.trim()).filter(Boolean))]
  const files = []
  for (const candidate of candidates) {
    if (!(await isSymbolicLink(path.join(directory, candidate)))) files.push(candidate)
  }
  return files.sort()
}

// `force` adds paths the project's .gitignore excludes: the sealed contract
// and its Gate under .codegen-contract/ belong to the run, not the product,
// and must travel with the worktree commit even when the project ignores them.
export async function commitPaths(directory, paths, message, { force = false } = {}) {
  // allowed_to_modify is a permission, not an obligation: a path the Builder
  // never created or touched has no match for git and must not fail the
  // commit. Paths present on disk or tracked (a deletion) are staged.
  const present = []
  for (const candidate of paths) {
    if (await exists(path.join(directory, candidate))) {
      present.push(candidate)
      continue
    }
    const tracked = await git(directory, ["ls-files", "--", candidate], { allowFailure: true })
    if (tracked.stdout.trim()) present.push(candidate)
  }
  if (present.length === 0) return null
  await git(directory, ["add", "-A", ...(force ? ["-f"] : []), "--", ...present])
  const staged = await git(directory, ["diff", "--cached", "--quiet"], { allowFailure: true })
  if (staged.exitCode === 0) return null
  await git(directory, ["commit", "-q", "-m", message])
  return revision(directory)
}

export async function restorePaths(directory, paths) {
  if (paths.length === 0) return
  await git(directory, ["checkout", "--", ...paths], { allowFailure: true })
  await git(directory, ["clean", "-fdq", "--", ...paths], { allowFailure: true })
}

export async function cherryPick(directory, commit) {
  const result = await git(directory, ["cherry-pick", "--allow-empty", commit], { allowFailure: true })
  if (result.exitCode !== 0) {
    await git(directory, ["cherry-pick", "--abort"], { allowFailure: true })
    return { ok: false, conflict: result.stderr.trim() || result.stdout.trim() }
  }
  return { ok: true, head: await revision(directory) }
}
