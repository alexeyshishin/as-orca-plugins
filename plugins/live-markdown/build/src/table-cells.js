import { EditorState } from "@codemirror/state"
import { diffRange } from "./sync.js"

function trailingBackslashes(text) {
  let count = 0
  while (count < text.length && text[text.length - 1 - count] === "\\") count++
  return count
}

export function normalizeCellText(text, caret = text.length) {
  let out = ""
  let mapped = null
  for (let index = 0; index < text.length; index++) {
    if (index === caret) mapped = out.length
    const char = text[index]
    if (char === "\r" && text[index + 1] === "\n") continue
    if (char === "\r" || char === "\n") out += " "
    else if (char === "|" && trailingBackslashes(out) % 2 === 0) out += "\\|"
    else out += char
  }
  return { text: out, caret: mapped ?? out.length }
}

export function cellReplacement(cell, text) {
  const trimmed = text.trim()
  if (cell.padded) {
    if (trimmed === "") return null
    return { from: cell.from, to: cell.to, insert: ` ${trimmed} ` }
  }
  if (trimmed === cell.source) return null
  return { from: cell.from, to: cell.to, insert: trimmed }
}

export function neighborCell(rowCount, columnCount, row, column, move) {
  if (move === "next") {
    if (column + 1 < columnCount) return { row, column: column + 1 }
    return row + 1 < rowCount ? { row: row + 1, column: 0 } : null
  }
  if (move === "previous") {
    if (column > 0) return { row, column: column - 1 }
    return row > 0 ? { row: row - 1, column: columnCount - 1 } : null
  }
  if (move === "below") return row + 1 < rowCount ? { row: row + 1, column } : null
  return row > 0 ? { row: row - 1, column } : null
}

export function exitPosition(table, docLength, direction) {
  const below = table.to < docLength ? table.to + 1 : null
  const above = table.from > 0 ? table.from - 1 : null
  const position = direction === "above" ? (above ?? below) : (below ?? above)
  return position ?? table.to
}

export const cellTextFilter = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged) return transaction
  const text = transaction.newDoc.toString()
  const normalized = normalizeCellText(text).text
  if (normalized === text) return transaction
  return [transaction, { changes: diffRange(text, normalized), sequential: true }]
})
