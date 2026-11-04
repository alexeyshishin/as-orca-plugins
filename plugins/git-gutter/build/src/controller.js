import { gitBlobIds } from "./blob-id.js"
import { detectFormat, toEditorText } from "./format.js"
import { applyHeadMismatch, applyResolveResult, initialGutterState } from "./state.js"

const DEFAULT_FOCUS_THROTTLE_MS = 2000
const DEFAULT_DIFF_DEBOUNCE_MS = 200

function requestBlobIds(rawText) {
  const format = detectFormat(rawText)
  const normalized = toEditorText(rawText, format)
  return { blobIds: gitBlobIds(rawText, normalized), normalized }
}

export function createGutterController(deps) {
  const {
    resolveGutter,
    gutterHead,
    render,
    now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (id) => clearTimeout(id),
    focusThrottleMs = DEFAULT_FOCUS_THROTTLE_MS,
    diffDebounceMs = DEFAULT_DIFF_DEBOUNCE_MS
  } = deps

  let state = initialGutterState()
  let lastFocusResolveAt = 0
  let diffTimer = null
  let requestSeq = 0

  function emit() {
    render(state)
  }

  function getState() {
    return state
  }

  async function runResolve(rawText) {
    const seq = ++requestSeq
    const { blobIds, normalized } = requestBlobIds(rawText)
    let result
    try {
      result = await resolveGutter(blobIds, state.workspaceId ?? undefined)
    } catch (error) {
      result = { status: "unknown", reason: error?.message ?? "request-failed" }
    }
    if (seq !== requestSeq) return
    state = applyResolveResult(state, result, normalized)
    emit()
  }

  function resolve(rawText) {
    return runResolve(rawText)
  }

  function scheduleDiff() {
    if (diffTimer) clearTimer(diffTimer)
    diffTimer = setTimer(() => {
      diffTimer = null
      emit()
    }, diffDebounceMs)
  }

  async function onFocus(rawText) {
    const timestamp = now()
    if (timestamp - lastFocusResolveAt < focusThrottleMs) return
    lastFocusResolveAt = timestamp
    if (!state.workspaceId) {
      await resolve(rawText)
      return
    }
    let head
    try {
      head = await gutterHead(state.workspaceId)
    } catch {
      await resolve(rawText)
      return
    }
    if (head?.status === "ok" && head.head === state.head) return
    state = applyHeadMismatch(state)
    emit()
    await resolve(rawText)
  }

  return { resolve, scheduleDiff, onFocus, getState, emit }
}
