import { GFM, parser } from "@lezer/markdown"
import { Text } from "@codemirror/state"
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildHangDecorations,
  hangAttributes,
  hangKey,
  measureBlanks,
  measurePrefix,
  planHangLines,
  resolveHangs
} from "../src/list-indent.js"

const gfmParser = parser.configure(GFM)

function plan(source, options = {}) {
  const doc = Text.of(source.split("\n"))
  const tree = gfmParser.parse(source)
  const selections = options.selections ?? [source.length]
  const ranges = selections.map((selection) =>
    typeof selection === "number" ? { from: selection, to: selection } : selection
  )
  const visibleRanges = options.visibleRanges ?? [{ from: 0, to: doc.length }]
  const entries = planHangLines({ tree, doc, ranges, visibleRanges, composing: options.composing })
  return { doc, entries }
}

function summary(doc, entries) {
  return entries.map((entry) => ({
    line: doc.lineAt(entry.from).number,
    kind: entry.kind,
    text: doc.sliceString(entry.textFrom, entry.textFrom + 3),
    key: entry.key,
    owner: entry.owner?.key
  }))
}

test("bullets of every marker at three levels get one item entry per line", () => {
  const source = "- a one\n  * b two\n    + c three\n"
  const { doc, entries } = plan(source)
  assert.deepEqual(summary(doc, entries), [
    { line: 1, kind: "item", text: "a o", key: "plain|- ", owner: undefined },
    { line: 2, kind: "item", text: "b t", key: "plain|  * ", owner: undefined },
    { line: 3, kind: "item", text: "c t", key: "plain|    + ", owner: undefined }
  ])
  assert.deepEqual(
    entries.map((entry) => entry.textFrom - entry.from),
    [2, 4, 6]
  )
})

test("ordered markers keep their own width in the key, nine and ten differ", () => {
  const { doc, entries } = plan("9. nine\n10. ten\n11) eleven\n")
  assert.deepEqual(
    summary(doc, entries).map((entry) => entry.key),
    ["plain|9. ", "plain|10. ", "plain|11) "]
  )
})

test("task item: checkbox variant when the caret is elsewhere, raw variant when it touches the marker", () => {
  const source = "- [ ] task\n- [x] done\n1. [ ] ordered\n\nplain"
  const away = plan(source, { selections: [source.length] })
  assert.deepEqual(
    summary(away.doc, away.entries).map((entry) => entry.key),
    ["task-box|- [ ] ", "task-box|- [x] ", "task-box|1. [ ] "]
  )
  const onBullet = plan(source, { selections: [0] })
  assert.equal(onBullet.entries[0].key, "task-raw|- [ ] ")
  assert.equal(onBullet.entries[1].key, "task-box|- [x] ")
  const onBox = plan(source, { selections: [3] })
  assert.equal(onBox.entries[0].key, "task-raw|- [ ] ")
  const orderedBox = plan(source, { selections: [source.indexOf("[ ] ordered") + 1] })
  assert.equal(orderedBox.entries[2].key, "task-raw|1. [ ] ")
  const orderedMark = plan(source, { selections: [source.indexOf("1.")] })
  assert.equal(orderedMark.entries[2].key, "task-box|1. [ ] ")
})

test("composition shows raw task markers", () => {
  const { entries } = plan("- [ ] task\nplain", { composing: true })
  assert.equal(entries[0].key, "task-raw|- [ ] ")
})

test("text start is the first character after the marker even when it is hidden markup", () => {
  const source = "- **bold** rest\n- `code` rest\n-   spaced rest\n"
  const { doc, entries } = plan(source)
  assert.deepEqual(
    entries.map((entry) => doc.sliceString(entry.textFrom, entry.textFrom + 2)),
    ["**", "`c", "sp"]
  )
  assert.equal(entries[2].key, "plain|-   ")
})

test("empty items, items with the text on the next line and tab-separated markers are skipped", () => {
  const source = "- \n-\n  text on next line\n-\ttabbed\n- ok\n"
  const { doc, entries } = plan(source)
  assert.deepEqual(
    summary(doc, entries).filter((entry) => entry.kind === "item").map((entry) => entry.line),
    [5]
  )
})

test("items whose first block is code, a heading or a quote are not hung", () => {
  const source = "- ```js\n  a\n  ```\n- # head\n- > quote\n- text\n"
  const { doc, entries } = plan(source)
  assert.deepEqual(
    summary(doc, entries).map((entry) => entry.line),
    [6]
  )
})

