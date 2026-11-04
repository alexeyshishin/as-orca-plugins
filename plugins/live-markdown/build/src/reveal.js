export const MAX_LIVE_LENGTH = 1572864

const FRONT_MATTER_SCAN_LINES = 500

export function isLivePreviewEnabled(docLength) {
  return docLength <= MAX_LIVE_LENGTH
}

export function frontMatterEnd(doc) {
  if (doc.lines < 3 || doc.line(1).text.trimEnd() !== "---") return 0
  const last = Math.min(doc.lines, FRONT_MATTER_SCAN_LINES)
  for (let number = 2; number <= last; number++) {
    const line = doc.line(number)
    const text = line.text.trimEnd()
    if (text === "---" || text === "...") return line.to
  }
  return 0
}

export function touchesRanges(ranges, from, to) {
  return ranges.some((range) => range.from <= to && range.to >= from)
}

export function revealState(doc, ranges) {
  const lineSpans = []
  const textSpans = []
  for (const range of ranges) {
    const first = doc.lineAt(range.from)
    const last = doc.lineAt(range.to)
    lineSpans.push({ first: first.number, last: last.number })
    textSpans.push({ from: range.from, to: range.to })
  }
  return {
    lineActive: (number) => lineSpans.some((span) => span.first <= number && number <= span.last),
    nodeRevealed: (from, to) => textSpans.some((span) => span.from <= to && span.to >= from)
  }
}
