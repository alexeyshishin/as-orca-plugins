const MAX_LCS_CELLS = 4_000_000

function splitLines(text) {
  if (text === "") return []
  return text.split(/(?<=\n)/)
}

function lineHunks(baseLines, otherLines) {
  let start = 0
  const limit = Math.min(baseLines.length, otherLines.length)
  while (start < limit && baseLines[start] === otherLines[start]) start++
  let baseEnd = baseLines.length
  let otherEnd = otherLines.length
  while (baseEnd > start && otherEnd > start && baseLines[baseEnd - 1] === otherLines[otherEnd - 1]) {
    baseEnd--
    otherEnd--
  }
  const rows = baseEnd - start
  const columns = otherEnd - start
  if (rows === 0 && columns === 0) return []
  if (rows === 0 || columns === 0 || (rows + 1) * (columns + 1) > MAX_LCS_CELLS) {
    return [{ start, end: baseEnd, lines: otherLines.slice(start, otherEnd) }]
  }
  const width = columns + 1
  const table = new Uint32Array((rows + 1) * width)
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      table[row * width + column] =
        baseLines[start + row] === otherLines[start + column]
          ? table[(row + 1) * width + column + 1] + 1
          : Math.max(table[(row + 1) * width + column], table[row * width + column + 1])
    }
  }
  const hunks = []
  let row = 0
  let column = 0
  let open = null
  const close = () => {
    if (open) hunks.push(open)
    open = null
  }
  while (row < rows || column < columns) {
    if (row < rows && column < columns && baseLines[start + row] === otherLines[start + column]) {
      close()
      row++
      column++
    } else if (
      column < columns &&
      (row === rows || table[row * width + column + 1] >= table[(row + 1) * width + column])
    ) {
      open ??= { start: start + row, end: start + row, lines: [] }
      open.lines.push(otherLines[start + column])
      column++
    } else {
      open ??= { start: start + row, end: start + row, lines: [] }
      row++
      open.end = start + row
    }
  }
  close()
  return hunks
}

function clampLine(line, bufferLineCount) {
  if (bufferLineCount === 0) return 0
  return Math.max(0, Math.min(line, bufferLineCount - 1))
}

export function computeLineMarkers(base, buffer) {
  if (base === buffer) return []
  const baseLines = splitLines(base)
  const bufferLines = splitLines(buffer)
  const hunks = lineHunks(baseLines, bufferLines)
  const byLine = new Map()
  const place = (line, kind) => {
    const existing = byLine.get(line)
    if (!existing || existing.kind === "deleted") byLine.set(line, { line, kind })
  }
  let bufferCursor = 0
  let baseCursor = 0
  for (const hunk of hunks) {
    bufferCursor += hunk.start - baseCursor
    baseCursor = hunk.start
    const deletedCount = hunk.end - hunk.start
    const insertedCount = hunk.lines.length
    const changedCount = Math.min(deletedCount, insertedCount)
    for (let index = 0; index < changedCount; index++) place(bufferCursor + index, "modified")
    for (let index = changedCount; index < insertedCount; index++) place(bufferCursor + index, "added")
    if (deletedCount > insertedCount) {
      place(clampLine(bufferCursor + insertedCount, bufferLines.length), "deleted")
    }
    bufferCursor += insertedCount
    baseCursor = hunk.end
  }
  return [...byLine.values()].sort((left, right) => left.line - right.line)
}
