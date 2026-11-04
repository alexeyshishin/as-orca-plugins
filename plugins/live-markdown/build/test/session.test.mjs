import { EditorState, Text, Transaction } from "@codemirror/state"
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  bindSession,
  detectFormat,
  diffRange,
  mergeThreeWay,
  toEditorText,
  toFileText
} from "../src/sync.js"

function createFakeSession({ text, readOnly = false, merge }) {
  const replaceListeners = []
  const edits = []
  let version = 1
  let base = text
  let value = text
  let pending = false
  let conflictNext = false
  let changeCalls = 0

  const notify = (next) => replaceListeners.forEach((listener) => listener(next))

  const session = {
    get value() {
      return value
    },
    get readOnly() {
      return readOnly
    },
    change(next) {
      changeCalls++
      if (readOnly) return
      value = next
      pending = true
    },
    onReplace(listener) {
      replaceListeners.push(listener)
      return { dispose() {} }
    },
    async flush() {
      if (!pending) return
      if (conflictNext) {
        conflictNext = false
        edits.push({ baseVersion: version, text: value, refused: "conflict" })
        const merged = merge(base, host.disk, value)
        value = merged
        notify(merged)
        version++
        edits.push({ baseVersion: version, text: merged })
        host.disk = merged
        base = merged
        pending = false
        return
      }
      edits.push({ baseVersion: version, text: value })
      host.disk = value
      base = value
      version++
      pending = false
    }
  }

  const host = {
    session,
    edits,
    disk: text,
    get changeCalls() {
      return changeCalls
    },
    conflictNext() {
      conflictNext = true
    },
    replaceOutside(next) {
      host.disk = next
      version++
      if (pending && merge) {
        const merged = merge(base, next, value)
        value = merged
        base = next
        notify(merged)
        return
      }
      value = next
      base = next
      pending = false
      notify(next)
    }
  }
  return host
}

function createStateEditor() {
  let state = null
  let listener = () => {}
  return {
    open(text, readOnly) {
      state = EditorState.create({
        doc: text,
        extensions: [EditorState.lineSeparator.of("\n"), EditorState.readOnly.of(readOnly)]
      })
    },
    text: () => state.sliceDoc(),
    replace({ from, to, insert }) {
      state = state.update({
        changes: { from, to, insert: Text.of(insert.split("\n")) },
        annotations: Transaction.remote.of(true)
      }).state
    },
    onUserChange(next) {
      listener = next
    },
    get selection() {
      return state.selection.main
    },
    select(anchor) {
      state = state.update({ selection: { anchor } }).state
    },
    type(position, inserted) {
      state = state.update({ changes: { from: position, insert: inserted }, userEvent: "input.type" }).state
      listener(state.sliceDoc())
    },
    remove(from, to) {
      state = state.update({ changes: { from, to }, userEvent: "delete.backward" }).state
      listener(state.sliceDoc())
    }
  }
}

function open(options) {
  const host = createFakeSession({ merge: mergeThreeWay, ...options })
  const editor = createStateEditor()
  const binding = bindSession(host.session, editor)
  return { host, editor, binding }
}

const FIXTURES = {
  lf: "# Title\n\nbody **bold**\n",
  crlf: "# Title\r\n\r\nbody **bold**\r\n",
  bom: "﻿# Title\n\nbody\n",
  bomCrlf: "﻿# Заголовок\r\n\r\nтекст без правок\r\n",
  noFinalNewline: "# Title\n\nno newline at end",
  noFinalNewlineCrlf: "# Title\r\n\r\nno newline at end",
  empty: "",
  bomOnly: "﻿"
}

for (const [name, raw] of Object.entries(FIXTURES)) {
  test(`open without editing sends nothing and round trips byte for byte: ${name}`, async () => {
    const { host, editor, binding } = open({ text: raw })
    await binding.flush()
    assert.equal(host.edits.length, 0)
    assert.equal(host.changeCalls, 0)
    assert.equal(host.disk, raw)
    const format = detectFormat(raw)
    assert.equal(editor.text(), toEditorText(raw, format))
    assert.equal(toFileText(editor.text(), format), raw)
  })

  test(`typing then undoing the typing writes the original bytes: ${name}`, async () => {
    const { host, editor, binding } = open({ text: raw })
    editor.type(0, "x")
    editor.remove(0, 1)
    await binding.flush()
    assert.equal(host.edits.length, 1)
    assert.equal(host.edits[0].text, raw)
  })
}

