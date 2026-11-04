import { syntaxTree } from "@codemirror/language"
import { StateField } from "@codemirror/state"
import { Decoration, EditorView, WidgetType } from "@codemirror/view"
import { isLivePreviewEnabled } from "./reveal.js"
import { collectTables, renderedTables } from "./table-model.js"
import { createTableDom, destroyTableDom, updateTableDom } from "./table-editor.js"

export * from "./table-model.js"

class TableWidget extends WidgetType {
  constructor(model) {
    super()
    this.model = model
    this.key = JSON.stringify(model)
  }

  eq(other) {
    return other.key === this.key
  }

  get estimatedHeight() {
    return (this.model.rows.length + 1) * 34 + 12
  }

  toDOM(view) {
    return createTableDom(view, this.model)
  }

  updateDOM(dom) {
    return updateTableDom(dom, this.model)
  }

  destroy(dom) {
    destroyTableDom(dom)
  }
}

function toDecorationSet(tables, ranges) {
  const decorations = renderedTables(tables, ranges).map((table) =>
    Decoration.replace({ widget: new TableWidget(table.model), block: true }).range(table.from, table.to)
  )
  return Decoration.set(decorations, true)
}

function buildValue(state) {
  const tables = isLivePreviewEnabled(state.doc.length) ? collectTables(state.doc, syntaxTree(state)) : []
  return { tables, set: toDecorationSet(tables, state.selection.ranges) }
}

const tableField = StateField.define({
  create: buildValue,
  update(value, transaction) {
    if (transaction.docChanged || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)) {
      return buildValue(transaction.state)
    }
    if (transaction.selection) {
      return { tables: value.tables, set: toDecorationSet(value.tables, transaction.state.selection.ranges) }
    }
    return value
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.set),
    EditorView.atomicRanges.of((view) => view.state.field(field).set)
  ]
})

export function tableExtension() {
  return tableField
}
