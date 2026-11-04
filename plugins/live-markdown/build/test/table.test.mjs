import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { syntaxTree } from "@codemirror/language"
import { EditorState, Text } from "@codemirror/state"
import { GFM, parser } from "@lezer/markdown"
import assert from "node:assert/strict"
import { test } from "node:test"
import { computeEntries } from "../src/live-preview.js"
import {
  buildTableModel,
  collectTables,
  isTableRendered,
  MAX_TABLE_LENGTH,
  MAX_TABLE_LINES,
  renderedTables,
  tableExtension
} from "../src/table.js"

const gfmParser = parser.configure(GFM)

function parse(source) {
  const doc = Text.of(source.split("\n"))
  return { doc, tree: gfmParser.parse(source) }
}

function onlyTable(source) {
  const { doc, tree } = parse(source)
  const tables = collectTables(doc, tree)
  assert.equal(tables.length, 1)
  return { doc, tree, table: tables[0] }
}

function plain(cell) {
  return cell.spans.map((span) => span.text).join("")
}

function visibleEntries(source, cursor) {
  const { doc, tree } = parse(source)
  return {
    doc,
    entries: computeEntries({
      tree,
      doc,
      ranges: [{ from: cursor, to: cursor }],
      visibleRanges: [{ from: 0, to: doc.length }]
    })
  }
}

const FIXTURE_TABLE = [
  "| Агент | Статус | Зона |",
  "|-------|--------|------|",
  "| `frontend` | done (с оговорками ниже) | весь `plugins/**` + корневые `README.md`, `.gitignore`, `orca-catalog.json`, `scripts/` |"
].join("\n")

test("the status table of the build report parses into a header and one row", () => {
  const { table } = onlyTable(`## Статус по зонам\n\n${FIXTURE_TABLE}\n\n\`backend\`, \`devops\` — не задействованы\n`)
  assert.deepEqual(table.model.aligns, [null, null, null])
  assert.deepEqual(table.model.header.map(plain), ["Агент", "Статус", "Зона"])
  assert.equal(table.model.rows.length, 1)
  assert.deepEqual(table.model.rows[0].map(plain), [
    "frontend",
    "done (с оговорками ниже)",
    "весь plugins/** + корневые README.md, .gitignore, orca-catalog.json, scripts/"
  ])
})

test("inline code in a cell keeps its content verbatim, including asterisks", () => {
  const { table } = onlyTable(FIXTURE_TABLE)
  const spans = table.model.rows[0][2].spans
  assert.deepEqual(spans[0], { text: "весь ", styles: [] })
  assert.deepEqual(spans[1], { text: "plugins/**", styles: ["code"] })
  assert.ok(spans.every((span) => !span.text.includes("`")))
})

test("alignment row maps :--, :-: and --: to left, center and right", () => {
  const { table } = onlyTable("| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |")
  assert.deepEqual(table.model.aligns, ["left", "center", "right", null])
})

test("empty cells stay in their columns", () => {
  const { table } = onlyTable("| a | b | c |\n|---|---|---|\n|  |  | *x* |\n| 1 |  |  |")
  assert.deepEqual(table.model.rows.map((row) => row.map(plain)), [["", "", "x"], ["1", "", ""]])
  assert.deepEqual(table.model.rows[0][2].spans, [{ text: "x", styles: ["em"] }])
})

test("escaped pipe stays inside its cell and loses the backslash", () => {
  const { table } = onlyTable("| a | b |\n|---|---|\n| done \\| ok | \\*lit\\* |")
  assert.deepEqual(table.model.rows[0].map(plain), ["done | ok", "*lit*"])
})

test("bold, italic, strikethrough, code and nesting in cells", () => {
  const { table } = onlyTable("| h |\n|---|\n| **b** *i* ~~s~~ `c` ***bi*** |")
  assert.deepEqual(table.model.rows[0][0].spans, [
    { text: "b", styles: ["strong"] },
    { text: " ", styles: [] },
    { text: "i", styles: ["em"] },
    { text: " ", styles: [] },
    { text: "s", styles: ["strike"] },
    { text: " ", styles: [] },
    { text: "c", styles: ["code"] },
    { text: " ", styles: [] },
    { text: "bi", styles: ["strong", "em"] }
  ])
})

