import { StateEffect, StateField } from "@codemirror/state"
import { EditorView, ViewPlugin } from "@codemirror/view"

const setActive = StateEffect.define()

const activeField = StateField.define({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setActive)) return effect.value
    return value
  },
  provide: (field) => EditorView.editorAttributes.from(field, (active) => (active ? { class: "cm-focused" } : null))
})

class ActiveTracker {
  constructor(view) {
    this.view = view
    this.destroyed = false
    this.sync = () => queueMicrotask(() => this.apply())
    view.dom.addEventListener("focusin", this.sync)
    view.dom.addEventListener("focusout", this.sync)
    this.sync()
  }

  apply() {
    if (this.destroyed) return
    const active = this.view.root.activeElement === this.view.contentDOM
    if (active !== this.view.state.field(activeField)) this.view.dispatch({ effects: setActive.of(active) })
  }

  destroy() {
    this.destroyed = true
    this.view.dom.removeEventListener("focusin", this.sync)
    this.view.dom.removeEventListener("focusout", this.sync)
  }
}

export function caretVisible() {
  return [activeField, ViewPlugin.fromClass(ActiveTracker)]
}
