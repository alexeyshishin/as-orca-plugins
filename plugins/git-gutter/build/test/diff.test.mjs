import assert from "node:assert/strict"
import { test } from "node:test"
import { computeLineMarkers } from "../src/diff.js"

test("equal texts produce no markers", () => {
  assert.deepEqual(computeLineMarkers("a\nb\nc\n", "a\nb\nc\n"), [])
  assert.deepEqual(computeLineMarkers("", ""), [])
})

test("an appended line at the end is added", () => {
  const markers = computeLineMarkers("a\nb\n", "a\nb\nc\n")
  assert.deepEqual(markers, [{ line: 2, kind: "added" }])
})

test("an inserted line in the middle is added at its own position", () => {
  const markers = computeLineMarkers("a\nb\nc\n", "a\nx\nb\nc\n")
  assert.deepEqual(markers, [{ line: 1, kind: "added" }])
})

test("a changed line is modified, not added plus deleted", () => {
  const markers = computeLineMarkers("a\nb\nc\n", "a\nB\nc\n")
  assert.deepEqual(markers, [{ line: 1, kind: "modified" }])
})

test("a deleted line in the middle marks the line that now follows it", () => {
  const markers = computeLineMarkers("a\nb\nc\nd\n", "a\nc\nd\n")
  assert.deepEqual(markers, [{ line: 1, kind: "deleted" }])
})

test("a deleted line at the start of the file marks the first line", () => {
  const markers = computeLineMarkers("a\nb\nc\n", "b\nc\n")
  assert.deepEqual(markers, [{ line: 0, kind: "deleted" }])
})

test("a deleted line at the end of the file marks the last remaining line", () => {
  const markers = computeLineMarkers("a\nb\nc\n", "a\nb\n")
  assert.deepEqual(markers, [{ line: 1, kind: "deleted" }])
})

test("deleting the only line of a file marks line zero", () => {
  const markers = computeLineMarkers("only\n", "")
  assert.deepEqual(markers, [{ line: 0, kind: "deleted" }])
})

test("a block replaced by a shorter block is modified then deleted at the boundary", () => {
  const markers = computeLineMarkers("a\nb\nc\nd\ne\n", "a\nX\nd\ne\n")
  assert.deepEqual(markers, [
    { line: 1, kind: "modified" },
    { line: 2, kind: "deleted" }
  ])
})

test("a block replaced by a longer block is modified then added", () => {
  const markers = computeLineMarkers("a\nb\nd\n", "a\nX\nY\nZ\nd\n")
  assert.deepEqual(markers, [
    { line: 1, kind: "modified" },
    { line: 2, kind: "added" },
    { line: 3, kind: "added" }
  ])
})

test("adding an untracked file (empty base) marks every line added", () => {
  const markers = computeLineMarkers("", "a\nb\nc\n")
  assert.deepEqual(markers, [
    { line: 0, kind: "added" },
    { line: 1, kind: "added" },
    { line: 2, kind: "added" }
  ])
})

test("an empty base only comes from an untracked or new file, never from unchanged (regression: unchanged must carry the real base, not '')", () => {
  const markers = computeLineMarkers("", "a\nb\n")
  assert.equal(markers.length, 2)
  assert.ok(markers.every((marker) => marker.kind === "added"))
})

test("CRLF text normalized before diffing behaves exactly like LF text", () => {
  const base = "a\r\nb\r\nc\r\n".replaceAll("\r\n", "\n")
  const buffer = "a\r\nB\r\nc\r\n".replaceAll("\r\n", "\n")
  assert.deepEqual(computeLineMarkers(base, buffer), [{ line: 1, kind: "modified" }])
})

test("a BOM-prefixed text normalized before diffing behaves like the BOM-free text", () => {
  const base = "﻿a\nb\n".slice(1)
  const buffer = "﻿a\nB\n".slice(1)
  assert.deepEqual(computeLineMarkers(base, buffer), [{ line: 1, kind: "modified" }])
})

test("large documents exceeding the LCS cell limit degrade to a single large-block diff without hanging", () => {
  const lines = Array.from({ length: 3000 }, (_, index) => `line ${index}\n`)
  const base = lines.join("")
  const buffer = lines.map((line, index) => (index === 1500 ? "changed\n" : line)).join("")
  const started = performance.now()
  const markers = computeLineMarkers(base, buffer)
  const elapsed = performance.now() - started
  assert.ok(markers.length > 0)
  assert.ok(elapsed < 2000, `took ${elapsed} ms`)
})
