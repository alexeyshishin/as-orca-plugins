const BOM = "﻿"
const MAX_LCS_CELLS = 4_000_000

export function detectFormat(raw) {
  let crlf = 0
  let lf = 0
  for (let index = raw.indexOf("\n"); index !== -1; index = raw.indexOf("\n", index + 1)) {
    if (index > 0 && raw.charCodeAt(index - 1) === 13) crlf++
    else lf++
  }
  return { bom: raw.charCodeAt(0) === 0xfeff, crlf: crlf > lf }
}

export function toEditorText(raw, format) {
  const withoutBom = format.bom ? raw.slice(1) : raw
  return format.crlf ? withoutBom.replaceAll("\r\n", "\n") : withoutBom
}

export function toFileText(text, format) {
  const withEol = format.crlf ? text.replaceAll("\n", "\r\n") : text
  return format.bom ? BOM + withEol : withEol
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff
}

export function diffRange(before, after) {
  if (before === after) return null
  const limit = Math.min(before.length, after.length)
  let start = 0
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--
  let endBefore = before.length
  let endAfter = after.length
  while (
    endBefore > start &&
    endAfter > start &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore--
    endAfter--
  }
  if (endBefore < before.length && isLowSurrogate(before.charCodeAt(endBefore))) {
    endBefore++
    endAfter++
  }
  return { from: start, to: endBefore, insert: after.slice(start, endAfter) }
}

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

function renderSide(baseLines, hunks, start, end) {
  const out = []
  let position = start
  for (const hunk of hunks) {
    for (; position < hunk.start; position++) out.push(baseLines[position])
    out.push(...hunk.lines)
    position = hunk.end
  }
  for (; position < end; position++) out.push(baseLines[position])
  return out
}

function touches(hunk, regionEnd, lastIsInsertion) {
  if (hunk.start < regionEnd) return true
  return hunk.start === regionEnd && (hunk.start === hunk.end || lastIsInsertion)
}

function withTerminator(lines, eol) {
  if (lines.length === 0) return lines
  const last = lines[lines.length - 1]
  return last.endsWith("\n") ? lines : [...lines.slice(0, -1), last + eol]
}

export function mergeThreeWay(base, outside, mine) {
  if (outside === mine || base === outside) return mine
  if (base === mine) return outside
  const eol = detectFormat(mine).crlf ? "\r\n" : "\n"
  const baseLines = splitLines(base)
  const outsideHunks = lineHunks(baseLines, splitLines(outside))
  const mineHunks = lineHunks(baseLines, splitLines(mine))
  const out = []
  let position = 0
  let outsideIndex = 0
  let mineIndex = 0
  while (outsideIndex < outsideHunks.length || mineIndex < mineHunks.length) {
    const nextOutside = outsideHunks[outsideIndex]
    const nextMine = mineHunks[mineIndex]
    const first = !nextMine || (nextOutside && nextOutside.start <= nextMine.start) ? nextOutside : nextMine
    const regionStart = first.start
    let regionEnd = first.end
    let lastIsInsertion = first.start === first.end
    const regionOutside = []
    const regionMine = []
    for (;;) {
      const candidateOutside = outsideHunks[outsideIndex]
      const candidateMine = mineHunks[mineIndex]
      const takeOutside = candidateOutside && touches(candidateOutside, regionEnd, lastIsInsertion)
      const takeMine = candidateMine && touches(candidateMine, regionEnd, lastIsInsertion)
      if (!takeOutside && !takeMine) break
      const hunk = takeOutside && (!takeMine || candidateOutside.start <= candidateMine.start) ? candidateOutside : candidateMine
      if (hunk === candidateOutside) {
        regionOutside.push(hunk)
        outsideIndex++
      } else {
        regionMine.push(hunk)
        mineIndex++
      }
      regionEnd = Math.max(regionEnd, hunk.end)
      lastIsInsertion = hunk.start === hunk.end
    }
    for (; position < regionStart; position++) out.push(baseLines[position])
    const outsideSide = renderSide(baseLines, regionOutside, regionStart, regionEnd)
    const mineSide = renderSide(baseLines, regionMine, regionStart, regionEnd)
    if (regionMine.length === 0) out.push(...outsideSide)
    else if (regionOutside.length === 0) out.push(...mineSide)
    else if (outsideSide.join("") === mineSide.join("")) out.push(...mineSide)
    else {
      out.push(`<<<<<<< mine${eol}`, ...withTerminator(mineSide, eol))
      out.push(`=======${eol}`, ...withTerminator(outsideSide, eol), `>>>>>>> outside${eol}`)
    }
    position = regionEnd
  }
  for (; position < baseLines.length; position++) out.push(baseLines[position])
  return out.join("")
}

export function bindSession(session, editor) {
  let format = detectFormat(session.value)
  editor.open(toEditorText(session.value, format), session.readOnly)
  editor.onUserChange((text) => {
    if (session.readOnly) return
    session.change(toFileText(text, format))
  })
  session.onReplace((value) => {
    format = detectFormat(value)
    const change = diffRange(editor.text(), toEditorText(value, format))
    if (change) editor.replace(change)
  })
  return { flush: () => session.flush() }
}
