import { syntaxTree } from "@codemirror/language"
import { StateEffect } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view"
import { frontMatterEnd, isLivePreviewEnabled, revealState } from "./reveal.js"

export const HANG_CLASS = "cm-live-hang"

const CONTENT_BLOCKS = new Set(["Paragraph", "Task"])
const MIN_HANG_PX = 0.5
const MAX_HANG_RATIO = 0.5
const MAX_CACHED_DECORATIONS = 512
const MAX_CACHED_WIDTHS = 4096

const redrawEffect = StateEffect.define()
const hangDecorations = new Map()

function textStart(line, from) {
  return from + /^[ \t]*/.exec(line.text.slice(from - line.from))[0].length
}

function roundPx(value) {
  return Math.round(value * 100) / 100
}

export function planHangLines({ tree, doc, ranges, visibleRanges, composing = false }) {
  const { nodeRevealed } = revealState(doc, ranges)
  const frontMatter = frontMatterEnd(doc)
  const lines = new Map()
  let quoteDepth = 0

  const planContinuations = (item, markerLine, owner, range) => {
    const firstVisible = doc.lineAt(range.from).number
    const lastVisible = doc.lineAt(range.to).number
    for (let block = item.firstChild; block; block = block.nextSibling) {
      if (!CONTENT_BLOCKS.has(block.name)) continue
      const first = Math.max(doc.lineAt(block.from).number, firstVisible)
      const last = Math.min(doc.lineAt(block.to).number, lastVisible)
      for (let number = first; number <= last; number++) {
        const line = doc.line(number)
        if (line.from === markerLine.from || lines.get(line.from)?.kind === "item") continue
        const textFrom = textStart(line, line.from)
        const blanks = doc.sliceString(line.from, textFrom)
        if (textFrom >= line.to || blanks.includes("\t")) continue
        const key = textFrom > line.from ? `blanks|${blanks}` : null
        lines.set(line.from, { kind: "continuation", from: line.from, textFrom, key, owner })
      }
    }
  }

  const planItem = (item, range) => {
    const mark = item.getChild("ListMark")
    const content = mark?.nextSibling
    if (!content || !CONTENT_BLOCKS.has(content.name)) return
    const line = doc.lineAt(mark.from)
    const taskMarker = content.name === "Task" ? content.getChild("TaskMarker") : null
    const textFrom = textStart(line, taskMarker ? taskMarker.to : mark.to)
    const prefix = doc.sliceString(line.from, textFrom)
    if (textFrom >= line.to || prefix.includes("\t")) return
    let variant = "plain"
    if (taskMarker) {
      const bullet = item.parent?.name === "BulletList"
      const revealed = composing || nodeRevealed(bullet ? mark.from : taskMarker.from, taskMarker.to)
      variant = revealed ? "task-raw" : "task-box"
    }
    const owner = { kind: "item", key: `${variant}|${prefix}`, from: line.from, textFrom }
    if (line.from <= range.to && line.to >= range.from) lines.set(line.from, owner)
    if (quoteDepth === 0) planContinuations(item, line, owner, range)
  }

  for (const range of visibleRanges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (frontMatter > 0 && node.name !== "Document" && node.to <= frontMatter) return false
        if (node.name === "Blockquote") quoteDepth++
        else if (node.name === "ListItem") planItem(node.node, range)
      },
      leave(node) {
        if (node.name === "Blockquote") quoteDepth--
      }
    })
  }
  return [...lines.values()].sort((left, right) => left.from - right.from)
}

function usable(width, limit) {
  return width !== undefined && width > MIN_HANG_PX && width <= limit
}

export function resolveHangs(plan, widths, limit = Infinity) {
  const hangs = new Map()
  for (const entry of plan) {
    if (entry.kind === "item") {
      const width = widths.get(entry.key)
      if (usable(width, limit)) hangs.set(entry.from, { pad: width, first: -width })
      continue
    }
    const textWidth = widths.get(entry.owner.key)
    const blanksWidth = entry.key === null ? 0 : widths.get(entry.key)
    if (textWidth === undefined || blanksWidth === undefined) continue
    const pad = Math.max(textWidth, blanksWidth)
    if (usable(pad, limit)) hangs.set(entry.from, { pad, first: blanksWidth === 0 ? 0 : -blanksWidth })
  }
  return hangs
}

export function hangAttributes(hang) {
  return { class: HANG_CLASS, style: `--live-hang-pad:${hang.pad}px;--live-hang-first:${hang.first}px` }
}

function hangDecoration(hang) {
  const attributes = hangAttributes(hang)
  let decoration = hangDecorations.get(attributes.style)
  if (!decoration) {
    if (hangDecorations.size >= MAX_CACHED_DECORATIONS) hangDecorations.clear()
    decoration = Decoration.line({ attributes })
    hangDecorations.set(attributes.style, decoration)
  }
  return decoration
}

export function buildHangDecorations(hangs) {
  const ranges = []
  for (const [from, hang] of hangs) ranges.push(hangDecoration(hang).range(from))
  return Decoration.set(ranges, true)
}

