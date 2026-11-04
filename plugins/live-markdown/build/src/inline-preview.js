import { StateEffect } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view"
import { GFM, parser } from "@lezer/markdown"
import { buildDecorations, computeEntries } from "./entries.js"

const BLOCK_PARSERS = [
  "LinkReference",
  "IndentedCode",
  "FencedCode",
  "Blockquote",
  "HorizontalRule",
  "BulletList",
  "OrderedList",
  "ATXHeading",
  "HTMLBlock",
  "SetextHeading",
  "Table",
  "CommentBlock",
  "ProcessingInstructionBlock"
]

export const inlineParser = parser.configure([GFM, { remove: BLOCK_PARSERS }])

const refreshEffect = StateEffect.define()

class InlinePreviewPlugin {
  constructor(view) {
    this.composing = view.composing
    this.build(view)
  }

  update(update) {
    const composing = update.view.composing
    const needsBuild =
      update.docChanged ||
      update.selectionSet ||
      composing !== this.composing ||
      update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshEffect)))
    if (!needsBuild) return
    this.composing = composing
    this.build(update.view)
  }

  build(view) {
    const { doc, selection } = view.state
    const entries = computeEntries({
      tree: inlineParser.parse(doc.toString()),
      doc,
      ranges: selection.ranges,
      visibleRanges: [{ from: 0, to: doc.length }],
      composing: view.composing
    })
    const built = buildDecorations(entries)
    this.decorations = built.decorations
    this.atomic = built.atomic
  }
}

const inlinePlugin = ViewPlugin.fromClass(InlinePreviewPlugin, {
  decorations: (plugin) => plugin.decorations,
  provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none)
})

const refreshAfterComposition = EditorView.domEventHandlers({
  compositionend(_event, view) {
    setTimeout(() => view.dispatch({ effects: refreshEffect.of(null) }), 30)
    return false
  }
})

export function inlinePreview() {
  return [inlinePlugin, refreshAfterComposition]
}
