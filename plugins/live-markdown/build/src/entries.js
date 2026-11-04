import { Decoration, WidgetType } from "@codemirror/view"
import { highlightCode, languageKey, languageLabel } from "./code-highlight.js"
import { bareTarget, linkTooltip, unwrapTarget } from "./links.js"
import { frontMatterEnd, revealState } from "./reveal.js"
import { isTableRendered } from "./table-model.js"

const ATX_HEADING = /^ATXHeading([1-6])$/
const SETEXT_HEADING = /^SetextHeading([12])$/
const INLINE_STYLES = {
  StrongEmphasis: "cm-live-strong",
  Emphasis: "cm-live-em",
  Strikethrough: "cm-live-strike",
  InlineCode: "cm-live-code"
}
const ALWAYS_DIMMED = new Set(["QuoteMark", "CodeInfo"])

function skipBlanksForward(doc, position, lineEnd) {
  let end = position
  while (end < lineEnd && /[ \t]/.test(doc.sliceString(end, end + 1))) end++
  return end
}

function skipBlanksBackward(doc, position, lineStart) {
  let start = position
  while (start > lineStart && /[ \t]/.test(doc.sliceString(start - 1, start))) start--
  return start
}

export function computeEntries({ tree, doc, ranges, visibleRanges, composing = false }) {
  const { lineActive, nodeRevealed } = revealState(doc, ranges)
  const frontMatter = frontMatterEnd(doc)
  const entries = []
  const seen = new Set()
  let insideRawTable = false
  let hiddenFence = false

  const add = (entry) => {
    const key = `${entry.kind}:${entry.from}:${entry.to ?? ""}:${entry.className ?? ""}`
    if (seen.has(key)) return
    seen.add(key)
    entries.push(entry)
  }
  const addLine = (position, className) => add({ kind: "line", from: doc.lineAt(position).from, className })
  const addMarker = (from, to, revealed) => {
    if (from >= to) return
    add({ kind: revealed || composing ? "dim" : "hide", from, to })
  }
  const addDimmed = (from, to) => {
    if (from < to) add({ kind: "dim", from, to })
  }

  const handleAtxMark = (node, parent) => {
    const line = doc.lineAt(node.from)
    const revealed = lineActive(line.number)
    const opening = !node.node.prevSibling
    if (opening) addMarker(node.from, skipBlanksForward(doc, node.to, line.to), revealed)
    else addMarker(skipBlanksBackward(doc, node.from, parent.from), node.to, revealed)
  }

  const handleHeaderMark = (node) => {
    const parent = node.node.parent
    if (parent && ATX_HEADING.test(parent.name)) handleAtxMark(node, parent)
    else addDimmed(node.from, node.to)
  }

  const handleSetext = (node, level) => {
    const underline = node.node.getChild("HeaderMark")
    const lastContentLine = underline ? doc.lineAt(underline.from).number - 1 : doc.lineAt(node.to).number
    for (let number = doc.lineAt(node.from).number; number <= lastContentLine; number++) {
      add({ kind: "line", from: doc.line(number).from, className: `cm-live-h${level}` })
    }
  }

  const addHighlight = (node) => {
    const info = node.node.getChild("CodeInfo")
    const key = info ? languageKey(doc.sliceString(info.from, info.to)) : null
    if (!key) return
    const chunks = node.node.getChildren("CodeText").map((chunk) => ({
      from: chunk.from,
      to: doc.sliceString(chunk.to - 1, chunk.to) === "\n" ? chunk.to - 1 : chunk.to
    }))
    if (chunks.length === 0) return
    const code = chunks.map((chunk) => doc.sliceString(chunk.from, chunk.to)).join("\n")
    let consumed = 0
    const starts = chunks.map((chunk) => {
      const start = consumed
      consumed += chunk.to - chunk.from + 1
      return start
    })
    for (const token of highlightCode(key, code)) {
      chunks.forEach((chunk, index) => {
        const from = Math.max(token.from, starts[index])
        const to = Math.min(token.to, starts[index] + chunk.to - chunk.from)
        if (from < to) {
          add({ kind: "style", from: chunk.from + from - starts[index], to: chunk.from + to - starts[index], className: token.className })
        }
      })
    }
  }

  const hideFenceLine = (mark, text) => {
    const line = doc.lineAt(mark.from)
    if (text) add({ kind: "label", from: mark.from, to: line.to, text })
    else add({ kind: "hide", from: mark.from, to: line.to })
  }

  const handleFencedCode = (node, range) => {
    const marks = node.node.getChildren("CodeMark")
    const opening = marks[0]
    const closing = marks.length > 1 ? marks[marks.length - 1] : null
    const info = node.node.getChild("CodeInfo")
    const label = info ? languageLabel(doc.sliceString(info.from, info.to)) : ""
    hiddenFence = !composing && !nodeRevealed(node.from, node.to)
    const firstLine = doc.lineAt(node.from).number
    const lastLine = doc.lineAt(node.to).number
    let position = Math.max(node.from, range.from)
    const end = Math.min(node.to, range.to)
    while (position <= end) {
      const line = doc.lineAt(position)
      add({ kind: "line", from: line.from, className: "cm-live-codeblock" })
      if (line.number === firstLine) add({ kind: "line", from: line.from, className: "cm-live-codeblock-first" })
      if (line.number === lastLine) add({ kind: "line", from: line.from, className: "cm-live-codeblock-last" })
      position = line.to + 1
    }
    if (hiddenFence && opening) hideFenceLine(opening, label)
    if (hiddenFence && closing) hideFenceLine(closing, "")
    addHighlight(node)
  }

  const taskSpan = (node) => {
    const item = node.node.parent
    const task = item?.getChild("Task")
    const marker = task?.getChild("TaskMarker")
    if (!marker) return null
    const bullet = item.parent?.name === "BulletList"
    return { task, marker, from: bullet ? node.from : marker.from, to: marker.to, bullet }
  }

  const handleListMark = (node) => {
    const span = taskSpan(node)
    if (span) {
      if (!span.bullet || nodeRevealed(span.from, span.to) || composing) addDimmed(node.from, node.to)
      return
    }
    const bullet = node.node.parent?.parent?.name === "BulletList"
    if (bullet && !nodeRevealed(node.from, node.to)) add({ kind: "style", from: node.from, to: node.to, className: "cm-live-bullet" })
    else addDimmed(node.from, node.to)
  }

  const handleTaskMarker = (node) => {
    const task = node.node.parent
    const item = task?.parent
    const listMark = item?.getChild("ListMark")
    if (!listMark) {
      addDimmed(node.from, node.to)
      return
    }
    const bullet = item.parent?.name === "BulletList"
    const from = bullet ? listMark.from : node.from
    const checked = doc.sliceString(node.from + 1, node.from + 2).toLowerCase() === "x"
    if (checked) add({ kind: "style", from: node.to, to: task.to, className: "cm-live-task-done" })
    if (nodeRevealed(from, node.to) || composing) {
      addDimmed(node.from, node.to)
      return
    }
    add({ kind: "checkbox", from, to: node.to, checked, offset: node.from + 1 - from })
  }

  const addLinkSyntax = (from, to, revealed) => {
    const sameLine = doc.lineAt(from).number === doc.lineAt(to).number
    addMarker(from, to, revealed || !sameLine)
  }

  const handleLink = (node) => {
    const link = node.node
    const url = link.getChild("URL")
    const marks = link.getChildren("LinkMark")
    if (!url || marks.length < 2) return
    const titleNode = link.getChild("LinkTitle")
    const title = titleNode ? doc.sliceString(titleNode.from + 1, titleNode.to - 1) : ""
    if (marks[0].to < marks[1].from) {
      add({ kind: "link", from: marks[0].to, to: marks[1].from, target: unwrapTarget(doc.sliceString(url.from, url.to)), title })
    }
    const revealed = insideRawTable || nodeRevealed(link.from, link.to)
    addLinkSyntax(marks[0].from, marks[0].to, revealed)
    addLinkSyntax(marks[1].from, link.to, revealed)
  }

  const handleAutolink = (node) => {
    const url = node.node.getChild("URL")
    if (!url) return
    add({ kind: "link", from: url.from, to: url.to, target: doc.sliceString(url.from, url.to), title: "" })
    const revealed = insideRawTable || nodeRevealed(node.from, node.to)
    for (const mark of node.node.getChildren("LinkMark")) addLinkSyntax(mark.from, mark.to, revealed)
  }

  const handleBareUrl = (node) => {
    const parent = node.node.parent?.name
    if (parent === "Link" || parent === "Autolink" || parent === "Image" || parent === "LinkReference") return
    add({ kind: "link", from: node.from, to: node.to, target: bareTarget(doc.sliceString(node.from, node.to)), title: "" })
  }

  const handleInlineMark = (node) => {
    const parent = node.node.parent
    if (!parent) return
    if (node.name === "CodeMark" && parent.name !== "InlineCode") {
      if (!hiddenFence) addDimmed(node.from, node.to)
    } else addMarker(node.from, node.to, insideRawTable || nodeRevealed(parent.from, parent.to))
  }

  const handleHorizontalRule = (node) => {
    const line = doc.lineAt(node.from)
    if (doc.sliceString(line.from, node.from).trim() !== "") {
      addDimmed(node.from, node.to)
      return
    }
    if (lineActive(line.number) || composing) {
      addDimmed(node.from, node.to)
      return
    }
    add({ kind: "line", from: line.from, className: "cm-live-hr" })
    add({ kind: "hide", from: node.from, to: node.to })
  }

  const handleRawTable = (node, range) => {
    let position = Math.max(node.from, range.from)
    const end = Math.min(node.to, range.to)
    while (position <= end) {
      const line = doc.lineAt(position)
      add({ kind: "line", from: line.from, className: "cm-live-table-raw" })
      position = line.to + 1
    }
  }

  for (const range of visibleRanges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        const name = node.name
        if (name !== "Document" && frontMatter > 0 && node.to <= frontMatter) return false
        if (name === "Table") {
          if (isTableRendered(node.node, doc, ranges)) return false
          insideRawTable = true
          handleRawTable(node, range)
          return
        }
        if (name === "TableDelimiter") {
          addDimmed(node.from, node.to)
          return
        }
        if (name === "HorizontalRule") {
          handleHorizontalRule(node)
          return
        }
        const atx = ATX_HEADING.exec(name)
        if (atx) {
          addLine(node.from, `cm-live-h${atx[1]}`)
          return
        }
        const setext = SETEXT_HEADING.exec(name)
        if (setext) {
          handleSetext(node, setext[1])
          return
        }
        if (name === "Link") handleLink(node)
        else if (name === "Autolink") handleAutolink(node)
        else if (name === "URL") handleBareUrl(node)
        else if (name === "HeaderMark") handleHeaderMark(node)
        else if (name === "EmphasisMark" || name === "StrikethroughMark" || name === "CodeMark") handleInlineMark(node)
        else if (name === "ListMark") handleListMark(node)
        else if (name === "TaskMarker") handleTaskMarker(node)
        else if (name === "CodeInfo" && hiddenFence) return
        else if (ALWAYS_DIMMED.has(name)) addDimmed(node.from, node.to)
        else if (name === "FencedCode") handleFencedCode(node, range)
        else if (INLINE_STYLES[name]) add({ kind: "style", from: node.from, to: node.to, className: INLINE_STYLES[name] })
      },
      leave(node) {
        if (node.name === "Table") insideRawTable = false
        if (node.name === "FencedCode") hiddenFence = false
      }
    })
    if (frontMatter > 0 && range.from <= frontMatter) {
      let position = range.from
      while (position <= Math.min(frontMatter, range.to)) {
        const line = doc.lineAt(position)
        add({ kind: "line", from: line.from, className: "cm-live-frontmatter" })
        position = line.to + 1
      }
    }
  }
  return entries
}