export function hangKey(hangs) {
  const parts = []
  for (const [from, hang] of hangs) parts.push(`${from}:${hang.pad}:${hang.first}`)
  return parts.join("|")
}

function lineElement(view, position) {
  const { node } = view.domAtPos(position)
  const element = node.nodeType === 1 ? node : node.parentElement
  return element?.closest(".cm-line") ?? null
}

export function measurePrefix(view, from, to) {
  if (from < view.viewport.from || to > view.viewport.to) return null
  const line = lineElement(view, from)
  const end = view.coordsAtPos(to, -1)
  if (!line || !end) return null
  const box = line.getBoundingClientRect()
  if (end.top - box.top > end.bottom - end.top) return null
  return roundPx(end.left - box.left)
}

export function measureBlanks(view, from, to) {
  if (from < view.viewport.from || to > view.viewport.to) return null
  const start = view.coordsAtPos(from, 1)
  const end = view.coordsAtPos(to, -1)
  if (!start || !end || Math.abs(end.top - start.top) > end.bottom - end.top) return null
  return roundPx(end.left - start.left)
}

class ListIndentPlugin {
  constructor(view) {
    this.view = view
    this.widths = new Map()
    this.limit = Infinity
    this.plan = []
    this.key = ""
    this.decorations = Decoration.none
    this.composing = view.composing
    this.destroyed = false
    this.redrawQueued = false
    this.request = { key: this, read: (target) => this.read(target), write: (measured) => this.write(measured) }
    const frameDocument = view.dom.ownerDocument
    const frameWindow = frameDocument.defaultView
    this.pixelRatio = frameWindow.devicePixelRatio
    this.onFontsLoaded = () => this.invalidate()
    this.onWindowResize = () => {
      if (frameWindow.devicePixelRatio === this.pixelRatio) return
      this.pixelRatio = frameWindow.devicePixelRatio
      this.invalidate()
    }
    this.observer = new frameWindow.ResizeObserver((entries) => this.onContentResize(entries))
    frameDocument.fonts?.addEventListener("loadingdone", this.onFontsLoaded)
    frameWindow.addEventListener("resize", this.onWindowResize)
    this.observer.observe(view.contentDOM)
    this.replan(view)
    this.schedule()
  }

  update(update) {
    const composing = update.view.composing
    const themeChanged = update.startState.facet(EditorView.darkTheme) !== update.state.facet(EditorView.darkTheme)
    if (themeChanged) this.widths.clear()
    const replan =
      themeChanged ||
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      composing !== this.composing ||
      syntaxTree(update.startState) !== syntaxTree(update.state)
    this.composing = composing
    if (!replan) return
    this.replan(update.view)
    this.schedule()
  }

  replan(view) {
    const { state } = view
    this.plan = isLivePreviewEnabled(state.doc.length)
      ? planHangLines({
          tree: syntaxTree(state),
          doc: state.doc,
          ranges: state.selection.ranges,
          visibleRanges: view.visibleRanges,
          composing: view.composing
        })
      : []
    this.apply()
  }

  apply() {
    const hangs = resolveHangs(this.plan, this.widths, this.limit)
    const key = hangKey(hangs)
    if (key === this.key) return false
    this.key = key
    this.decorations = buildHangDecorations(hangs)
    return true
  }

  schedule() {
    this.view.requestMeasure(this.request)
  }

  read(view) {
    if (this.widths.size > MAX_CACHED_WIDTHS) this.widths.clear()
    const wanted = new Map()
    for (const entry of this.plan) {
      if (entry.key !== null && !this.widths.has(entry.key)) wanted.set(entry.key, entry)
      if (entry.owner && !this.widths.has(entry.owner.key)) wanted.set(entry.owner.key, entry.owner)
    }
    if (wanted.size === 0) return null
    const measured = new Map()
    for (const [key, spot] of wanted) {
      const measure = spot.kind === "item" ? measurePrefix : measureBlanks
      const width = measure(view, spot.from, spot.textFrom)
      if (width !== null) measured.set(key, width)
    }
    return measured
  }

  write(measured) {
    if (!measured) return
    for (const [key, width] of measured) this.widths.set(key, width)
    if (this.apply()) this.redraw()
  }

  redraw() {
    if (this.redrawQueued) return
    this.redrawQueued = true
    queueMicrotask(() => {
      this.redrawQueued = false
      if (!this.destroyed) this.view.dispatch({ effects: redrawEffect.of(null) })
    })
  }

  invalidate() {
    this.widths.clear()
    this.schedule()
  }

  onContentResize(entries) {
    const limit = entries[entries.length - 1].contentRect.width * MAX_HANG_RATIO
    if (limit === this.limit) return
    this.limit = limit
    if (this.apply()) this.redraw()
  }

  destroy() {
    this.destroyed = true
    this.observer.disconnect()
    const frameDocument = this.view.dom.ownerDocument
    frameDocument.fonts?.removeEventListener("loadingdone", this.onFontsLoaded)
    frameDocument.defaultView?.removeEventListener("resize", this.onWindowResize)
  }
}

export function listIndent() {
  return ViewPlugin.fromClass(ListIndentPlugin, { decorations: (plugin) => plugin.decorations })
}
