import assert from "node:assert/strict"
import { test } from "node:test"
import { gitBlobIds } from "../src/blob-id.js"
import { createGutterController } from "../src/controller.js"
import { detectFormat, toEditorText } from "../src/format.js"

function blobIdsOf(rawText) {
  const format = detectFormat(rawText)
  return gitBlobIds(rawText, toEditorText(rawText, format))
}

function fakeClock(start = 0) {
  let time = start
  const timers = []
  return {
    now: () => time,
    setTimer: (callback, delay) => {
      const entry = { at: time + delay, callback, fired: false }
      timers.push(entry)
      return entry
    },
    clearTimer: (entry) => {
      entry.fired = true
    },
    advance(ms) {
      time += ms
      for (const entry of timers) {
        if (!entry.fired && entry.at <= time) {
          entry.fired = true
          entry.callback()
        }
      }
    }
  }
}

function controllerHarness({ answers = [], focusThrottleMs = 2000, diffDebounceMs = 200 } = {}) {
  const renders = []
  const resolveCalls = []
  const headCalls = []
  const clock = fakeClock()
  let answerIndex = 0
  const controller = createGutterController({
    resolveGutter: async (blobIds, workspaceId) => {
      resolveCalls.push({ blobIds, workspaceId })
      const answer = answers[Math.min(answerIndex, answers.length - 1)]
      answerIndex++
      if (answer.throws) throw answer.throws
      return answer.result
    },
    gutterHead: async (workspaceId) => {
      headCalls.push(workspaceId)
      const answer = answers[Math.min(answerIndex, answers.length - 1)]
      answerIndex++
      if (answer.throws) throw answer.throws
      return answer.result
    },
    render: (state) => renders.push(state),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    focusThrottleMs,
    diffDebounceMs
  })
  return { controller, renders, resolveCalls, headCalls, clock }
}

test("unchanged with no edits renders a resolved-clean state whose base equals the buffer", async () => {
  const { controller, renders } = controllerHarness({
    answers: [{ result: { status: "unchanged", head: "h1", workspaceId: "w1" } }]
  })
  await controller.resolve("a\nb\n")
  const last = renders.at(-1)
  assert.equal(last.kind, "resolved-clean")
  assert.equal(last.base, "a\nb\n")
})

test("unchanged, then a buffer edit, diffs only against the edit once the diff debounce fires", async () => {
  const { controller, clock } = controllerHarness({
    answers: [{ result: { status: "unchanged", head: "h1", workspaceId: "w1" } }]
  })
  await controller.resolve("a\nb\nc\n")
  controller.scheduleDiff()
  clock.advance(200)
  assert.equal(controller.getState().base, "a\nb\nc\n")
})

test("changed with an LF base is stored as-is", async () => {
  const { controller } = controllerHarness({
    answers: [{ result: { status: "changed", base: "a\nb\n", head: "h1", workspaceId: "w1" } }]
  })
  await controller.resolve("a\nB\n")
  assert.equal(controller.getState().base, "a\nb\n")
})

test("changed with a CRLF base normalizes to LF with no edits, markers would be empty against the LF buffer", async () => {
  const { controller } = controllerHarness({
    answers: [{ result: { status: "changed", base: "a\r\nb\r\nc\r\n", head: "h1", workspaceId: "w1" } }]
  })
  await controller.resolve("a\nb\nc\n")
  assert.equal(controller.getState().base, "a\nb\nc\n")
})

test("changed with a BOM base normalizes to strip the BOM with no edits", async () => {
  const { controller } = controllerHarness({
    answers: [{ result: { status: "changed", base: "﻿a\nb\n", head: "h1", workspaceId: "w1" } }]
  })
  await controller.resolve("a\nb\n")
  assert.equal(controller.getState().base, "a\nb\n")
})

test("changed with one real edit keeps only that edit's difference from the normalized base", async () => {
  const { controller } = controllerHarness({
    answers: [{ result: { status: "changed", base: "a\r\nb\r\nc\r\n", head: "h1", workspaceId: "w1" } }]
  })
  await controller.resolve("a\nB\nc\n")
  assert.equal(controller.getState().base, "a\nb\nc\n")
})