test("cell text with HTML is kept as text, never interpreted", () => {
  const { table } = onlyTable("| h |\n|---|\n| <b>x</b> & <script>alert(1)</script> |")
  assert.equal(plain(table.model.rows[0][0]), "<b>x</b> & <script>alert(1)</script>")
})

test("Cyrillic header and body, long text stays one cell", () => {
  const long = "очень длинный текст ".repeat(40).trim()
  const { table } = onlyTable(`| Заголовок | Ещё |\n|---|---|\n| ${long} | ок |`)
  assert.deepEqual(table.model.header.map(plain), ["Заголовок", "Ещё"])
  assert.equal(plain(table.model.rows[0][0]), long)
})

test("extra cells are dropped and missing cells padded to the header width", () => {
  const { table } = onlyTable("| a | b |\n|---|---|\n| 1 | 2 | 3 | 4 |\n| 5 |")
  assert.deepEqual(table.model.rows.map((row) => row.map(plain)), [["1", "2"], ["5", ""]])
})

test("rows without outer pipes work", () => {
  const { table } = onlyTable("a | b\n--|--\n1 | 2")
  assert.deepEqual(table.model.header.map(plain), ["a", "b"])
  assert.deepEqual(table.model.rows[0].map(plain), ["1", "2"])
})

test("cell offsets point inside the table text at the cell content", () => {
  const source = "intro\n\n| a | b |\n|---|---|\n| 12 | 34 |\n"
  const { doc, table } = onlyTable(source)
  const text = (offset, length) => doc.sliceString(table.from + offset, table.from + offset + length)
  assert.equal(text(table.model.header[1].offset, 1), "b")
  assert.equal(text(table.model.rows[0][0].offset, 2), "12")
  assert.equal(text(table.model.rows[0][1].offset, 2), "34")
})

test("without a valid delimiter row it is not a table", () => {
  const { doc, tree } = parse("| a | b |\n| not a delimiter |\n\ntext | more\nand | this\n")
  assert.deepEqual(collectTables(doc, tree), [])
})

test("two tables are both collected, with their own ranges", () => {
  const source = "| a |\n|---|\n| 1 |\n\ntext\n\n| b |\n|---|\n| 2 |\n"
  const { doc, tree } = parse(source)
  const tables = collectTables(doc, tree)
  assert.equal(tables.length, 2)
  assert.deepEqual(
    tables.map((table) => doc.sliceString(table.from, table.to)),
    ["| a |\n|---|\n| 1 |", "| b |\n|---|\n| 2 |"]
  )
})

test("cursor outside renders, inside or at the edges shows raw", () => {
  const source = "before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter"
  const { doc, tree } = parse(source)
  const tables = collectTables(doc, tree)
  const { from, to } = tables[0]
  const rendered = (position) => renderedTables(tables, [{ from: position, to: position }]).length
  assert.equal(rendered(0), 1)
  assert.equal(rendered(from - 1), 1)
  assert.equal(rendered(to + 1), 1)
  assert.equal(rendered(source.length), 1)
  assert.equal(rendered(from), 0)
  assert.equal(rendered(from + 3), 0)
  assert.equal(rendered(to), 0)
})

test("a selection that crosses the table or any of several cursors inside makes it raw", () => {
  const source = "top\n\n| a |\n|---|\n| 1 |\n\nbottom"
  const { doc, tree } = parse(source)
  const tables = collectTables(doc, tree)
  assert.equal(renderedTables(tables, [{ from: 0, to: 2 }]).length, 1)
  assert.equal(renderedTables(tables, [{ from: 0, to: source.length }]).length, 0)
  const inside = tables[0].from + 2
  assert.equal(renderedTables(tables, [{ from: 1, to: 1 }, { from: inside, to: inside }]).length, 0)
  assert.equal(renderedTables(tables, [{ from: 0, to: 0 }, { from: source.length, to: source.length }]).length, 1)
})

