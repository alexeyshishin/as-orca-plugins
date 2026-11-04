import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { search, searchKeymap } from "@codemirror/search"
import { Compartment, EditorState, Text, Transaction } from "@codemirror/state"
import { drawSelection, EditorView, keymap } from "@codemirror/view"
import { caretVisible } from "./caret.js"
import { linkClicks } from "./link-actions.js"
import { livePreview } from "./live-preview.js"
import { bindSession, mergeThreeWay } from "./sync.js"

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
    caretVisible(),
    linkClicks(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, completeHTMLTags: false }),
    search({ top: true }),
    livePreview(),
    keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
    appearance.of(appearanceExtension(isDark())),
    EditorView.contentAttributes.of({ "aria-label": "Markdown editor", spellcheck: "true" }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      if (update.transactions.some((transaction) => transaction.annotation(Transaction.remote))) return
      userChangeListener(update.state.sliceDoc())
    })
  ]

  return {
    open(text, readOnly) {
      view = new EditorView({
        state: EditorState.create({ doc: text, extensions: extensions(readOnly) }),
        parent: hostElement
      })
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
  bindSession(session, editor)
  orca.on("theme", ({ colorScheme }) => editor.setDark(colorScheme === "dark"))
}

start().catch((error) => {
  console.error(error)
  showNotice("Live Markdown failed to start.")
})
