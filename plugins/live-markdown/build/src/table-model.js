import { bareTarget, unwrapTarget } from "./links.js"
import { frontMatterEnd, touchesRanges } from "./reveal.js"

export const MAX_TABLE_LINES = 300
export const MAX_TABLE_LENGTH = 60000

const STYLE_BY_NODE = {
  StrongEmphasis: "strong",
  Emphasis: "em",
  Strikethrough: "strike",
  InlineCode: "code"
}
const STYLE_ORDER = ["link", "strong", "em", "strike", "code"]
const MARK_NODES = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark"])

function pushText(spans, text, styles, link) {
  if (text === "") return
  const last = spans[spans.length - 1]
  if (last && last.styles.join() === styles.join() && last.link === link) {
    last.text += text
    return
  }
  spans.push(link ? { text, styles, link } : { text, styles })
}

function orderStyles(styles) {
  return STYLE_ORDER.filter((style) => styles.includes(style))
}

function linkSpan(doc, spans, styles, from, to, target) {
  pushText(spans, doc.sliceString(from, to), orderStyles([...styles, "link"]), target)
}

function collectSpans(doc, node, styles, link, spans, from, to) {
  let position = from
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from < from || child.to > to) continue
    pushText(spans, doc.sliceString(position, child.from), styles, link)
    position = child.to
    if (MARK_NODES.has(child.name)) continue
    const style = STYLE_BY_NODE[child.name]
    if (style) {
      collectSpans(doc, child, orderStyles([...styles, style]), link, spans, child.from, child.to)
    } else if (child.name === "Escape") {
      pushText(spans, doc.sliceString(child.from + 1, child.to), styles, link)
    } else if (child.name === "Link") {
      collectLink(doc, child, styles, spans)
    } else if (child.name === "Autolink") {
      const url = child.getChild("URL")
      if (url) linkSpan(doc, spans, styles, url.from, url.to, doc.sliceString(url.from, url.to))
      else pushText(spans, doc.sliceString(child.from, child.to), styles, link)
    } else if (child.name === "URL") {
      linkSpan(doc, spans, styles, child.from, child.to, bareTarget(doc.sliceString(child.from, child.to)))
    } else {
      pushText(spans, doc.sliceString(child.from, child.to), styles, link)
    }
  }
  pushText(spans, doc.sliceString(position, to), styles, link)
}

function collectLink(doc, node, styles, spans) {
  const url = node.getChild("URL")
  const marks = node.getChildren("LinkMark")
  if (!url || marks.length < 2) {
    pushText(spans, doc.sliceString(node.from, node.to), styles, undefined)
    return
  }
  const target = unwrapTarget(doc.sliceString(url.from, url.to))
  collectSpans(doc, node, orderStyles([...styles, "link"]), target, spans, marks[0].to, marks[1].from)
}

export function inlineSpans(doc, cellNode) {
  const spans = []
  collectSpans(doc, cellNode, [], undefined, spans, cellNode.from, cellNode.to)
  return spans
}

function rowSegments(doc, row) {
  const delimiters = row.getChildren("TableDelimiter")
  const segments = []
  let start = row.from
  for (const delimiter of delimiters) {
    segments.push({ from: start, to: delimiter.from })
    start = delimiter.to
  }
  segments.push({ from: start, to: row.to })
  const blank = (segment) => doc.sliceString(segment.from, segment.to).trim() === ""
  if (delimiters.length > 0 && blank(segments[0])) segments.shift()
  if (delimiters.length > 0 && segments.length > 0 && blank(segments[segments.length - 1])) segments.pop()
  return segments
}

function rowCells(doc, row, table, columns) {
  const cells = row.getChildren("TableCell")
  const segments = rowSegments(doc, row)
  const result = []
  for (let column = 0; column < columns; column++) {
    const segment = segments[column]
    if (!segment) {
      const end = row.to - table.from
      result.push({ spans: [], offset: end, from: end, to: end, source: "", padded: true, editable: false })
      continue
    }
    const cell = cells.find((candidate) => candidate.from >= segment.from && candidate.to <= segment.to)
    if (!cell) {
      const from = segment.from - table.from
      result.push({ spans: [], offset: from, from, to: segment.to - table.from, source: "", padded: true, editable: true })
      continue
    }
    result.push({
      spans: inlineSpans(doc, cell),
      offset: cell.from - table.from,
      from: cell.from - table.from,
      to: cell.to - table.from,
      source: doc.sliceString(cell.from, cell.to),
      padded: false,
      editable: true
    })
  }
  return result
}

function alignmentOf(text) {
  const left = text.startsWith(":")
  const right = text.endsWith(":")
  if (left && right) return "center"
  if (left) return "left"
  if (right) return "right"
  return null
}

function parseAlignments(doc, delimiterRow) {
  const parts = doc.sliceString(delimiterRow.from, delimiterRow.to).split("|").map((part) => part.trim())
  if (parts[0] === "") parts.shift()
  if (parts[parts.length - 1] === "") parts.pop()
  return parts.map(alignmentOf)
}

export function buildTableModel(doc, table) {
  const header = table.getChild("TableHeader")
  const delimiterRow = table.getChild("TableDelimiter")
  if (!header || !delimiterRow) return null
  const headerSegments = rowSegments(doc, header)
  const columns = headerSegments.length
  if (columns === 0) return null
  const aligns = parseAlignments(doc, delimiterRow)
  return {
    length: table.to - table.from,
    aligns: Array.from({ length: columns }, (_, column) => aligns[column] ?? null),
    header: rowCells(doc, header, table, columns),
    rows: table.getChildren("TableRow").map((row) => rowCells(doc, row, table, columns))
  }
}

export function isTableEligible(table, doc) {
  if (!table.parent || table.parent.name !== "Document") return false
  if (table.to - table.from > MAX_TABLE_LENGTH) return false
  return doc.lineAt(table.to).number - doc.lineAt(table.from).number + 1 <= MAX_TABLE_LINES
}

export function isTableRendered(table, doc, ranges) {
  return isTableEligible(table, doc) && !touchesRanges(ranges, table.from, table.to)
}

export function collectTables(doc, tree) {
  const frontMatter = frontMatterEnd(doc)
  const tables = []
  for (let child = tree.topNode.firstChild; child; child = child.nextSibling) {
    if (child.name !== "Table" || child.to <= frontMatter || !isTableEligible(child, doc)) continue
    const model = buildTableModel(doc, child)
    if (model) tables.push({ from: child.from, to: child.to, model })
  }
  return tables
}

export function renderedTables(tables, ranges) {
  return tables.filter((table) => !touchesRanges(ranges, table.from, table.to))
}