test("a table nested in a blockquote or list is never rendered", () => {
  const source = "> | a |\n> |---|\n> | 1 |\n\n- item\n\n  | b |\n  |---|\n  | 2 |\n"
  const { doc, tree } = parse(source)
  assert.deepEqual(collectTables(doc, tree), [])
  const nested = []
  tree.iterate({
    enter(node) {
      if (node.name === "Table") nested.push(node.node)
    }
  })
  assert.ok(nested.length >= 1)
  for (const table of nested) assert.equal(isTableRendered(table, doc, [{ from: 0, to: 0 }]), false)
})

test("a table past the line or length limit stays raw, one inside the limit renders", () => {
  const body = (count) => Array.from({ length: count }, (_, index) => `| ${index} |`).join("\n")
  const tall = parse(`| a |\n|---|\n${body(MAX_TABLE_LINES)}\n`)
  assert.deepEqual(collectTables(tall.doc, tall.tree), [])
  const wide = parse(`| a |\n|---|\n| ${"x".repeat(MAX_TABLE_LENGTH)} |\n`)
  assert.deepEqual(collectTables(wide.doc, wide.tree), [])
  const fits = parse(`| a |\n|---|\n${body(MAX_TABLE_LINES - 3)}\n`)
  assert.equal(collectTables(fits.doc, fits.tree).length, 1)
})

test("a table inside front matter is ignored", () => {
  const { doc, tree } = parse("---\na | b\n--|--\n1 | 2\n---\n\ntext\n")
  assert.deepEqual(collectTables(doc, tree), [])
})

test("raw table: lines flagged, delimiters and inner markers dimmed, nothing hidden", () => {
  const source = "| **a** | b |\n|---|---|\n| `c` | d |\n\nend"
  const { doc, entries } = visibleEntries(source, 3)
  const lines = entries.filter((entry) => entry.kind === "line").map((entry) => entry.className)
  assert.deepEqual(lines, ["cm-live-table-raw", "cm-live-table-raw", "cm-live-table-raw"])
  assert.deepEqual(entries.filter((entry) => entry.kind === "hide"), [])
  const dimmed = entries.filter((entry) => entry.kind === "dim").map((entry) => doc.sliceString(entry.from, entry.to))
  assert.ok(dimmed.includes("|---|---|"))
  assert.ok(dimmed.includes("**") && dimmed.includes("`"))
  assert.ok(dimmed.filter((text) => text === "|").length >= 6)
})

test("rendered table: the inline plugin emits nothing for it", () => {
  const source = "| **a** | b |\n|---|---|\n| `c` | d |\n\nend"
  assert.deepEqual(visibleEntries(source, source.length).entries, [])
})

test("a table too large to render keeps its markers dimmed, not hidden", () => {
  const rows = Array.from({ length: MAX_TABLE_LINES }, (_, index) => `| **${index}** |`).join("\n")
  const source = `| a |\n|---|\n${rows}\n\nend`
  const { entries } = visibleEntries(source, source.length)
  assert.deepEqual(entries.filter((entry) => entry.kind === "hide"), [])
  assert.ok(entries.some((entry) => entry.kind === "dim"))
})

function blockRanges(state) {
  const found = []
  state.field(tableExtension()).set.between(0, state.doc.length, (from, to, value) => {
    found.push({ from, to, block: value.spec.block === true, widget: value.spec.widget })
  })
  return found
}

function stateFor(source, selection = 0) {
  return EditorState.create({
    doc: source,
    selection: { anchor: selection },
    extensions: [markdown({ base: markdownLanguage }), tableExtension()]
  })
}

test("state field: block replace over the whole table while the cursor is away", () => {
  const source = "intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\noutro"
  const blocks = blockRanges(stateFor(source, 0))
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].block, true)
  assert.equal(source.slice(blocks[0].from, blocks[0].to), "| a | b |\n|---|---|\n| 1 | 2 |")
})

test("state field: the cursor entering the table removes the replacement, leaving brings it back", () => {
  const source = "intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\noutro"
  let state = stateFor(source, 0)
  state = state.update({ selection: { anchor: 15 } }).state
  assert.deepEqual(blockRanges(state), [])
  state = state.update({ selection: { anchor: source.length } }).state
  assert.equal(blockRanges(state).length, 1)
})