test("a real edit keeps CRLF, BOM and the missing final newline", async () => {
  const crlf = open({ text: FIXTURES.bomCrlf })
  crlf.editor.type(crlf.editor.text().length, "новая строка\n")
  await crlf.binding.flush()
  assert.equal(crlf.host.edits[0].text, `${FIXTURES.bomCrlf}новая строка\r\n`)

  const bare = open({ text: FIXTURES.noFinalNewline })
  bare.editor.type(2, "!")
  await bare.binding.flush()
  assert.equal(bare.host.edits[0].text, "# !Title\n\nno newline at end")
})

test("editor text never contains the carriage return or the BOM of the file", () => {
  const { editor } = open({ text: FIXTURES.bomCrlf })
  assert.ok(!editor.text().includes("\r"))
  assert.ok(!editor.text().includes("﻿"))
})

test("an outside replace updates the editor as a minimal change without sending an edit back", async () => {
  const { host, editor, binding } = open({ text: "alpha\nbeta\ngamma\n" })
  editor.select(8)
  host.replaceOutside("alpha\nbeta\ngamma\ndelta\n")
  assert.equal(editor.text(), "alpha\nbeta\ngamma\ndelta\n")
  assert.equal(editor.selection.head, 8)
  host.replaceOutside("ALPHA!\nbeta\ngamma\ndelta\n")
  assert.equal(editor.text(), "ALPHA!\nbeta\ngamma\ndelta\n")
  assert.equal(editor.selection.head, 9)
  await binding.flush()
  assert.equal(host.edits.length, 0)
  assert.equal(host.changeCalls, 0)
})

test("an outside replace into a different line ending switches the format used for later edits", async () => {
  const { host, editor, binding } = open({ text: "one\ntwo\n" })
  host.replaceOutside("one\r\ntwo\r\n")
  assert.equal(editor.text(), "one\ntwo\n")
  editor.type(0, "x")
  await binding.flush()
  assert.equal(host.edits[0].text, "xone\r\ntwo\r\n")
})

test("a conflict is merged: both the outside write and the draft survive", async () => {
  const { host, editor, binding } = open({ text: "one\ntwo\nthree\nfour\n" })
  editor.type(editor.text().indexOf("four"), "my ")
  host.conflictNext()
  host.disk = "one\nTWO\nthree\nfour\n"
  await binding.flush()
  assert.equal(host.edits[0].refused, "conflict")
  assert.equal(host.edits[1].text, "one\nTWO\nthree\nmy four\n")
  assert.equal(editor.text(), "one\nTWO\nthree\nmy four\n")
})

test("an outside write while the tab is dirty reaches the editor through merge and keeps the draft", async () => {
  const { host, editor, binding } = open({ text: "one\ntwo\nthree\n" })
  editor.type(0, "draft ")
  host.replaceOutside("one\ntwo\nthree\nagent line\n")
  assert.equal(editor.text(), "draft one\ntwo\nthree\nagent line\n")
  await binding.flush()
  assert.equal(host.edits.at(-1).text, "draft one\ntwo\nthree\nagent line\n")
})

test("read-only: typing never reaches the session and no edit is sent", async () => {
  const { host, editor, binding } = open({ text: "locked\n", readOnly: true })
  editor.type(0, "x")
  await binding.flush()
  assert.equal(host.changeCalls, 0)
  assert.equal(host.edits.length, 0)
  assert.equal(host.disk, "locked\n")
})

test("flush sends the pending edit immediately", async () => {
  const { host, editor, binding } = open({ text: "a\n" })
  editor.type(1, "b")
  assert.equal(host.edits.length, 0)
  await binding.flush()
  assert.deepEqual(host.edits, [{ baseVersion: 1, text: "ab\n" }])
})

test("diffRange returns the smallest change and null for equal strings", () => {
  assert.equal(diffRange("same", "same"), null)
  assert.deepEqual(diffRange("hello world", "hello brave world"), { from: 6, to: 6, insert: "brave " })
  assert.deepEqual(diffRange("abcdef", "abXef"), { from: 2, to: 4, insert: "X" })
  assert.deepEqual(diffRange("", "new"), { from: 0, to: 0, insert: "new" })
  assert.deepEqual(diffRange("old", ""), { from: 0, to: 3, insert: "" })
})

