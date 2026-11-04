import { readFileSync } from "node:fs"
import assert from "node:assert/strict"
import { test } from "node:test"

const manifest = JSON.parse(readFileSync(new URL("../../orca-plugin.json", import.meta.url), "utf8"))

test("extensions never include .md or .markdown", () => {
  const extensions = manifest.contributes.customEditors.flatMap((editor) => editor.extensions)
  assert.ok(!extensions.includes(".md"))
  assert.ok(!extensions.includes(".markdown"))
})

test("custom editor is priority option with no replaces", () => {
  for (const editor of manifest.contributes.customEditors) {
    assert.equal(editor.priority, "option")
    assert.equal(editor.replaces, undefined)
  }
})

test("no commands or hooks are contributed", () => {
  assert.equal(manifest.contributes.commands, undefined)
  assert.equal(manifest.contributes.hooks, undefined)
})

test("plugin id does not start with orca- and does not contain obsidian", () => {
  assert.ok(!manifest.id.startsWith("orca-"))
  assert.ok(!manifest.id.toLowerCase().includes("obsidian"))
  for (const editor of manifest.contributes.customEditors) {
    assert.ok(!editor.id.startsWith("orca-"))
    assert.ok(!editor.id.toLowerCase().includes("obsidian"))
  }
})

test("capabilities are exactly workspace:read", () => {
  assert.deepEqual(manifest.capabilities, [{ kind: "workspace:read" }])
})

test("execution profile is trusted-worker with an icon declared", () => {
  assert.equal(manifest.execution, "trusted-worker")
  assert.equal(manifest.icon, "assets/icon.png")
})