test("state field: edits rebuild the table and the document text is never touched by it", () => {
  const source = "| a |\n|---|\n| 1 |\n\nend"
  let state = stateFor(source, source.length)
  assert.equal(blockRanges(state).length, 1)
  state = state.update({ changes: { from: source.length, insert: "!" }, selection: { anchor: source.length + 1 } }).state
  assert.equal(state.doc.toString(), `${source}!`)
  assert.equal(blockRanges(state).length, 1)
  const dash = state.doc.toString().indexOf("---") + 1
  state = state.update({ changes: { from: dash, to: dash + 1, insert: "x" } }).state
  assert.equal(blockRanges(state).length, 0)
})

test("state field: widgets compare equal for equal content and differ for changed content", () => {
  const source = "| a |\n|---|\n| 1 |\n\nend"
  const first = blockRanges(stateFor(source, source.length))[0].widget
  const second = blockRanges(stateFor(source, source.length - 1))[0].widget
  assert.equal(first.eq(second), true)
  const changed = blockRanges(stateFor("| a |\n|---|\n| 2 |\n\nend", 20))[0].widget
  assert.equal(first.eq(changed), false)
})

test("state field: documents above the size threshold get no widgets", () => {
  const filler = "x".repeat(1572864)
  assert.deepEqual(blockRanges(stateFor(`${filler}\n\n| a |\n|---|\n| 1 |\n`, 0)), [])
})

test("state field reads the same tree as the language", () => {
  const source = "| a |\n|---|\n| 1 |\n\nend"
  const state = stateFor(source, source.length)
  assert.equal(syntaxTree(state).topNode.firstChild.name, "Table")
  assert.equal(blockRanges(state).length, 1)
})

test("collecting 500 tables from a long document is fast", () => {
  const parts = []
  for (let index = 0; index < 500; index++) {
    parts.push(`| h${index} | x |\n|---|:-:|\n| **v** | \`c\` |\n\nпараграф ${index}\n`)
  }
  const { doc, tree } = parse(parts.join("\n"))
  const started = performance.now()
  const tables = collectTables(doc, tree)
  const elapsed = performance.now() - started
  console.log(`# collect 500 tables (${doc.lines} lines): ${elapsed.toFixed(2)} ms`)
  assert.equal(tables.length, 500)
  assert.ok(elapsed < 250, `took ${elapsed} ms`)
})

test("a table node without a header or delimiter row yields no model", () => {
  const { doc } = parse("x")
  assert.equal(buildTableModel(doc, { getChild: () => null }), null)
})

test("links in cells become link spans with their target, the syntax is dropped", () => {
  const { table } = onlyTable("| a | b |\n|---|---|\n| [plugins/live-markdown](plugins/live-markdown) | **x** [site](https://a.b \"t\") https://c.d |")
  assert.deepEqual(table.model.rows[0][0].spans, [{ text: "plugins/live-markdown", styles: ["link"], link: "plugins/live-markdown" }])
  assert.deepEqual(table.model.rows[0][1].spans, [
    { text: "x", styles: ["strong"] },
    { text: " ", styles: [] },
    { text: "site", styles: ["link"], link: "https://a.b" },
    { text: " ", styles: [] },
    { text: "https://c.d", styles: ["link"], link: "https://c.d" }
  ])
})

test("a link label keeps its formatting, autolinks and www links in cells", () => {
  const { table } = onlyTable("| a |\n|---|\n| [**b** `c`](#h) <https://x.y> www.z.q |")
  assert.deepEqual(table.model.rows[0][0].spans, [
    { text: "b", styles: ["link", "strong"], link: "#h" },
    { text: " ", styles: ["link"], link: "#h" },
    { text: "c", styles: ["link", "code"], link: "#h" },
    { text: " ", styles: [] },
    { text: "https://x.y", styles: ["link"], link: "https://x.y" },
    { text: " ", styles: [] },
    { text: "www.z.q", styles: ["link"], link: "https://www.z.q" }
  ])
})

test("reference links and images in cells stay plain text", () => {
  const { table } = onlyTable("| a |\n|---|\n| ![i](p.png) [t][r] |")
  assert.equal(table.model.rows[0][0].spans.some((span) => span.link), false)
})
