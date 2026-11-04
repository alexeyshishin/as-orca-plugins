import { defaultKeymap, redo, undo } from "@codemirror/commands"
import { Annotation, EditorState, Prec } from "@codemirror/state"
import { drawSelection, EditorView, keymap } from "@codemirror/view"
import { caretVisible } from "./caret.js"
import { linkClicks, linkOfEvent, openTarget } from "./link-actions.js"
import { linkTooltip } from "./links.js"
import { inlinePreview } from "./inline-preview.js"
import { cellReplacement, cellTextFilter, exitPosition, neighborCell } from "./table-cells.js"
import { diffRange } from "./sync.js"

const STYLE_TAG = { link: "span", strong: "strong", em: "em", strike: "del", code: "code" }
const states = new WeakMap()
const syncAnnotation = Annotation.define()

function gridOf(model) {
  return [model.header, ...model.rows]
}

function appendSpans(parent, spans) {
  for (const span of spans) {
    let node = document.createTextNode(span.text)
    for (let index = span.styles.length - 1; index >= 0; index--) {
      const style = span.styles[index]
      const wrapper = document.createElement(STYLE_TAG[style])
      if (style === "link") {
        wrapper.className = "cm-live-link"
        wrapper.dataset.liveLink = span.link
        wrapper.title = linkTooltip(span.link, "")
      }
      wrapper.appendChild(node)
      node = wrapper
    }
    parent.appendChild(node)
  }
}

function renderCell(element, cell) {
  element.replaceChildren()
  appendSpans(element, cell.spans)
}

function lockWidths(state) {
  if (state.locked) return
  const widths = [...state.table.tHead.rows[0].cells].map((cell) => cell.getBoundingClientRect().width)
  const total = state.table.getBoundingClientRect().width
  state.table.style.tableLayout = "fixed"
  state.table.style.width = `${total}px`
  state.cells[0].forEach((cell, index) => {
    cell.style.width = `${widths[index]}px`
  })
  state.locked = true
}

function unlockWidths(state) {
  if (!state.locked) return
  state.table.style.tableLayout = ""
  state.table.style.width = ""
  state.cells[0].forEach((cell) => {
    cell.style.width = ""
  })
  state.locked = false
}

function tableStart(state) {
  return state.view.posAtDOM(state.wrapper)
}

function currentCell(state) {
  return gridOf(state.model)[state.active.row][state.active.column]
}

function finishActive(state) {
  const active = state.active
  if (!active) return
  state.active = null
  active.editor.destroy()
  active.element.classList.remove("cm-live-cell-active")
  renderCell(active.element, gridOf(state.model)[active.row][active.column])
}

function openSource(state, position) {
  finishActive(state)
  unlockWidths(state)
  state.view.dispatch({ selection: { anchor: position }, scrollIntoView: true })
  state.view.focus()
}

function exitTable(state, direction) {
  const start = tableStart(state)
  const position = exitPosition({ from: start, to: start + state.model.length }, state.view.state.doc.length, direction)
  finishActive(state)
  unlockWidths(state)
  state.view.dispatch({ selection: { anchor: position }, scrollIntoView: true })
  state.view.focus()
}

function moveFocus(state, move) {
  const { row, column } = state.active
  const grid = gridOf(state.model)
  const target = neighborCell(grid.length, state.model.aligns.length, row, column, move)
  if (!target) {
    exitTable(state, move === "previous" || move === "above" ? "above" : "below")
    return
  }
  activate(state, target.row, target.column, move === "next" ? "start" : "end")
}

function commit(state, text) {
  if (!state.active) return
  const change = cellReplacement(currentCell(state), text)
  if (!change) return
  const base = tableStart(state)
  state.committing = true
  try {
    state.view.dispatch({
      changes: { from: base + change.from, to: base + change.to, insert: change.insert },
      userEvent: "input.type"
    })
  } finally {
    state.committing = false
  }
}

function cellKeymap(state) {
  const run = (action) => () => {
    action()
    return true
  }
  const later = (action) => () => {
    queueMicrotask(() => {
      if (state.active) action()
    })
    return true
  }
  return [
    { key: "Tab", run: later(() => moveFocus(state, "next")) },
    { key: "Shift-Tab", run: later(() => moveFocus(state, "previous")) },
    { key: "Enter", run: later(() => moveFocus(state, "below")) },
    { key: "Shift-Enter", run: later(() => moveFocus(state, "below")) },
    { key: "Escape", run: later(() => exitTable(state, "below")) },
    {
      key: "ArrowDown",
      run: (view) => {
        const selection = view.state.selection.main
        if (!selection.empty || selection.head < view.state.doc.length) return false
        return later(() => moveFocus(state, "below"))()
      }
    },
    {
      key: "ArrowUp",
      run: (view) => {
        const selection = view.state.selection.main
        if (!selection.empty || selection.head > 0) return false
        return later(() => moveFocus(state, "above"))()
      }
    },
    { key: "Mod-z", run: run(() => undo(state.view)) },
    { key: "Mod-Shift-z", run: run(() => redo(state.view)) },
    { key: "Ctrl-y", run: run(() => redo(state.view)) }
  ]
}