class LanguageLabel extends WidgetType {
  constructor(text) {
    super()
    this.text = text
  }

  eq(other) {
    return other.text === this.text
  }

  toDOM() {
    const label = document.createElement("span")
    label.className = "cm-live-code-lang"
    label.textContent = this.text
    return label
  }
}

class CheckboxWidget extends WidgetType {
  constructor(checked, offset) {
    super()
    this.checked = checked
    this.offset = offset
  }

  eq(other) {
    return other.checked === this.checked && other.offset === this.offset
  }

  toDOM(view) {
    const box = document.createElement("span")
    box.className = this.checked ? "cm-live-checkbox cm-live-checkbox-checked" : "cm-live-checkbox"
    box.setAttribute("role", "checkbox")
    box.setAttribute("aria-checked", this.checked ? "true" : "false")
    box.setAttribute("aria-label", "Task")
    box.addEventListener("mousedown", (event) => event.preventDefault())
    box.addEventListener("click", (event) => {
      event.preventDefault()
      const position = view.posAtDOM(box) + this.offset
      view.dispatch({
        changes: { from: position, to: position + 1, insert: this.checked ? " " : "x" },
        userEvent: "input.toggle"
      })
    })
    return box
  }

  ignoreEvent() {
    return true
  }
}

const hideDecoration = Decoration.replace({})
const dimDecoration = Decoration.mark({ class: "cm-live-marker" })
const lineDecorations = new Map()
const styleDecorations = new Map()

