import { Text } from "@codemirror/state"
import { GFM, parser } from "@lezer/markdown"
import assert from "node:assert/strict"
import { test } from "node:test"
import { collectTables } from "../src/table.js"
import {
  cellReplacement,
  exitPosition,
  neighborCell,
  normalizeCellText
} from "../src/table-cells.js"

const gfmParser = parser.configure(GFM)

function tableOf(source) {
  const doc = Text.of(source.split("\n"))
  const tables = collectTables(doc, gfmParser.parse(source))
  assert.equal(tables.length, 1)
  return tables[0]
}


const header = (column) => ({ part: "header", column })
const bodyCell = (row, column) => ({ part: "rows", row, column })
function pick(model, cell) {
  return cell.part === "header" ? model.header[cell.column] : model.rows[cell.row][cell.column]
}
function edit(source, cell, text) {
  const table = tableOf(source)
  const target = pick(table.model, cell)
  const change = cellReplacement(target, text)
  if (!change) return source
  return source.slice(0, table.from + change.from) + change.insert + source.slice(table.from + change.to)
}

const SOURCE = "intro\n\n| Агент | Статус |\n|-------|:------:|\n| `a` | done |\n| b | **x** |\n|  | |\n\nend\n"
const LINES = SOURCE.split("\n")

test("normalizeCellText escapes bare pipes and leaves escaped ones alone", () => {
  assert.equal(normalizeCellText("a|b").text, "a\\|b")
  assert.equal(normalizeCellText("a\\|b").text, "a\\|b")
  assert.equal(normalizeCellText("a\\\\|b").text, "a\\\\\\|b")
  assert.equal(normalizeCellText("a\\\\\\|b").text, "a\\\\\\|b")
  assert.equal(normalizeCellText("||").text, "\\|\\|")
  assert.equal(normalizeCellText("`a|b`").text, "`a\\|b`")
})

test("normalizeCellText turns every newline form into one space", () => {
  assert.equal(normalizeCellText("a\nb").text, "a b")
  assert.equal(normalizeCellText("a\r\nb").text, "a b")
  assert.equal(normalizeCellText("a\rb").text, "a b")
  assert.equal(normalizeCellText("a\n\nb").text, "a  b")
})

test("normalizeCellText maps the caret through inserted backslashes and collapsed newlines", () => {
  assert.deepEqual(normalizeCellText("a|b", 2), { text: "a\\|b", caret: 3 })
  assert.deepEqual(normalizeCellText("a|b", 1), { text: "a\\|b", caret: 1 })
  assert.deepEqual(normalizeCellText("a|b"), { text: "a\\|b", caret: 4 })
  assert.deepEqual(normalizeCellText("привет\nмир", 7), { text: "привет мир", caret: 7 })
  assert.deepEqual(normalizeCellText("a\r\nb", 3), { text: "a b", caret: 2 })
  assert.deepEqual(normalizeCellText("", 0), { text: "", caret: 0 })
})

test("cell model carries the content range, source and padding flag", () => {
  const table = tableOf(SOURCE)
  const doc = Text.of(SOURCE.split("\n"))
  const done = table.model.rows[0][1]
  assert.equal(doc.sliceString(table.from + done.from, table.from + done.to), "done")
  assert.equal(done.source, "done")
  assert.equal(done.padded, false)
  assert.equal(done.editable, true)
  const empty = table.model.rows[2][0]
  assert.equal(empty.padded, true)
  assert.equal(empty.source, "")
  assert.equal(doc.sliceString(table.from + empty.from, table.from + empty.to), "  ")
  assert.equal(table.model.rows[2][1].padded, true)
  assert.equal(doc.sliceString(table.from + table.model.rows[2][1].from, table.from + table.model.rows[2][1].to), " ")
})

test("editing a cell changes only that cell's source in the document", () => {
  const edited = edit(SOURCE, bodyCell(0, 1), "done Привет")
  const lines = edited.split("\n")
  assert.equal(lines[4], "| `a` | done Привет |")
  assert.deepEqual(lines.filter((_, index) => index !== 4), LINES.filter((_, index) => index !== 4))
  assert.equal(lines[3], "|-------|:------:|")
})

test("editing keeps the surrounding padding and the alignment row untouched", () => {
  const tight = "| a | b |\n|:-:|--:|\n|x|y|\n"
  const edited = edit(tight, bodyCell(0, 0), "new")
  assert.equal(edited, "| a | b |\n|:-:|--:|\n|new|y|\n")
  const wide = "| a | b |\n|---|---|\n|   x   | y |\n"
  assert.equal(edit(wide, bodyCell(0, 0), "new"), "| a | b |\n|---|---|\n|   new   | y |\n")
})

