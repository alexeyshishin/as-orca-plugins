import assert from "node:assert/strict"
import { test } from "node:test"
import activate, { openLink, pickWorkspace, resolveTarget } from "../../worker/main.mjs"

const ROOT = "/Users/x/proj"
const path = (target, root = ROOT) => resolveTarget(target, root)

test("a leading slash, ./ and a plain path are the same root-relative path", () => {
  for (const target of ["/a/b.md", "./a/b.md", "a/b.md", ".//a//b.md", "a/./b.md"]) assert.deepEqual(path(target), { ok: true, path: "a/b.md" }, target)
})

test("an OS-absolute path inside the workspace root is stripped to the relative path", () => {
  assert.deepEqual(path("/Users/x/proj/a/b.md"), { ok: true, path: "a/b.md" })
  assert.deepEqual(path("/Users/x/proj/./a/../a/b.md"), { ok: true, path: "a/b.md" })
  assert.deepEqual(path("/Users/x/proj/"), { ok: false, message: "Ссылка указывает на корень воркспейса" })
  assert.deepEqual(path("/Users/x/proj/a.md", "/Users/x/proj/"), { ok: true, path: "a.md" })
})

test("an OS-absolute path next to the root is refused, the prefix trap included", () => {
  assert.deepEqual(path("/Users/x/other/a.md"), { ok: false, message: "Путь вне воркспейса" })
  assert.deepEqual(path("/Users/x/proj-evil/a.md"), { ok: false, message: "Путь вне воркспейса" })
  assert.deepEqual(path("/Users/x/proj-evil/.."), { ok: false, message: "Путь вне воркспейса" })
})

test("an absolute path elsewhere is only ever read as root-relative, never outside the root", () => {
  assert.deepEqual(path("/etc/passwd"), { ok: true, path: "etc/passwd" })
  assert.deepEqual(path("/etc/passwd", ""), { ok: true, path: "etc/passwd" })
  assert.deepEqual(path("/Users/x/proj/a.md", ""), { ok: false, message: "Корень воркспейса недоступен" })
  assert.deepEqual(resolveTarget("/Users/x/proj/a.md", undefined), { ok: false, message: "Корень воркспейса недоступен" })
})

test("parent segments may not climb above the root", () => {
  assert.equal(path("../../etc/passwd").ok, false)
  assert.equal(path("a/../../b").ok, false)
  assert.equal(path("%2e%2e/secret").ok, false)
  assert.equal(path("a/%2E%2E/%2e%2e/b").ok, false)
  assert.equal(path("..%2f..%2fetc/passwd").ok, false)
  assert.deepEqual(path("a/b/../c.md"), { ok: true, path: "a/c.md" })
  assert.deepEqual(path("/../a"), { ok: false, message: "Путь вне воркспейса" })
})

test("drive letters, NUL, empty and oversized targets are refused", () => {
  assert.equal(path("C:/Windows/x").ok, false)
  assert.equal(path("c:\\x").ok, false)
  assert.equal(path("a\u0000b").ok, false)
  assert.equal(path("a%00b").ok, false)
  assert.equal(path("").ok, false)
  assert.equal(path("   ").ok, false)
  assert.equal(path("a".repeat(1025)).ok, false)
  assert.equal(path(undefined).ok, false)
  assert.equal(path("%E0%A4%A").ok, false)
})

test("url-decoding, query, fragment, angle brackets, spaces and backslashes", () => {
  assert.deepEqual(path("my%20docs/read%20me.md"), { ok: true, path: "my docs/read me.md" })
  assert.deepEqual(path("a/b.md?x=1#section"), { ok: true, path: "a/b.md" })
  assert.deepEqual(path("a/b.md#sec"), { ok: true, path: "a/b.md" })
  assert.deepEqual(path("<my docs/a b.md>"), { ok: true, path: "my docs/a b.md" })
  assert.deepEqual(path("a\\b.md"), { ok: true, path: "a/b.md" })
  assert.deepEqual(path("Папка/файл.md"), { ok: true, path: "Папка/файл.md" })
  assert.deepEqual(path("plugins/live-markdown"), { ok: true, path: "plugins/live-markdown" })
  assert.equal(path("#only-fragment").ok, false)
})

const WORKSPACES = [
  { id: "w1", kind: "worktree", name: "main", path: "/Users/x/proj", branch: "main", hostId: null },
  { id: "w2", kind: "worktree", name: "feature", path: "/Users/x/proj-feature", branch: "refs/heads/feature/x", hostId: null },
  { id: "w3", kind: "folder", name: "notes", path: "/Users/x/notes", branch: null, hostId: null }
]

test("the focused workspace is matched by name and branch", () => {
  assert.equal(pickWorkspace({ branch: "main", displayName: "main", terminals: [] }, WORKSPACES).id, "w1")
  assert.equal(pickWorkspace({ branch: "feature/x", displayName: "feature", terminals: [] }, WORKSPACES).id, "w2")
  assert.equal(pickWorkspace({ branch: "", displayName: "notes", terminals: [] }, WORKSPACES).id, "w3")
  assert.equal(pickWorkspace(null, WORKSPACES), null)
  assert.equal(pickWorkspace({ branch: "x", displayName: "zzz", terminals: [] }, WORKSPACES), null)
  assert.equal(pickWorkspace({ branch: "x", displayName: "zzz", terminals: [] }, [WORKSPACES[0]]).id, "w1")
})

