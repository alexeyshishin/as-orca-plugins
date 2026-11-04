import { EditorState, Text } from "@codemirror/state"
import assert from "node:assert/strict"
import { test } from "node:test"
import { computeEntries } from "../src/entries.js"
import { inlineParser } from "../src/inline-preview.js"
import { cellTextFilter } from "../src/table-cells.js"

function names(source) {
  const found = []
  inlineParser.parse(source).iterate({
    enter(node) {
      found.push(node.name)
    }
  })
  return found
}

function analyze(source, selections, composing = false) {
  const doc = Text.of([source])
  const ranges = selections.map((selection) => (typeof selection === "number" ? { from: selection, to: selection } : selection))
  const entries = computeEntries({ tree: inlineParser.parse(source), doc, ranges, visibleRanges: [{ from: 0, to: doc.length }], composing })
  const words = (kind) => entries.filter((entry) => entry.kind === kind).map((entry) => `${doc.sliceString(entry.from, entry.to)}@${entry.from}`).sort()
  return { entries, hide: words("hide"), dim: words("dim"), style: words("style") }
}

test("the inline parser produces no block nodes, whatever the cell text starts with", () => {
  for (const source of ["# **a**", "- **a**", "> **q**", "1. __u__", "    **x**", "---", "```js", "| a |", "[ ] **t**", "<div>**x**</div>"]) {
    const found = names(source)
    for (const block of ["ATXHeading1", "BulletList", "OrderedList", "Blockquote", "CodeBlock", "FencedCode", "HorizontalRule", "Table", "Task", "HTMLBlock", "ListItem"]) {
      assert.ok(!found.includes(block), `${source}: ${block}`)
    }
  }
  assert.ok(names("# **a**").includes("StrongEmphasis"))
  assert.ok(names("    **x**").includes("StrongEmphasis"))
})

test("a cell with bold and code keeps both rendered and opens only the node under the caret", () => {
  const source = "**bold** and `code`"
  const inBold = analyze(source, [4])
  assert.deepEqual(inBold.style, ["**bold**@0", "`code`@13"])
  assert.deepEqual(inBold.dim, ["**@0", "**@6"])
  assert.deepEqual(inBold.hide, ["`@13", "`@18"])
  const inCode = analyze(source, [16])
  assert.deepEqual(inCode.dim, ["`@13", "`@18"])
  assert.deepEqual(inCode.hide, ["**@0", "**@6"])
  const between = analyze(source, [10])
  assert.deepEqual(between.dim, [])
  assert.equal(between.hide.length, 4)
  assert.deepEqual(between.style, ["**bold**@0", "`code`@13"])
})

test("the caret at either edge of a node opens that node", () => {
  const source = "**bold** and `code`"
  assert.deepEqual(analyze(source, [0]).dim, ["**@0", "**@6"])
  assert.deepEqual(analyze(source, [8]).dim, ["**@0", "**@6"])
  assert.deepEqual(analyze(source, [13]).dim, ["`@13", "`@18"])
  assert.deepEqual(analyze(source, [19]).dim, ["`@13", "`@18"])
})

test("selecting the whole cell opens every node, composition keeps markers visible", () => {
  const source = "**bold** and `code`"
  const all = analyze(source, [{ from: 0, to: source.length }])
  assert.equal(all.dim.length, 4)
  assert.deepEqual(all.hide, [])
  const composing = analyze(source, [10], true)
  assert.deepEqual(composing.hide, [])
  assert.equal(composing.dim.length, 4)
})

test("an escaped pipe and plain text produce no markers", () => {
  const source = "a \\| b"
  const result = analyze(source, [2])
  assert.deepEqual(result.entries, [])
})

function apply(source, change, selection) {
  const state = EditorState.create({ doc: source, selection: { anchor: selection }, extensions: [cellTextFilter] })
  return state.update({ changes: change, selection: { anchor: change.from + change.insert.length }, userEvent: "input.type" }).state
}

test("the cell filter escapes a typed pipe and keeps the caret after it", () => {
  const state = apply("ab", { from: 1, insert: "|" }, 1)
  assert.equal(state.doc.toString(), "a\\|b")
  assert.equal(state.selection.main.head, 3)
})

test("the cell filter leaves escaped pipes alone", () => {
  assert.equal(apply("ab", { from: 1, insert: "\\|" }, 1).doc.toString(), "a\\|b")
})

test("the cell filter turns pasted line breaks into spaces and escapes pasted pipes", () => {
  const start = EditorState.create({ doc: "", extensions: [cellTextFilter] })
  const state = start.update(start.replaceSelection("one\ntwo|three\r\nfour")).state
  assert.equal(state.doc.toString(), "one two\\|three four")
  assert.equal(state.doc.lines, 1)
})

test("the cell filter ignores transactions that only move the selection", () => {
  const state = EditorState.create({ doc: "a|b", extensions: [cellTextFilter] })
  assert.equal(state.update({ selection: { anchor: 1 } }).state.doc.toString(), "a|b")
})

test("a link in a cell: label rendered, syntax hidden away from the caret and dimmed at it", () => {
  const source = "[plugins/live-markdown](plugins/live-markdown) and **b**"
  const away = analyze(source, [50])
  assert.deepEqual(away.entries.filter((entry) => entry.kind === "link").map((entry) => entry.target), ["plugins/live-markdown"])
  assert.equal(away.hide.length, 4)
  const inLabel = analyze(source, [5])
  assert.deepEqual(inLabel.dim, ["](plugins/live-markdown)@22", "[@0"].sort())
  assert.equal(inLabel.hide.length, 2)
})