test("diffRange never splits a surrogate pair", () => {
  const before = "a\u{1F389}b"
  const after = "a\u{1F38A}b"
  const change = diffRange(before, after)
  assert.deepEqual(change, { from: 1, to: 3, insert: "\u{1F38A}" })
  assert.equal(before.slice(0, change.from) + change.insert + before.slice(change.to), after)
})

test("detectFormat picks the dominant line ending and reports the BOM", () => {
  assert.deepEqual(detectFormat("a\r\nb\r\n"), { bom: false, crlf: true })
  assert.deepEqual(detectFormat("a\nb\r\nc\n"), { bom: false, crlf: false })
  assert.deepEqual(detectFormat("﻿a\n"), { bom: true, crlf: false })
  assert.deepEqual(detectFormat(""), { bom: false, crlf: false })
})

test("mergeThreeWay: only one side changed", () => {
  assert.equal(mergeThreeWay("a\nb\n", "a\nB\n", "a\nb\n"), "a\nB\n")
  assert.equal(mergeThreeWay("a\nb\n", "a\nb\n", "A\nb\n"), "A\nb\n")
  assert.equal(mergeThreeWay("a\n", "a\n", "a\n"), "a\n")
})

test("mergeThreeWay: disjoint changes are both applied", () => {
  assert.equal(mergeThreeWay("1\n2\n3\n4\n5\n", "1\nTWO\n3\n4\n5\n", "1\n2\n3\n4\nFIVE\n"), "1\nTWO\n3\n4\nFIVE\n")
  assert.equal(mergeThreeWay("1\n2\n3\n", "0\n1\n2\n3\n", "1\n2\n3\n4\n"), "0\n1\n2\n3\n4\n")
})

test("mergeThreeWay: identical changes on both sides collapse", () => {
  assert.equal(mergeThreeWay("1\n2\n3\n", "1\nX\n3\n", "1\nX\n3\n"), "1\nX\n3\n")
})

test("mergeThreeWay: overlapping changes keep both sides between conflict markers", () => {
  assert.equal(
    mergeThreeWay("1\n2\n3\n", "1\nOUT\n3\n", "1\nMINE\n3\n"),
    "1\n<<<<<<< mine\nMINE\n=======\nOUT\n>>>>>>> outside\n3\n"
  )
})

test("mergeThreeWay: both sides insert at the same place", () => {
  assert.equal(
    mergeThreeWay("a\nb\n", "a\nout\nb\n", "a\nmine\nb\n"),
    "a\n<<<<<<< mine\nmine\n=======\nout\n>>>>>>> outside\nb\n"
  )
})

test("mergeThreeWay: CRLF documents keep CRLF markers and lines", () => {
  assert.equal(
    mergeThreeWay("1\r\n2\r\n3\r\n", "1\r\nOUT\r\n3\r\n", "1\r\nMINE\r\n3\r\n"),
    "1\r\n<<<<<<< mine\r\nMINE\r\n=======\r\nOUT\r\n>>>>>>> outside\r\n3\r\n"
  )
})

test("mergeThreeWay: a missing final newline survives a non-conflicting merge", () => {
  assert.equal(mergeThreeWay("a\nb", "A\nb", "a\nb\nc"), "A\nb\nc")
})

test("mergeThreeWay: large documents with a small edit on each side stay fast", () => {
  const lines = Array.from({ length: 20000 }, (_, index) => `line ${index}\n`)
  const base = lines.join("")
  const outside = lines.map((line, index) => (index === 100 ? "outside\n" : line)).join("")
  const mine = lines.map((line, index) => (index === 19000 ? "mine\n" : line)).join("")
  const started = performance.now()
  const merged = mergeThreeWay(base, outside, mine)
  const elapsed = performance.now() - started
  console.log(`# merge of 20k lines: ${elapsed.toFixed(2)} ms`)
  assert.ok(merged.includes("outside\n") && merged.includes("mine\n"))
  assert.ok(!merged.includes("<<<<<<<"))
  assert.ok(elapsed < 1500, `took ${elapsed} ms`)
})