test("two workspaces with the same name are told apart by branch, else refused", () => {
  const twins = [
    { id: "a", kind: "worktree", name: "app", path: "/a", branch: "one", hostId: null },
    { id: "b", kind: "worktree", name: "app", path: "/b", branch: "two", hostId: null }
  ]
  assert.equal(pickWorkspace({ branch: "two", displayName: "app", terminals: [] }, twins).id, "b")
  assert.equal(pickWorkspace({ branch: "three", displayName: "app", terminals: [] }, twins), null)
})

function fakeOrca({ context = { branch: "main", displayName: "main", terminals: [] }, workspaces = WORKSPACES, openError = null, missing = [] } = {}) {
  const calls = []
  const handlers = {}
  return {
    calls,
    handlers,
    host: {
      has: (method) => !missing.includes(method),
      async call(method, params) {
        calls.push([method, params])
        if (method === "workspace.readContext") return context
        if (method === "workspace.list") return { workspaces, truncated: false }
        if (method === "editor.open") {
          if (openError) throw openError
          return { opened: true }
        }
        throw new Error(`unexpected ${method}`)
      }
    },
    panels: { handle: (name, handler) => (handlers[name] = handler) }
  }
}

test("activate registers one handler, link.open", async () => {
  const orca = fakeOrca()
  activate(orca)
  assert.deepEqual(Object.keys(orca.handlers), ["link.open"])
  const answer = await orca.handlers["link.open"]({ target: "/plugins/live-markdown/README.md" }, {})
  assert.deepEqual(answer, { ok: true, path: "plugins/live-markdown/README.md", workspace: "main" })
})

test("openLink: reads the context, lists workspaces, opens a root-relative path in the focused workspace", async () => {
  const orca = fakeOrca()
  const answer = await openLink(orca, { target: "./docs/a%20b.md#part" })
  assert.equal(answer.ok, true)
  assert.deepEqual(orca.calls, [
    ["workspace.readContext", {}],
    ["workspace.list", {}],
    ["editor.open", { workspaceId: "w1", path: "docs/a b.md" }]
  ])
})

test("openLink: an OS-absolute path inside the workspace root is opened relative to it", async () => {
  const orca = fakeOrca()
  const answer = await openLink(orca, { target: "/Users/x/proj/README.md" })
  assert.equal(answer.ok, true)
  assert.deepEqual(orca.calls.at(-1), ["editor.open", { workspaceId: "w1", path: "README.md" }])
})

test("openLink: refused targets never reach editor.open, malformed ones not even the host", async () => {
  for (const target of ["../../etc/passwd", "%2e%2e/x", "/Users/x/proj-evil/a.md", "C:/x", "a\u0000", "x".repeat(2000), ""]) {
    const orca = fakeOrca()
    const answer = await openLink(orca, { target })
    assert.equal(answer.ok, false, target)
    assert.ok(!orca.calls.some(([method]) => method === "editor.open"), target)
  }
  const orca = fakeOrca()
  assert.equal((await openLink(orca, { target: "../x" })).ok, false)
  assert.deepEqual(orca.calls, [])
  assert.equal((await openLink(orca, {})).ok, false)
  assert.equal((await openLink(orca, null)).ok, false)
})

test("openLink: no focused workspace, unknown workspace and old hosts give readable refusals", async () => {
  assert.deepEqual(await openLink(fakeOrca({ context: null }), { target: "a.md" }), { ok: false, message: "Нет активного воркспейса" })
  assert.equal((await openLink(fakeOrca({ context: { branch: "q", displayName: "zzz", terminals: [] } }), { target: "a.md" })).message, "Не удалось определить воркспейс")
  assert.equal((await openLink(fakeOrca({ missing: ["editor.open"] }), { target: "a.md" })).ok, false)
})

test("openLink: an editor.open failure becomes a notice, a directory hint when there is no extension", async () => {
  const failure = Object.assign(new Error("file not found"), { code: "action_failed" })
  const file = await openLink(fakeOrca({ openError: failure }), { target: "docs/missing.md" })
  assert.deepEqual(file, { ok: false, message: "Не удалось открыть docs/missing.md: file not found" })
  const directory = await openLink(fakeOrca({ openError: failure }), { target: "plugins/live-markdown" })
  assert.equal(directory.ok, false)
  assert.match(directory.message, /возможно, это каталог/)
})

test("openLink: a host error while resolving the workspace is reported, not thrown", async () => {
  const orca = fakeOrca()
  orca.host.call = async () => {
    throw new Error("boom")
  }
  assert.deepEqual(await openLink(orca, { target: "a.md" }), { ok: false, message: "Не удалось определить воркспейс: boom" })
})
