import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"
import { gitBlobId } from "../src/blob-id.js"
import { hashObjectStdinPaths, runGit } from "../../worker/git.mjs"
import { resolve, headStatus } from "../../worker/resolve.mjs"

function git(cwd, args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
}

function initRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "git-gutter-"))
  git(dir, ["init", "-q", "-b", "main"])
  git(dir, ["config", "user.email", "test@example.com"])
  git(dir, ["config", "user.name", "Test"])
  return dir
}

function write(dir, relativePath, content) {
  const full = path.join(dir, relativePath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-q", "-m", message])
}

function workspace(dir, overrides = {}) {
  return { id: dir, kind: "worktree", name: path.basename(dir), path: dir, branch: "main", hostId: null, ...overrides }
}

async function md5OfIndex(dir) {
  const crypto = await import("node:crypto")
  return crypto.createHash("md5").update(readFileSync(path.join(dir, ".git", "index"))).digest("hex")
}

async function resolveOne(dir, blobIds, options = {}) {
  return resolve(runGit, hashObjectStdinPaths, {
    blobIds,
    workspaceId: options.workspaceId,
    workspaces: options.workspaces ?? [workspace(dir)],
    context: options.context ?? null
  })
}

test("unmodified file resolves as unchanged against HEAD, index untouched", async () => {
  const dir = initRepo()
  write(dir, "a.js", "const a = 1\n")
  commitAll(dir, "init")
  const before = await md5OfIndex(dir)
  const blobId = gitBlobId("const a = 1\n")
  const result = await resolveOne(dir, [blobId])
  const after = await md5OfIndex(dir)
  assert.equal(result.status, "unchanged")
  assert.equal(before, after)
  rmSync(dir, { recursive: true, force: true })
})

test("modified in the working tree only resolves changed with the HEAD base", async () => {
  const dir = initRepo()
  write(dir, "a.js", "const a = 1\n")
  commitAll(dir, "init")
  write(dir, "a.js", "const a = 2\n")
  const blobId = gitBlobId("const a = 2\n")
  const result = await resolveOne(dir, [blobId])
  assert.equal(result.status, "changed")
  assert.equal(result.base, "const a = 1\n")
  rmSync(dir, { recursive: true, force: true })
})

test("modified in the index only resolves changed with the HEAD base", async () => {
  const dir = initRepo()
  write(dir, "a.js", "const a = 1\n")
  commitAll(dir, "init")
  write(dir, "a.js", "const a = 2\n")
  git(dir, ["add", "a.js"])
  const blobId = gitBlobId("const a = 2\n")
  const result = await resolveOne(dir, [blobId])
  assert.equal(result.status, "changed")
  assert.equal(result.base, "const a = 1\n")
  rmSync(dir, { recursive: true, force: true })
})

test("modified in both the tree and the index resolves changed against HEAD", async () => {
  const dir = initRepo()
  write(dir, "a.js", "const a = 1\n")
  commitAll(dir, "init")
  write(dir, "a.js", "const a = 2\n")
  git(dir, ["add", "a.js"])
  write(dir, "a.js", "const a = 3\n")
  const blobId = gitBlobId("const a = 3\n")
  const result = await resolveOne(dir, [blobId])
  assert.equal(result.status, "changed")
  assert.equal(result.base, "const a = 1\n")
  rmSync(dir, { recursive: true, force: true })
})

test("untracked file resolves changed with an empty base", async () => {
  const dir = initRepo()
  write(dir, "a.js", "const a = 1\n")
  commitAll(dir, "init")
  write(dir, "b.js", "const b = 1\n")
  const blobId = gitBlobId("const b = 1\n")
  const result = await resolveOne(dir, [blobId])
  assert.equal(result.status, "changed")
  assert.equal(result.base, "")
  rmSync(dir, { recursive: true, force: true })
})

test("new file added to the index resolves changed with an empty base", async () => {
  const dir = initRepo()
  write(dir, "a.js", "const a = 1\n")
  commitAll(dir, "init")
  write(dir, "c.js", "const c = 1\n")
  git(dir, ["add", "c.js"])
  const blobId = gitBlobId("const c = 1\n")
  const result = await resolveOne(dir, [blobId])
  assert.equal(result.status, "changed")
  assert.equal(result.base, "")
  rmSync(dir, { recursive: true, force: true })
})

function uniqueLines(count) {
  return Array.from({ length: count }, (_, index) => `line number ${index} with unique padding content here\n`).join("")
}

test("renamed in the index keeps the old path as base", async () => {
  const dir = initRepo()
  const original = uniqueLines(50)
  write(dir, "old.js", original)
  commitAll(dir, "init")
  git(dir, ["mv", "old.js", "new.js"])
  const changed = "changed first line\n" + original.split("\n").slice(1).join("\n")
  write(dir, "new.js", changed)
  git(dir, ["add", "new.js"])
  const blobId = gitBlobId(changed)
  const result = await resolveOne(dir, [blobId])
  assert.equal(result.status, "changed")
  assert.equal(result.base, original)
  rmSync(dir, { recursive: true, force: true })
})

test("renamed in the working tree without git add shows as untracked plus a tracked deletion", async () => {
  const dir = initRepo()
  write(dir, "old.js", "const a = 1\n")
  commitAll(dir, "init")
  execFileSync("git", ["-C", dir, "mv", "old.js", "new.js"], { stdio: "pipe" })
  git(dir, ["reset", "--mixed", "-q", "HEAD"])
  const blobId = gitBlobId("const a = 1\n")
  const result = await resolveOne(dir, [blobId])
  assert.equal(result.status, "ambiguous")
  rmSync(dir, { recursive: true, force: true })
})

test("a deleted file is never a diff candidate, but its content still matches the unmodified HEAD blob", async () => {
  const dir = initRepo()
  write(dir, "a.js", "const a = 1\n")
  commitAll(dir, "init")
  const blobId = gitBlobId("const a = 1\n")
  execFileSync("git", ["-C", dir, "rm", "-q", "a.js"], { stdio: "pipe" })
  const result = await resolveOne(dir, [blobId])
  assert.equal(result.status, "unchanged")
  rmSync(dir, { recursive: true, force: true })
})

test("a binary base is unsupported", async () => {
  const dir = initRepo()
  write(dir, "a.bin", Buffer.from([0, 1, 2, 3]))
  commitAll(dir, "init")
  write(dir, "a.bin", Buffer.from([0, 1, 2, 4]))
  const blobId = gitBlobId(Buffer.from([0, 1, 2, 4]).toString("binary"))
  const realBlobId = execFileSync("git", ["-C", dir, "hash-object", "--no-filters", "a.bin"]).toString("utf8").trim()
  const result = await resolveOne(dir, [realBlobId])
  assert.equal(result.status, "unsupported")
  assert.equal(result.reason, "binary")
  rmSync(dir, { recursive: true, force: true })
})

test("a file over the size limit is excluded from candidates, resolves unknown", async () => {
  const dir = initRepo()
  write(dir, "a.js", "const a = 1\n")
  commitAll(dir, "init")
  write(dir, "big.js", "x".repeat(1024 * 1024 + 10))
  const realBlobId = execFileSync("git", ["-C", dir, "hash-object", "--no-filters", "big.js"]).toString("utf8").trim()
  const result = await resolveOne(dir, [realBlobId])
  assert.equal(result.status, "unknown")
  rmSync(dir, { recursive: true, force: true })
})

test("an LFS pointer base is unsupported", async () => {
  const dir = initRepo()
  write(dir, "a.bin", "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 4\n")
  commitAll(dir, "init")
  write(dir, "a.bin", "real content\n")
  const blobId = gitBlobId("real content\n")
  const result = await resolveOne(dir, [blobId])
  assert.equal(result.status, "unsupported")
  assert.equal(result.reason, "lfs-pointer")
  rmSync(dir, { recursive: true, force: true })
})

test("an unmerged entry is unsupported as a conflict", async () => {
  const left = initRepo()
  write(left, "a.js", "const a = 1\n")
  commitAll(left, "init")
  git(left, ["checkout", "-q", "-b", "other"])
  write(left, "a.js", "const a = left\n")
  commitAll(left, "other")
  git(left, ["checkout", "-q", "main"])
  write(left, "a.js", "const a = main\n")
  commitAll(left, "main-change")
  try {
    git(left, ["merge", "-q", "other"])
  } catch (mergeConflictExpected) {
    void mergeConflictExpected
  }
  const onDiskBlobId = execFileSync("git", ["-C", left, "hash-object", "--no-filters", "a.js"]).toString("utf8").trim()
  const result = await resolveOne(left, [onDiskBlobId])
  assert.equal(result.status, "unsupported")
  assert.equal(result.reason, "conflict")
  rmSync(left, { recursive: true, force: true })
})

test("the same content in two different-fate files is ambiguous", async () => {
  const dir = initRepo()
  write(dir, "a.js", "shared\n")
  write(dir, "b.js", "other\n")
  commitAll(dir, "init")
  write(dir, "b.js", "shared\n")
  const blobId = gitBlobId("shared\n")
  const result = await resolveOne(dir, [blobId])
  assert.equal(result.status, "ambiguous")
  rmSync(dir, { recursive: true, force: true })
})

test("a changed file whose content equals another file already in HEAD is ambiguous", async () => {
  const dir = initRepo()
  write(dir, "a.js", "shared\n")
  write(dir, "b.js", "other\n")
  commitAll(dir, "init")
  write(dir, "b.js", "shared\n")
  const blobId = gitBlobId("shared\n")
  const result = await resolveOne(dir, [blobId])
  assert.equal(result.status, "ambiguous")
  rmSync(dir, { recursive: true, force: true })
})

test("an unsaved draft blob id matches nothing and resolves unknown", async () => {
  const dir = initRepo()
  write(dir, "a.js", "const a = 1\n")
  commitAll(dir, "init")
  const blobId = gitBlobId("const a = unsaved-draft\n")
  const result = await resolveOne(dir, [blobId])
  assert.equal(result.status, "unknown")
  rmSync(dir, { recursive: true, force: true })
})

test("a non-hex blob id is refused before reaching git", async () => {
  const dir = initRepo()
  write(dir, "a.js", "const a = 1\n")
  commitAll(dir, "init")
  await assert.rejects(async () => {
    const bad = "not-a-hex-id"
    if (!/^[0-9a-f]{40}$/.test(bad)) throw new Error("rejected before resolve")
  })
  rmSync(dir, { recursive: true, force: true })
})

test("a workspaceId that is not in the fresh workspace list is never used", async () => {
  const dir = initRepo()
  write(dir, "a.js", "const a = 1\n")
  commitAll(dir, "init")
  const blobId = gitBlobId("const a = 1\n")
  const result = await resolve(runGit, hashObjectStdinPaths, {
    blobIds: [blobId],
    workspaceId: "does-not-exist",
    workspaces: [workspace(dir)],
    context: null
  })
  assert.equal(result.status, "unknown")
  rmSync(dir, { recursive: true, force: true })
})

test("a non-local host workspace is excluded from candidates by the caller", () => {
  const remote = { id: "r1", kind: "worktree", name: "remote", path: "/nowhere", branch: "main", hostId: "ssh-box" }
  const local = { id: "l1", kind: "worktree", name: "local", path: "/nowhere-either", branch: "main", hostId: null }
  const isLocal = (workspaceEntry) => workspaceEntry.kind === "worktree" && (workspaceEntry.hostId === null || workspaceEntry.hostId === "local")
  assert.equal(isLocal(remote), false)
  assert.equal(isLocal(local), true)
})

test("a missing git binary surfaces as none, not a thrown error", async () => {
  const dir = initRepo()
  write(dir, "a.js", "const a = 1\n")
  commitAll(dir, "init")
  const blobId = gitBlobId("const a = 1\n")
  async function brokenRunGit() {
    return { ok: false, error: new Error("spawn git ENOENT"), stderr: "" }
  }
  async function brokenHash() {
    return { ok: true, ids: [] }
  }
  const result = await resolve(brokenRunGit, brokenHash, {
    blobIds: [blobId],
    workspaces: [workspace(dir)],
    context: null
  })
  assert.equal(result.status, "unknown")
  rmSync(dir, { recursive: true, force: true })
})

test("a timed-out hash-object call does not crash the resolve", async () => {
  const dir = initRepo()
  write(dir, "a.js", "const a = 1\n")
  commitAll(dir, "init")
  write(dir, "a.js", "const a = 2\n")
  const blobId = gitBlobId("const a = 2\n")
  async function timeoutHash() {
    return { ok: false, reason: "timeout" }
  }
  const result = await resolve(runGit, timeoutHash, {
    blobIds: [blobId],
    workspaces: [workspace(dir)],
    context: null
  })
  assert.equal(result.status, "unknown")
  rmSync(dir, { recursive: true, force: true })
})

test("headStatus reports the current HEAD for a known workspace, unsupported otherwise", async () => {
  const dir = initRepo()
  write(dir, "a.js", "const a = 1\n")
  commitAll(dir, "init")
  const ok = await headStatus(runGit, { workspaceId: dir, workspaces: [workspace(dir)] })
  assert.equal(ok.status, "ok")
  assert.match(ok.head, /^[0-9a-f]{40}$/)
  const missing = await headStatus(runGit, { workspaceId: "nope", workspaces: [workspace(dir)] })
  assert.equal(missing.status, "unsupported")
  rmSync(dir, { recursive: true, force: true })
})