function cached(cache, className, create) {
  let decoration = cache.get(className)
  if (!decoration) {
    decoration = create(className)
    cache.set(className, decoration)
  }
  return decoration
}

export function buildDecorations(entries) {
  const all = []
  const atomic = []
  for (const entry of entries) {
    if (entry.kind === "line") {
      all.push(cached(lineDecorations, entry.className, (name) => Decoration.line({ class: name })).range(entry.from))
    } else if (entry.kind === "style") {
      all.push(cached(styleDecorations, entry.className, (name) => Decoration.mark({ class: name })).range(entry.from, entry.to))
    } else if (entry.kind === "dim") {
      all.push(dimDecoration.range(entry.from, entry.to))
    } else if (entry.kind === "link") {
      all.push(
        Decoration.mark({
          class: "cm-live-link",
          attributes: { title: linkTooltip(entry.target, entry.title), "data-live-link": entry.target }
        }).range(entry.from, entry.to)
      )
    } else if (entry.kind === "checkbox") {
      const range = Decoration.replace({ widget: new CheckboxWidget(entry.checked, entry.offset) }).range(entry.from, entry.to)
      all.push(range)
      atomic.push(range)
    } else if (entry.kind === "label") {
      const range = Decoration.replace({ widget: new LanguageLabel(entry.text) }).range(entry.from, entry.to)
      all.push(range)
      atomic.push(range)
    } else {
      const range = hideDecoration.range(entry.from, entry.to)
      all.push(range)
      atomic.push(range)
    }
  }
  return { decorations: Decoration.set(all, true), atomic: Decoration.set(atomic, true) }
}

