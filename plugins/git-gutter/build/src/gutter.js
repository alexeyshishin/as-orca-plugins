import { RangeSet, StateEffect, StateField } from "@codemirror/state"
import { gutter, GutterMarker, lineNumbers } from "@codemirror/view"
import { computeLineMarkers } from "./diff.js"
import { gutterReason, isDrawable } from "./state.js"

export const setGutterSnapshot = StateEffect.define()

class LineMarker extends GutterMarker {
  constructor(kind) {
    super()
    this.kind = kind
  }

  eq(other) {
    return other instanceof LineMarker && other.kind === this.kind
  }

  toDOM() {
    const element = document.createElement("div")
    element.className = `cm-gutter-git-marker cm-gutter-git-${this.kind}`
    return element
  }
}

class ShadedMarker extends GutterMarker {
  constructor(reason) {
    super()
    this.reason = reason
  }

  eq(other) {
    return other instanceof ShadedMarker && other.reason === this.reason
  }

  toDOM() {
    const element = document.createElement("div")
    element.className = "cm-gutter-git-marker cm-gutter-git-shaded"
    element.title = this.reason ?? "git status unknown"
    return element
  }
}

export function buildMarkers(state, docText) {
  if (!isDrawable(state)) {
    const reason = gutterReason(state)
    const marker = new ShadedMarker(reason)
    const builder = []
    const lineCount = docText.lines
    for (let line = 1; line <= lineCount; line++) builder.push(marker.range(docText.line(line).from))
    return RangeSet.of(builder, true)
  }
  const markers = computeLineMarkers(state.base, docText.sliceString(0))
  if (markers.length === 0) return RangeSet.empty
  const builder = markers.map((marker) => new LineMarker(marker.kind).range(docText.line(marker.line + 1).from))
  return RangeSet.of(builder, true)
}

export const gutterSnapshotField = StateField.define({
  create(state) {
    return buildMarkers({ kind: "unknown", reason: "not-resolved-yet" }, state.doc)
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setGutterSnapshot)) return buildMarkers(effect.value, transaction.state.doc)
    }
    if (transaction.docChanged) return value.map(transaction.changes)
    return value
  }
})

const gitGutter = gutter({
  class: "cm-gutter-git",
  markers: (view) => view.state.field(gutterSnapshotField)
})

export function gitGutterExtension() {
  return [gutterSnapshotField, gitGutter, lineNumbers()]
}
