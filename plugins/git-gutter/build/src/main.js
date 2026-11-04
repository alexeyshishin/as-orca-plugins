import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { Compartment, EditorState, Text, Transaction } from "@codemirror/state"
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, rectangularSelection } from "@codemirror/view"
import { createGutterController } from "./controller.js"
import { bindSession, mergeThreeWay } from "./format.js"
import { gitGutterExtension, setGutterSnapshot } from "./gutter.js"
import { gutterHead, resolveGutter } from "./resolve-client.js"

const DEBOUNCE_MS = 300
const hostElement = document.getElementById("editor")
const appearance = new Compartment()

function isDark() {
  return document.documentElement.classList.contains("dark")
}

function appearanceExtension(dark) {
  return EditorView.darkTheme.of(dark)
}

function showNotice(message) {
  hostElement.textContent = message
  hostElement.className = "notice"
}

function createEditor() {
  let view = null
  let userChangeListener = () => {}

  const extensions = (readOnly) => [
    EditorState.lineSeparator.of("\n"),
    EditorState.readOnly.of(readOnly),
    history(),
    drawSelection(),
    rectangularSelection(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    gitGutterExtension(),
    keymap.of([...historyKeymap, ...defaultKeymap]),
    appearance.of(appearanceExtension(isDark())),
    EditorView.contentAttributes.of({ "aria-label": "Code editor", spellcheck: "false" }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      if (update.transactions.some((transaction) => transaction.annotation(Transaction.remote))) return
      userChangeListener(update.state.sliceDoc())
    })
  ]

  return {
    open(text, readOnly) {
      view = new EditorView({ state: EditorState.create({ doc: text, extensions: extensions(readOnly) }), parent: hostElement })
    },
    text: () => view.state.sliceDoc(),
    replace({ from, to, insert }) {
      view.dispatch({
        changes: { from, to, insert: Text.of(insert.split("\n")) },
        annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)]
      })
    },
    onUserChange(listener) {
      userChangeListener = listener
    },
    setGutterState(state) {
      view?.dispatch({ effects: setGutterSnapshot.of(state) })
    },
    setDark(dark) {
      document.documentElement.classList.toggle("dark", dark)
      document.documentElement.classList.toggle("light", !dark)
      view?.dispatch({ effects: appearance.reconfigure(appearanceExtension(dark)) })
    }
  }
}

async function start() {
  if (!("session" in orca.document)) {
    showNotice("This editor needs a newer version of Orca.")
    return
  }
  const session = await orca.document.session({ debounceMs: DEBOUNCE_MS, merge: mergeThreeWay })
  const editor = createEditor()
  const gutter = createGutterController({
    resolveGutter,
    gutterHead,
    render: (state) => editor.setGutterState(state)
  })
  bindSession(session, editor)
  gutter.emit()
  gutter.resolve(session.value)
  session.onReplace((value) => {
    gutter.resolve(value)
    gutter.scheduleDiff()
  })
  editor.onUserChange(() => gutter.scheduleDiff())
  window.addEventListener("focus", () => gutter.onFocus(session.value))
  orca.on("theme", ({ colorScheme }) => editor.setDark(colorScheme === "dark"))
}

start().catch((error) => {
  console.error(error)
  showNotice("Git Gutter failed to start.")
})