function cellExtensions(state) {
  return [
    cellTextFilter,
    linkClicks(() => state.view),
    EditorView.lineWrapping,
    drawSelection(),
    caretVisible(),
    inlinePreview(),
    Prec.highest(keymap.of(cellKeymap(state))),
    keymap.of(defaultKeymap),
    EditorView.contentAttributes.of({ "aria-label": "Table cell" }),
    EditorView.domEventHandlers({
      paste(event, view) {
        event.preventDefault()
        const text = (event.clipboardData?.getData("text/plain") ?? "").replace(/\s*(\r\n|\r|\n)\s*/g, " ")
        if (text) view.dispatch(view.state.replaceSelection(text))
        return true
      },
      beforeinput(event) {
        if (event.inputType === "historyUndo") {
          event.preventDefault()
          undo(state.view)
          return true
        }
        if (event.inputType === "historyRedo") {
          event.preventDefault()
          redo(state.view)
          return true
        }
        return false
      }
    }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged || update.transactions.some((transaction) => transaction.annotation(syncAnnotation))) return
      commit(state, update.state.doc.toString())
    })
  ]
}

function activate(state, row, column, caret) {
  const cell = gridOf(state.model)[row]?.[column]
  if (!cell) return
  if (!cell.editable) {
    openSource(state, tableStart(state) + cell.offset)
    return
  }
  const element = state.cells[row][column]
  if (state.active?.element === element) return
  state.switching = true
  finishActive(state)
  lockWidths(state)
  element.replaceChildren()
  element.classList.add("cm-live-cell-active")
  const anchor = caret === "start" ? 0 : cell.source.length
  const editor = new EditorView({
    state: EditorState.create({ doc: cell.source, selection: { anchor }, extensions: cellExtensions(state) }),
    parent: element
  })
  state.active = { row, column, element, editor }
  editor.focus()
  if (caret && typeof caret === "object") {
    const position = editor.posAtCoords({ x: caret.x, y: caret.y })
    if (position !== null) editor.dispatch({ selection: { anchor: position } })
  }
  state.switching = false
}

function syncEditor(state, cell) {
  const editor = state.active.editor
  const current = editor.state.doc.toString()
  if (current.trim() === cell.source || editor.composing) return
  editor.dispatch({ changes: diffRange(current, cell.source), annotations: syncAnnotation.of(true) })
}

function onMouseDown(state, event) {
  if (event.button !== 0 || !(event.target instanceof Element)) return
  if (event.target.closest(".cm-live-table-source")) {
    event.preventDefault()
    return
  }
  const link = linkOfEvent(event)
  if (link && !state.active?.element.contains(link)) {
    event.preventDefault()
    openTarget(link.dataset.liveLink, state.view)
    return
  }
  const element = event.target.closest("th, td")
  if (!element) return
  if (state.active?.element === element) return
  event.preventDefault()
  activate(state, Number(element.dataset.row), Number(element.dataset.column), { x: event.clientX, y: event.clientY })
}

function onFocusOut(state, event) {
  if (state.switching || !state.active || !state.active.element.contains(event.target)) return
  if (!document.hasFocus()) return
  const next = event.relatedTarget
  if (next instanceof Node && state.active.element.contains(next)) return
  finishActive(state)
  if (!(next instanceof Node) || !state.wrapper.contains(next)) unlockWidths(state)
}

function cellElement(tag, row, column, cell, align) {
  const element = document.createElement(tag)
  element.dataset.row = String(row)
  element.dataset.column = String(column)
  element.dataset.offset = String(cell.offset)
  if (align) element.style.textAlign = align
  renderCell(element, cell)
  return element
}

export function createTableDom(view, model) {
  const wrapper = document.createElement("div")
  wrapper.className = "cm-live-table-wrap"
  const table = document.createElement("table")
  table.className = "cm-live-table"
  const head = table.createTHead().insertRow()
  const body = table.createTBody()
  const cells = []
  cells.push(model.header.map((cell, column) => head.appendChild(cellElement("th", 0, column, cell, model.aligns[column]))))
  model.rows.forEach((rowCells, index) => {
    const tr = body.insertRow()
    cells.push(rowCells.map((cell, column) => tr.appendChild(cellElement("td", index + 1, column, cell, model.aligns[column]))))
  })
  const source = document.createElement("button")
  source.type = "button"
  source.className = "cm-live-table-source"
  source.textContent = "Source"
  source.title = "Edit the whole table as Markdown"
  wrapper.append(table, source)
  const state = { view, model, wrapper, table, cells, active: null, committing: false, switching: false, locked: false }
  states.set(wrapper, state)
  wrapper.addEventListener("mousedown", (event) => onMouseDown(state, event))
  wrapper.addEventListener("focusout", (event) => onFocusOut(state, event))
  source.addEventListener("click", (event) => {
    event.preventDefault()
    openSource(state, tableStart(state))
  })
  return wrapper
}

export function updateTableDom(wrapper, model) {
  const state = states.get(wrapper)
  if (!state) return false
  const grid = gridOf(model)
  const same =
    grid.length === state.cells.length &&
    model.aligns.length === state.cells[0].length &&
    grid.every((row, index) => row.length === state.cells[index].length)
  if (!same) return false
  state.model = model
  grid.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      const element = state.cells[rowIndex][columnIndex]
      element.dataset.offset = String(cell.offset)
      element.style.textAlign = model.aligns[columnIndex] ?? ""
      if (state.active?.element !== element) {
        renderCell(element, cell)
        return
      }
      if (!state.committing) syncEditor(state, cell)
    })
  })
  return true
}

export function destroyTableDom(wrapper) {
  const state = states.get(wrapper)
  if (state?.active) {
    state.active.editor.destroy()
    state.active = null
  }
  states.delete(wrapper)
}
