import { syntaxTree } from "@codemirror/language"
import { EditorView } from "@codemirror/view"
import { classifyTarget, findAnchor, headingPlainText } from "./links.js"

const NOTICE_MS = 3500
const FILE_TIMEOUT_MS = 15000
const UNAVAILABLE_CODES = new Set(["unavailable", "unknown_method", "consent_required", "capability_denied", "not_permitted"])

export function showNotice(message) {
  document.getElementById("live-toast")?.remove()
  const toast = document.createElement("div")
  toast.id = "live-toast"
  toast.className = "cm-live-toast"
  toast.setAttribute("role", "status")
  toast.textContent = message
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), NOTICE_MS)
}

export function collectHeadings(state) {
  const headings = []
  syntaxTree(state).iterate({
    enter(node) {
      if (!/^(ATXHeading|SetextHeading)[1-6]$/.test(node.name)) return
      const line = state.doc.lineAt(node.from)
      headings.push({ text: headingPlainText(line.text), from: line.from })
      return false
    }
  })
  return headings
}

function goToAnchor(view, fragment) {
  const heading = findAnchor(collectHeadings(view.state), fragment)
  if (!heading) {
    showNotice(`Заголовок «${fragment}» не найден`)
    return
  }
  view.dispatch({
    selection: { anchor: heading.from },
    effects: EditorView.scrollIntoView(heading.from, { y: "start", yMargin: 24 })
  })
  view.focus()
}

function openExternal(url) {
  if (typeof orca === "undefined" || !orca.shell?.openExternal) {
    showNotice("Открытие ссылок недоступно в этом клиенте")
    return
  }
  orca.shell.openExternal(url).then(
    (result) => {
      if (result && result.opened === false && result.reason !== "cancelled") showNotice("Ссылка не открыта")
    },
    (error) => showNotice(`Не удалось открыть ссылку: ${error?.message ?? error}`)
  )
}

function requestWorker(target) {
  const input = { target }
  if (orca.plugin?.request) return orca.plugin.request("link.open", input, { timeoutMs: FILE_TIMEOUT_MS })
  return orca.host.call("plugin.request", { name: "link.open", input, timeoutMs: FILE_TIMEOUT_MS }).then((answer) => answer.output)
}

async function openFile(target) {
  try {
    const answer = await requestWorker(target)
    if (!answer?.ok) showNotice(answer?.message ?? "Не удалось открыть файл")
  } catch (error) {
    if (UNAVAILABLE_CODES.has(error?.code)) showNotice("Открытие файлов недоступно: одобрите плагин")
    else showNotice(`Не удалось открыть файл: ${error?.message ?? error}`)
  }
}

export function openTarget(raw, outerView) {
  const target = classifyTarget(raw)
  if (target.kind === "external") openExternal(target.url)
  else if (target.kind === "anchor") goToAnchor(outerView, target.fragment)
  else if (target.kind === "file") openFile(target.target)
  else if (target.kind === "blocked") showNotice("Ссылка заблокирована: неподдерживаемая схема")
}

export function linkOfEvent(event) {
  if (event.button !== 0 || !(event.metaKey || event.ctrlKey) || !(event.target instanceof Element)) return null
  return event.target.closest("[data-live-link]")
}

export function linkClicks(outerView) {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const link = linkOfEvent(event)
      if (!link) return false
      event.preventDefault()
      openTarget(link.dataset.liveLink, outerView?.() ?? view)
      return true
    }
  })
}
