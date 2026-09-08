import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  changedFilesSince,
  cherryPick,
  commitPaths,
  createWorktree,
  ensureExcluded,
  git,
  linkOpenCodeLayer,
  listWorktrees,
  removeWorktree,
  restorePaths,
  revision,
} from "../.opencode/codegen/lib/worktrees.mjs"

async function repository() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "worktrees-test-"))
  await git(directory, ["init", "-q", "-b", "main"])
  await writeFile(path.join(directory, "a.txt"), "a\n")
  await mkdir(path.join(directory, ".opencode"))
  await writeFile(path.join(directory, ".opencode/agents.txt"), "untracked layer\n")
  await writeFile(path.join(directory, "opencode.json"), "{}\n")
  await writeFile(path.join(directory, ".gitignore"), ".opencode/\nopencode.json\n")
  await commitPaths(directory, ["a.txt", ".gitignore"], "init")
  return directory
}

test("worktree lifecycle: create, link layer, change, commit, cherry-pick, remove", async () => {
  const repo = await repository()
  try {
    const base = await revision(repo)
    assert.equal(await ensureExcluded(repo, ".codegen-run/"), true)
    assert.equal(await ensureExcluded(repo, ".codegen-run/"), false)

    const worktree = path.join(repo, ".codegen-run/wt/c1")
    await createWorktree({ repository: repo, directory: worktree, revision: base })
    assert.ok((await listWorktrees(repo)).some((entry) => entry.endsWith("wt/c1")))
    assert.deepEqual(await linkOpenCodeLayer(repo, worktree), [".opencode", "opencode.json"])
    assert.equal(await readFile(path.join(worktree, ".opencode/agents.txt"), "utf8"), "untracked layer\n")

    await writeFile(path.join(worktree, "a.txt"), "changed\n")
    await writeFile(path.join(worktree, "new.txt"), "new\n")
    await writeFile(path.join(worktree, "scratch.txt"), "outside\n")
    assert.deepEqual(await changedFilesSince(worktree, base), ["a.txt", "new.txt", "scratch.txt"])
    await restorePaths(worktree, ["scratch.txt"])
    assert.deepEqual(await changedFilesSince(worktree, base), ["a.txt", "new.txt"])

    const commit = await commitPaths(worktree, ["a.txt", "new.txt"], "codegen: c1")
    assert.ok(commit)
    assert.equal(await commitPaths(worktree, ["a.txt"], "nothing"), null)

    const integration = path.join(repo, ".codegen-run/integration")
    await createWorktree({ repository: repo, directory: integration, revision: base, branch: "codegen/test" })
    const picked = await cherryPick(integration, commit)
    assert.equal(picked.ok, true)
    assert.equal(await readFile(path.join(integration, "new.txt"), "utf8"), "new\n")

    // The main worktree is untouched by everything above.
    assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "a\n")
    const status = await git(repo, ["status", "--porcelain"])
    assert.equal(status.stdout.trim(), "")

    await removeWorktree({ repository: repo, directory: worktree })
    assert.ok(!(await listWorktrees(repo)).some((entry) => entry.endsWith("wt/c1")))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("cherry-pick conflict is reported and aborted, leaving the branch clean", async () => {
  const repo = await repository()
  try {
    const base = await revision(repo)
    const left = path.join(repo, ".codegen-run/wt/left")
    const right = path.join(repo, ".codegen-run/wt/right")
    await createWorktree({ repository: repo, directory: left, revision: base })
    await createWorktree({ repository: repo, directory: right, revision: base })
    await writeFile(path.join(left, "a.txt"), "left\n")
    await writeFile(path.join(right, "a.txt"), "right\n")
    const leftCommit = await commitPaths(left, ["a.txt"], "left")
    const rightCommit = await commitPaths(right, ["a.txt"], "right")
    const integration = path.join(repo, ".codegen-run/integration")
    await createWorktree({ repository: repo, directory: integration, revision: base, branch: "codegen/conflict" })
    assert.equal((await cherryPick(integration, leftCommit)).ok, true)
    const conflict = await cherryPick(integration, rightCommit)
    assert.equal(conflict.ok, false)
    assert.match(conflict.conflict, /conflict/i)
    assert.deepEqual(conflict.paths, ["a.txt"], "the unmerged paths survive the abort")
    assert.equal((await git(integration, ["status", "--porcelain"])).stdout.trim(), "")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("a tracked .opencode layer gets the project's node_modules linked into the worktree", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "worktrees-tracked-"))
  try {
    await git(repo, ["init", "-q", "-b", "main"])
    await mkdir(path.join(repo, ".opencode/node_modules/dep"), { recursive: true })
    await writeFile(path.join(repo, ".opencode/package.json"), "{}\n")
    await writeFile(path.join(repo, ".opencode/node_modules/dep/index.js"), "// installed\n")
    await writeFile(path.join(repo, ".gitignore"), ".opencode/node_modules/\n")
    await git(repo, ["add", "."])
    await git(repo, ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "base"])
    const worktree = path.join(repo, "wt/c2")
    await createWorktree({ repository: repo, directory: worktree, revision: await revision(repo) })
    assert.deepEqual(await linkOpenCodeLayer(repo, worktree), [".opencode/node_modules"])
    assert.equal(await readFile(path.join(worktree, ".opencode/node_modules/dep/index.js"), "utf8"), "// installed\n")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