test("lazy, indented and second-paragraph lines continue the item and share its owner key", () => {
  const source = "- first line\n  indented\nlazy\n\n  second paragraph\n"
  const { doc, entries } = plan(source)
  assert.deepEqual(summary(doc, entries), [
    { line: 1, kind: "item", text: "fir", key: "plain|- ", owner: undefined },
    { line: 2, kind: "continuation", text: "ind", key: "blanks|  ", owner: "plain|- " },
    { line: 3, kind: "continuation", text: "laz", key: null, owner: "plain|- " },
    { line: 5, kind: "continuation", text: "sec", key: "blanks|  ", owner: "plain|- " }
  ])
})

test("task continuation lines belong to the task item", () => {
  const source = "- [ ] task first\n  more task text\n\nplain"
  const { doc, entries } = plan(source)
  assert.deepEqual(summary(doc, entries).map((entry) => [entry.line, entry.kind, entry.owner]), [
    [1, "item", undefined],
    [2, "continuation", "task-box|- [ ] "]
  ])
})

test("a nested item line is its own item, not a continuation of the parent", () => {
  const source = "- parent\n  - child\n  tail of child\n"
  const { doc, entries } = plan(source)
  assert.deepEqual(summary(doc, entries).map((entry) => [entry.line, entry.kind, entry.owner]), [
    [1, "item", undefined],
    [2, "item", undefined],
    [3, "continuation", "plain|  - "]
  ])
})

test("fenced code and tables inside items are not touched", () => {
  const source = "- item\n  ```js\n  const a = 1\n  ```\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n"
  const { doc, entries } = plan(source)
  assert.deepEqual(summary(doc, entries).map((entry) => entry.line), [1])
})

test("quoted items are hung on the marker line only", () => {
  const source = "> - quoted item\n>   quoted tail\n"
  const { doc, entries } = plan(source)
  assert.deepEqual(summary(doc, entries), [{ line: 1, kind: "item", text: "quo", key: "plain|> - ", owner: undefined }])
})

test("front matter list lines are skipped", () => {
  const source = "---\ntags:\n- a\n- b\n---\n\n- real item\n"
  const { doc, entries } = plan(source)
  assert.deepEqual(summary(doc, entries).map((entry) => entry.line), [7])
})

test("only lines inside the visible ranges are planned, off-screen item keys still reach the continuation", () => {
  const source = "- first line\n  continues\n  more\n- second\n"
  const visible = plan(source, { visibleRanges: [{ from: source.indexOf("  more"), to: source.length }] })
  assert.deepEqual(summary(visible.doc, visible.entries).map((entry) => [entry.line, entry.kind, entry.owner]), [
    [3, "continuation", "plain|- "],
    [4, "item", undefined]
  ])
  assert.equal(visible.entries[0].owner.from, 0)
  assert.equal(visible.entries[0].owner.textFrom, 2)
})

test("plain paragraphs and headings produce nothing", () => {
  const { entries } = plan("# heading\n\nparagraph - with dash\n1 not a list\n")
  assert.deepEqual(entries, [])
})

test("resolveHangs: item hang equals the measured prefix width", () => {
  const entries = [{ kind: "item", from: 10, textFrom: 12, key: "plain|- " }]
  const hangs = resolveHangs(entries, new Map([["plain|- ", 10.83]]))
  assert.deepEqual([...hangs], [[10, { pad: 10.83, first: -10.83 }]])
})

test("resolveHangs: unmeasured keys, tiny widths and widths over the limit give no hang", () => {
  const entries = [
    { kind: "item", from: 0, textFrom: 2, key: "a" },
    { kind: "item", from: 10, textFrom: 12, key: "b" },
    { kind: "item", from: 20, textFrom: 22, key: "c" }
  ]
  const widths = new Map([
    ["b", 0.2],
    ["c", 90]
  ])
  assert.equal(resolveHangs(entries, widths, 80).size, 0)
  assert.equal(resolveHangs(entries, widths).size, 1)
})

test("resolveHangs: continuation aligns its first character with the item text", () => {
  const owner = { key: "plain|- ", from: 0, textFrom: 2 }
  const widths = new Map([
    ["plain|- ", 10.83],
    ["blanks|  ", 7.5]
  ])
  const lazy = { kind: "continuation", from: 20, textFrom: 20, key: null, owner }
  const indented = { kind: "continuation", from: 40, textFrom: 42, key: "blanks|  ", owner }
  const hangs = resolveHangs([lazy, indented], widths)
  assert.deepEqual(hangs.get(20), { pad: 10.83, first: 0 })
  assert.deepEqual(hangs.get(40), { pad: 10.83, first: -7.5 })
})

test("resolveHangs: continuation indented deeper than the item text keeps its own column", () => {
  const owner = { key: "plain|- ", from: 0, textFrom: 2 }
  const widths = new Map([
    ["plain|- ", 10.83],
    ["blanks|      ", 22.5]
  ])
  const deep = { kind: "continuation", from: 40, textFrom: 46, key: "blanks|      ", owner }
  assert.deepEqual(resolveHangs([deep], widths).get(40), { pad: 22.5, first: -22.5 })
})

