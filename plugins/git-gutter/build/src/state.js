import { detectFormat, toEditorText } from "./format.js"

export function initialGutterState() {
  return { kind: "unknown", reason: "not-resolved-yet", base: null, head: null, workspaceId: null }
}

function normalizeBase(raw) {
  const format = detectFormat(raw)
  return toEditorText(raw, format)
}

function resolvedFrom(result, editorTextAtRequest) {
  if (result.status === "unchanged") {
    return { kind: "resolved-clean", reason: null, base: editorTextAtRequest, head: result.head, workspaceId: result.workspaceId }
  }
  return {
    kind: "resolved-changed",
    reason: null,
    base: normalizeBase(result.base),
    head: result.head,
    workspaceId: result.workspaceId
  }
}

export function hasBase(state) {
  return state.kind === "resolved-clean" || state.kind === "resolved-changed"
}

export function applyResolveResult(state, result, editorTextAtRequest) {
  if (result.status === "unchanged" || result.status === "changed") return resolvedFrom(result, editorTextAtRequest)
  if (hasBase(state)) return state
  return { kind: result.status, reason: result.reason ?? null, base: null, head: state.head, workspaceId: state.workspaceId }
}

export function applyHeadMismatch(state) {
  return { kind: "stale", reason: "head-changed", base: null, head: null, workspaceId: state.workspaceId }
}

export function applyHeadMatch(state) {
  return state
}

export function isDrawable(state) {
  return hasBase(state)
}

export function gutterReason(state) {
  if (isDrawable(state)) return null
  return state.reason ?? state.kind
}