test("an unknown/ambiguous/unsupported answer never erases an existing base while HEAD stays the same", async () => {
  const { controller } = controllerHarness({
    answers: [
      { result: { status: "changed", base: "a\nb\n", head: "h1", workspaceId: "w1" } },
      { result: { status: "unknown", reason: "draft" } }
    ]
  })
  await controller.resolve("a\nB\n")
  const resolved = controller.getState()
  await controller.resolve("a\nB\n")
  assert.deepEqual(controller.getState(), resolved)
})

test("a HEAD change on focus drops the base to stale and resolves again with the known workspaceId", async () => {
  const { controller, resolveCalls, clock } = controllerHarness({
    focusThrottleMs: 0,
    answers: [
      { result: { status: "changed", base: "a\nb\n", head: "h1", workspaceId: "w1" } },
      { result: { status: "ok", head: "h2" } },
      { result: { status: "changed", base: "a\nB\n", head: "h2", workspaceId: "w1" } }
    ]
  })
  await controller.resolve("a\nB\n")
  await controller.onFocus("a\nB\n")
  assert.equal(controller.getState().kind, "resolved-changed")
  assert.equal(controller.getState().head, "h2")
  assert.equal(resolveCalls.at(-1).workspaceId, "w1")
})

test("a rejected resolveGutter request never throws, and is treated as unknown", async () => {
  const { controller } = controllerHarness({ answers: [{ throws: new Error("boom") }] })
  await assert.doesNotReject(() => controller.resolve("a\n"))
  assert.equal(controller.getState().kind, "unknown")
})

test("a rejected gutterHead on focus never throws and still attempts a resolve", async () => {
  const { controller, resolveCalls } = controllerHarness({
    focusThrottleMs: 0,
    answers: [
      { result: { status: "changed", base: "a\nb\n", head: "h1", workspaceId: "w1" } },
      { throws: new Error("unavailable") }
    ]
  })
  await controller.resolve("a\nb\n")
  await assert.doesNotReject(() => controller.onFocus("a\nb\n"))
  assert.equal(resolveCalls.length, 2)
})

test("focus is throttled: a second focus within the window makes no new request", async () => {
  const { controller, resolveCalls, headCalls, clock } = controllerHarness({
    focusThrottleMs: 2000,
    answers: [
      { result: { status: "changed", base: "a\nb\n", head: "h1", workspaceId: "w1" } },
      { result: { status: "ok", head: "h1" } }
    ]
  })
  await controller.resolve("a\nb\n")
  await controller.onFocus("a\nb\n")
  const callsAfterFirstFocus = headCalls.length
  clock.advance(500)
  await controller.onFocus("a\nb\n")
  assert.equal(headCalls.length, callsAfterFirstFocus)
})

test("opening and editing are never throttled, only focus is", async () => {
  const { controller, resolveCalls } = controllerHarness({
    focusThrottleMs: 2000,
    answers: [
      { result: { status: "unchanged", head: "h1", workspaceId: "w1" } },
      { result: { status: "changed", base: "a\n", head: "h1", workspaceId: "w1" } }
    ]
  })
  await controller.resolve("a\n")
  await controller.resolve("a\nb\n")
  assert.equal(resolveCalls.length, 2)
})

test("a stale response from an older request never overwrites a newer edit's result", async () => {
  const slowFirst = { result: { status: "changed", base: "a\n", head: "h1", workspaceId: "w1" } }
  const fastSecond = { result: { status: "changed", base: "a\nb\n", head: "h1", workspaceId: "w1" } }
  let resolveFirst
  const firstPromise = new Promise((resolve) => (resolveFirst = resolve))
  const renders = []
  const controller = createGutterController({
    resolveGutter: async (blobIds) => {
      if (blobIds.join() === blobIdsOf("a\n").join()) {
        await firstPromise
        return slowFirst.result
      }
      return fastSecond.result
    },
    gutterHead: async () => ({ status: "ok", head: "h1" }),
    render: (state) => renders.push(state)
  })
  const firstResolve = controller.resolve("a\n")
  const secondResolve = controller.resolve("a\nb\n")
  await secondResolve
  resolveFirst()
  await firstResolve
  assert.equal(controller.getState().base, "a\nb\n")
})
