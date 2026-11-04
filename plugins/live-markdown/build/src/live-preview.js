import { syntaxTree } from "@codemirror/language"
import { StateEffect } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view"
import { buildDecorations, computeEntries } from "./entries.js"
import { listIndent } from "./list-indent.js"
import { frontMatterEnd, isLivePreviewEnabled, MAX_LIVE_LENGTH } from "./reveal.js"
import { tableExtension } from "./table.js"

export { buildDecorations, computeEntries, frontMatterEnd, isLivePreviewEnabled, MAX_LIVE_LENGTH }

const refreshEffect = StateEffect.define()

class LivePreviewPlugin {
  constructor(view) {
    this.composing = view.composing
    this.build(view)
  }

  update(update) {
    const composing = update.view.composing
    const needsBuild =
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      composing !== this.composing ||
      syntaxTree(update.startState) !== syntaxTree(update.state) ||
      update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshEffect)))
    if (!needsBuild) return
    this.composing = composing
    this.build(update.view)
  }

  build(view) {
    const { state } = view
    if (!isLivePreviewEnabled(state.doc.length)) {
      this.decorations = Decoration.none
      this.atomic = Decoration.none
      return
    }
    const entries = computeEntries({
      tree: syntaxTree(state),
      doc: state.doc,
      ranges: state.selection.ranges,
      visibleRanges: view.visibleRanges,
      composing: view.composing
    })
    const built = buildDecorations(entries)
    this.decorations = built.decorations
    this.atomic = built.atomic
  }
}

const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: (plugin) => plugin.decorations,
  provide: (plugin) =>
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none)
})

const refreshAfterComposition = EditorView.domEventHandlers({
  compositionend(_event, view) {
    setTimeout(() => view.dispatch({ effects: refreshEffect.of(null) }), 30)
    return false
  }
})

export function livePreview() {
  return [livePreviewPlugin, refreshAfterComposition, tableExtension(), listIndent()]
}
