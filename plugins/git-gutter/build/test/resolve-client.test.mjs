import assert from "node:assert/strict"
import { test } from "node:test"
import { gutterHead, resolveGutter } from "../src/resolve-client.js"

function withGlobalOrca(value, run) {
  const previous = globalThis.orca
  globalThis.orca = value
  return run().finally(() => {
    globalThis.orca = previous
  })
}

test("resolveGutter omits workspaceId from the request when it has none yet", async () => {
  const calls = []
  await withGlobalOrca(
    { plugin: { request: (name, input) => (calls.push([name, input]), Promise.resolve({ status: "unknown" })) } },
    async () => {
      const result = await resolveGutter(["a".repeat(40)], undefined)
      assert.equal(result.status, "unknown")
    }
  )
  assert.deepEqual(calls, [["gutter.resolve", { blobIds: ["a".repeat(40)] }]])
})

test("resolveGutter includes workspaceId once one is known", async () => {
  const calls = []
  await withGlobalOrca(
    { plugin: { request: (name, input) => (calls.push([name, input]), Promise.resolve({ status: "unchanged" })) } },
    async () => {
      await resolveGutter(["a".repeat(40)], "w1")
    }
  )
  assert.deepEqual(calls, [["gutter.resolve", { blobIds: ["a".repeat(40)], workspaceId: "w1" }]])
})

test("resolveGutter falls back to orca.host.call when orca.plugin.request is absent", async () => {
  const calls = []
  await withGlobalOrca(
    {
      host: {
        call: (method, params) => {
          calls.push([method, params])
          return Promise.resolve({ output: { status: "unknown" } })
        }
      }
    },
    async () => {
      const result = await resolveGutter(["a".repeat(40)], undefined)
      assert.equal(result.status, "unknown")
    }
  )
  assert.equal(calls[0][0], "plugin.request")
  assert.equal(calls[0][1].name, "gutter.resolve")
})

test("resolveGutter propagates a rejected request instead of swallowing it", async () => {
  await withGlobalOrca(
    { plugin: { request: () => Promise.reject(new Error("timeout")) } },
    async () => {
      await assert.rejects(() => resolveGutter(["a".repeat(40)], undefined), /timeout/)
    }
  )
})

test("gutterHead always sends the workspaceId it is given, even when undefined", async () => {
  const calls = []
  await withGlobalOrca(
    { plugin: { request: (name, input) => (calls.push([name, input]), Promise.resolve({ status: "unsupported" })) } },
    async () => {
      const result = await gutterHead(undefined)
      assert.equal(result.status, "unsupported")
    }
  )
  assert.deepEqual(calls, [["gutter.head", { workspaceId: undefined }]])
})

test("gutterHead propagates a rejected request", async () => {
  await withGlobalOrca(
    { plugin: { request: () => Promise.reject(new Error("unavailable")) } },
    async () => {
      await assert.rejects(() => gutterHead("w1"), /unavailable/)
    }
  )
})
