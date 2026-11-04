import assert from "node:assert/strict"
import { test } from "node:test"
import {
  applyHeadMismatch,
  applyResolveResult,
  gutterReason,
  hasBase,
  initialGutterState,
  isDrawable
} from "../src/state.js"

test("the initial state is unknown and not drawable", () => {
  const state = initialGutterState()
  assert.equal(state.kind, "unknown")
  assert.equal(isDrawable(state), false)
  assert.equal(gutterReason(state), "not-resolved-yet")
})

test("unchanged resolves to resolved-clean, base equal to the text the request was computed from", () => {
  const state = applyResolveResult(
    initialGutterState(),
    { status: "unchanged", head: "h1", workspaceId: "w1" },
    "a\nb\n"
  )
  assert.equal(state.kind, "resolved-clean")
  assert.equal(isDrawable(state), true)
  assert.equal(state.base, "a\nb\n")
  assert.equal(state.head, "h1")
  assert.equal(state.workspaceId, "w1")
})

test("changed resolves to resolved-changed, drawable with the given base", () => {
  const state = applyResolveResult(
    initialGutterState(),
    { status: "changed", base: "old text\n", head: "h1", workspaceId: "w1" },
    "new text\n"
  )
  assert.equal(state.kind, "resolved-changed")
  assert.equal(isDrawable(state), true)
  assert.equal(state.base, "old text\n")
})

test("a CRLF base from git is normalized to LF before being stored", () => {
  const state = applyResolveResult(
    initialGutterState(),
    { status: "changed", base: "a\r\nb\r\nc\r\n", head: "h1", workspaceId: "w1" },
    "a\nb\nc\n"
  )
  assert.equal(state.base, "a\nb\nc\n")
})

test("a BOM-prefixed base from git has its BOM stripped before being stored", () => {
  const state = applyResolveResult(
    initialGutterState(),
    { status: "changed", base: "﻿a\nb\n", head: "h1", workspaceId: "w1" },
    "a\nb\n"
  )
  assert.equal(state.base, "a\nb\n")
})

for (const status of ["unknown", "ambiguous", "unsupported"]) {
  test(`${status} from a fresh state is shaded with its reason`, () => {
    const state = applyResolveResult(initialGutterState(), { status, reason: "some-reason" }, "a\n")
    assert.equal(state.kind, status)
    assert.equal(isDrawable(state), false)
    assert.equal(gutterReason(state), "some-reason")
  })
}

test("a failure after a successful resolve never drops the existing base", () => {
  const resolved = applyResolveResult(
    initialGutterState(),
    { status: "changed", base: "old text\n", head: "h1", workspaceId: "w1" },
    "new text\n"
  )
  const afterFailure = applyResolveResult(resolved, { status: "unknown", reason: "draft" }, "new text\n")
  assert.deepEqual(afterFailure, resolved)
  assert.equal(isDrawable(afterFailure), true)
})

test("a HEAD change always drops the base and marks the state stale", () => {
  const resolved = applyResolveResult(
    initialGutterState(),
    { status: "changed", base: "old text\n", head: "h1", workspaceId: "w1" },
    "new text\n"
  )
  const stale = applyHeadMismatch(resolved)
  assert.equal(stale.kind, "stale")
  assert.equal(isDrawable(stale), false)
  assert.equal(stale.base, null)
  assert.equal(stale.workspaceId, "w1")
  assert.equal(gutterReason(stale), "head-changed")
})

test("resolving again after a HEAD change produces a fresh drawable state", () => {
  const resolved = applyResolveResult(
    initialGutterState(),
    { status: "changed", base: "old text\n", head: "h1", workspaceId: "w1" },
    "new text\n"
  )
  const stale = applyHeadMismatch(resolved)
  const freshlyResolved = applyResolveResult(
    stale,
    { status: "changed", base: "new text\n", head: "h2", workspaceId: "w1" },
    "newer text\n"
  )
  assert.equal(freshlyResolved.kind, "resolved-changed")
  assert.equal(freshlyResolved.base, "new text\n")
  assert.equal(freshlyResolved.head, "h2")
})

test("hasBase mirrors isDrawable for every known kind", () => {
  assert.equal(hasBase({ kind: "resolved-clean" }), true)
  assert.equal(hasBase({ kind: "resolved-changed" }), true)
  assert.equal(hasBase({ kind: "stale" }), false)
  assert.equal(hasBase({ kind: "unknown" }), false)
  assert.equal(hasBase({ kind: "ambiguous" }), false)
  assert.equal(hasBase({ kind: "unsupported" }), false)
})