test("resolveHangs: continuation waits until its owner is measured", () => {
  const owner = { key: "plain|- ", from: 0, textFrom: 2 }
  const lazy = { kind: "continuation", from: 20, textFrom: 20, key: null, owner }
  assert.equal(resolveHangs([lazy], new Map()).size, 0)
})

test("hangAttributes writes custom properties consumed by the stylesheet", () => {
  assert.deepEqual(hangAttributes({ pad: 10.83, first: -10.83 }), {
    class: "cm-live-hang",
    style: "--live-hang-pad:10.83px;--live-hang-first:-10.83px"
  })
  assert.equal(hangAttributes({ pad: 4, first: 0 }).style, "--live-hang-pad:4px;--live-hang-first:0px")
})

test("buildHangDecorations makes one line decoration per hung line and shares equal decorations", () => {
  const hangs = new Map([
    [30, { pad: 10.83, first: -10.83 }],
    [5, { pad: 10.83, first: -10.83 }],
    [50, { pad: 17.05, first: -17.05 }]
  ])
  const found = []
  for (const cursor = buildHangDecorations(hangs).iter(); cursor.value; cursor.next()) {
    found.push([cursor.from, cursor.value.spec.attributes.style, cursor.value])
  }
  assert.deepEqual(
    found.map(([from, style]) => [from, style]),
    [
      [5, "--live-hang-pad:10.83px;--live-hang-first:-10.83px"],
      [30, "--live-hang-pad:10.83px;--live-hang-first:-10.83px"],
      [50, "--live-hang-pad:17.05px;--live-hang-first:-17.05px"]
    ]
  )
  assert.equal(found[0][2], found[1][2])
})

test("hangKey differs when any hang changes and ignores identical sets", () => {
  const first = new Map([[5, { pad: 10, first: -10 }]])
  assert.equal(hangKey(first), hangKey(new Map([[5, { pad: 10, first: -10 }]])))
  assert.notEqual(hangKey(first), hangKey(new Map([[5, { pad: 11, first: -11 }]])))
  assert.notEqual(hangKey(first), hangKey(new Map([[6, { pad: 10, first: -10 }]])))
  assert.equal(hangKey(new Map()), "")
})

function fakeView({ viewport = { from: 0, to: 100 }, lineBox = { left: 28, top: 100 }, end }) {
  const calls = []
  return {
    calls,
    viewport,
    domAtPos: () => ({ node: { nodeType: 1, closest: () => ({ getBoundingClientRect: () => lineBox }) } }),
    coordsAtPos: (position, side) => {
      calls.push([position, side])
      return end
    }
  }
}

test("measurePrefix reads the right edge of the character before the text start, relative to the line", () => {
  const view = fakeView({ end: { left: 38.834, top: 104, bottom: 121 } })
  assert.equal(measurePrefix(view, 10, 12), 10.83)
  assert.deepEqual(view.calls, [[12, -1]])
})

test("measurePrefix refuses positions outside the rendered viewport, missing coordinates and later visual rows", () => {
  const good = { left: 38, top: 104, bottom: 121 }
  assert.equal(measurePrefix(fakeView({ end: good }), 150, 152), null)
  assert.equal(measurePrefix(fakeView({ viewport: { from: 20, to: 100 }, end: good }), 10, 12), null)
  assert.equal(measurePrefix(fakeView({ end: null }), 10, 12), null)
  assert.equal(measurePrefix(fakeView({ end: { left: 38, top: 129, bottom: 146 } }), 10, 12), null)
})

test("measureBlanks is the distance between the line start and the text start on one row, whatever hang is applied", () => {
  const coords = new Map([
    [10, { left: 20.5, top: 104, bottom: 121 }],
    [12, { left: 28.1, top: 104, bottom: 121 }]
  ])
  const view = {
    viewport: { from: 0, to: 100 },
    coordsAtPos: (position, side) => (side === (position === 10 ? 1 : -1) ? coords.get(position) : null)
  }
  assert.equal(measureBlanks(view, 10, 12), 7.6)
  assert.equal(measureBlanks({ ...view, viewport: { from: 11, to: 100 } }, 10, 12), null)
  assert.equal(measureBlanks({ ...view, coordsAtPos: () => null }, 10, 12), null)
  const wrapped = { ...view, coordsAtPos: (position) => ({ left: 20, top: position === 10 ? 104 : 130, bottom: position === 10 ? 121 : 147 }) }
  assert.equal(measureBlanks(wrapped, 10, 12), null)
})