test("a pipe typed into a cell is escaped, a newline becomes a space", () => {
  const text = normalizeCellText("a|b\nc").text
  const edited = edit(SOURCE, bodyCell(0, 0), text)
  assert.equal(edited.split("\n")[4], "| a\\|b c | done |")
  const table = tableOf(edited)
  assert.equal(table.model.rows[0].length, 2)
  assert.equal(table.model.rows[0][0].source, "a\\|b c")
  assert.equal(table.model.rows[0][0].spans.map((span) => span.text).join(""), "a|b c")
})

test("typing into an empty cell writes ' text ' and keeps the row shape", () => {
  const edited = edit(SOURCE, bodyCell(2, 1), "Привет")
  assert.equal(edited.split("\n")[6], "|  | Привет |")
  const table = tableOf(edited)
  assert.deepEqual(table.model.rows[2].map((cell) => cell.source), ["", "Привет"])
  assert.equal(table.model.rows[2][1].padded, false)
})

test("clearing a cell leaves an empty cell, not a broken row", () => {
  const cleared = edit(SOURCE, bodyCell(0, 1), "")
  assert.equal(cleared.split("\n")[4], "| `a` |  |")
  const table = tableOf(cleared)
  assert.equal(table.model.rows[0][1].padded, true)
  assert.equal(table.model.rows[0].length, 2)
  const typedAgain = edit(cleared, bodyCell(0, 1), "back")
  assert.equal(typedAgain.split("\n")[4], "| `a` | back |")
})

test("header cells are editable the same way", () => {
  const edited = edit(SOURCE, header(0), "Имя")
  assert.equal(edited.split("\n")[2], "| Имя | Статус |")
  assert.equal(tableOf(edited).model.header[0].source, "Имя")
})

test("no-op edits produce no change", () => {
  const table = tableOf(SOURCE)
  assert.equal(cellReplacement(table.model.rows[0][1], "done"), null)
  assert.equal(cellReplacement(table.model.rows[0][1], "  done  "), null)
  assert.equal(cellReplacement(table.model.rows[2][0], "   "), null)
})

test("character-by-character typing keeps converging on the typed text", () => {
  let source = SOURCE
  let typed = ""
  for (const char of "Привет, мир | **x**") {
    typed += char
    source = edit(source, bodyCell(1, 0), normalizeCellText(typed).text)
    const table = tableOf(source)
    assert.equal(table.model.rows[1][0].source, normalizeCellText(typed).text.trim(), typed)
    assert.equal(table.model.rows[1].length, 2)
    assert.equal(table.model.rows.length, 3)
  }
  assert.equal(source.split("\n")[5], "| Привет, мир \\| **x** | **x** |")
  assert.deepEqual(source.split("\n").filter((_, index) => index !== 5), LINES.filter((_, index) => index !== 5))
})

test("bold, code and escapes typed as source render on blur through the same model", () => {
  const edited = edit(SOURCE, bodyCell(0, 0), "`code` and *it* and ~~s~~")
  const spans = tableOf(edited).model.rows[0][0].spans
  assert.deepEqual(spans.map((span) => [span.text, span.styles]), [
    ["code", ["code"]],
    [" and ", []],
    ["it", ["em"]],
    [" and ", []],
    ["s", ["strike"]]
  ])
})

test("neighborCell: next and previous walk row by row, edges return null", () => {
  assert.deepEqual(neighborCell(4, 3, 0, 0, "next"), { row: 0, column: 1 })
  assert.deepEqual(neighborCell(4, 3, 0, 2, "next"), { row: 1, column: 0 })
  assert.equal(neighborCell(4, 3, 3, 2, "next"), null)
  assert.deepEqual(neighborCell(4, 3, 1, 0, "previous"), { row: 0, column: 2 })
  assert.deepEqual(neighborCell(4, 3, 2, 2, "previous"), { row: 2, column: 1 })
  assert.equal(neighborCell(4, 3, 0, 0, "previous"), null)
})

test("neighborCell: below and above keep the column and null at the table edge", () => {
  assert.deepEqual(neighborCell(4, 3, 1, 2, "below"), { row: 2, column: 2 })
  assert.equal(neighborCell(4, 3, 3, 2, "below"), null)
  assert.deepEqual(neighborCell(4, 3, 3, 1, "above"), { row: 2, column: 1 })
  assert.equal(neighborCell(4, 3, 0, 1, "above"), null)
})

test("exitPosition lands outside the table range so it stays rendered", () => {
  const table = { from: 10, to: 40 }
  assert.equal(exitPosition(table, 100, "below"), 41)
  assert.equal(exitPosition(table, 100, "above"), 9)
  assert.equal(exitPosition({ from: 0, to: 40 }, 100, "above"), 41)
  assert.equal(exitPosition({ from: 10, to: 100 }, 100, "below"), 9)
  assert.equal(exitPosition({ from: 0, to: 100 }, 100, "below"), 100)
  for (const direction of ["below", "above"]) {
    const position = exitPosition(table, 100, direction)
    assert.ok(position < table.from || position > table.to)
  }
})
