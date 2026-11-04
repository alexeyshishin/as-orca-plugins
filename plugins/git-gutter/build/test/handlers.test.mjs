import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"
import { gitBlobId } from "../src/blob-id.js"
import activate, { handleHead, handleResolve } from "../../worker/main.mjs"

const VALID_BLOB_ID = "0".repeat(40)

function git(cwd, args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
}

function initRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "git-gutter-handlers-"))
  git(dir, ["init", "-q", "-b", "main"])
  git(dir, ["config", "user.email", "test@example.com"])
  git(dir, ["config", "user.name", "Test"])
  writeFileSync(path.join(dir, "a.js"), "const a = 1\n")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-q", "-m", "init"])
  return dir
}

function workspace(dir) {
  return { id: dir, kind: "worktree", name: path.basename(dir), path: dir, branch: "main", hostId: null }
}

function fakeOrca({ workspaces = [], context = null } = {}) {
  const calls = []
  const handlers = {}
  return {
    calls,
    handlers,
    host: {
      has: () => true,
      async call(method, params) {
        calls.push([method, params])
        if (method === "workspace.list") return { workspaces, truncated: false }
        if (method === "workspace.readContext") return context
        throw new Error(`unexpected ${method}`)
      }
    },
    panels: { handle: (name, handler) => (handlers[name] = handler) }
  }
}

test("resolve without a workspaceId hint never throws and reads workspace.list", async () => {
  const orca = fakeOrca({ workspaces: [] })
  const result = await handleResolve(orca, { blobIds: [VALID_BLOB_ID] })
  assert.equal(result.status, "unknown")
  assert.ok(orca.calls.some(([method]) => method === "workspace.list"))
})

test("resolve with a workspaceId hint absent from the fresh listing falls back to unhinted search", async () => {
  const orca = fakeOrca({ workspaces: [] })
  const result = await handleResolve(orca, { blobIds: [VALID_BLOB_ID], workspaceId: "does-not-exist" })
  assert.equal(result.status, "unknown")
})

test("resolve with a valid local workspaceId resolves against the real repository", async () => {
  const dir = initRepo()
  const orca = fakeOrca({ workspaces: [workspace(dir)] })
  const blobId = gitBlobId("const a = 1\n")
  const result = await handleResolve(orca, { blobIds: [blobId], workspaceId: dir })
  assert.equal(result.status, "unchanged")
  rmSync(dir, { recursive: true, force: true })
})

test("resolve rejects malformed blobIds before any host call", async () => {
  const orca = fakeOrca()
  const result = await handleResolve(orca, { blobIds: ["not-hex"] })
  assert.deepEqual(result, { status: "unsupported", reason: "invalid-input" })
  assert.deepEqual(orca.calls, [])
})

test("resolve response never carries diagnosticCandidateBlobIds, paths or file content", async () => {
  const dir = initRepo()
  const orca = fakeOrca({ workspaces: [workspace(dir)] })
  const blobId = gitBlobId("const a = 1\n")
  const result = await handleResolve(orca, { blobIds: [blobId], workspaceId: dir })
  assert.equal("diagnosticCandidateBlobIds" in result, false)
  assert.deepEqual(Object.keys(result).sort(), ["head", "status", "workspaceId"].sort())
  rmSync(dir, { recursive: true, force: true })
})

test("head without a workspaceId hint is refused, not thrown", async () => {
  const orca = fakeOrca({ workspaces: [] })
  const result = await handleHead(orca, {})
  assert.deepEqual(result, { status: "unsupported", reason: "invalid-input" })
})

test("head with an unknown workspaceId is refused, not thrown", async () => {
  const orca = fakeOrca({ workspaces: [] })
  const result = await handleHead(orca, { workspaceId: "ghost" })
  assert.deepEqual(result, { status: "unsupported", reason: "invalid-input" })
})

test("head with a valid local workspaceId reports the real HEAD", async () => {
  const dir = initRepo()
  const orca = fakeOrca({ workspaces: [workspace(dir)] })
  const result = await handleHead(orca, { workspaceId: dir })
  assert.equal(result.status, "ok")
  assert.match(result.head, /^[0-9a-f]{40}$/)
  rmSync(dir, { recursive: true, force: true })
})

test("activate registers exactly gutter.resolve and gutter.head", () => {
  const orca = fakeOrca()
  activate(orca)
  assert.deepEqual(Object.keys(orca.handlers).sort(), ["gutter.head", "gutter.resolve"])
})

test("activate's gutter.resolve handler is wired through to handleResolve without throwing on an empty listing", async () => {
  const orca = fakeOrca({ workspaces: [] })
  activate(orca)
  const result = await orca.handlers["gutter.resolve"]({ blobIds: [VALID_BLOB_ID] })
  assert.equal(result.status, "unknown")
})

test("activate's gutter.head handler is wired through to handleHead without throwing on a missing workspaceId", async () => {
  const orca = fakeOrca({ workspaces: [] })
  activate(orca)
  const result = await orca.handlers["gutter.head"]({})
  assert.deepEqual(result, { status: "unsupported", reason: "invalid-input" })
})
