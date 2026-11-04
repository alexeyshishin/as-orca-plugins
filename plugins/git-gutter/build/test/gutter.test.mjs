import { EditorState } from "@codemirror/state"
import assert from "node:assert/strict"
import { test } from "node:test"
import { buildMarkers, gutterSnapshotField, setGutterSnapshot } from "../src/gutter.js"

function markersOf(rangeSet) {
  const out = []
  rangeSet.between(0, 1e9, (from, to, value) => {
    out.push({ from, kind: value.kind ?? null, shaded: value.reason !== undefined })
  })
  return out
}

test("a drawable resolved-clean state with no diff yields no markers", () => {
  const doc = EditorState.create({ doc: "a\nb\nc\n" }).doc
  const rangeSet = buildMarkers({ kind: "resolved-clean", base: "a\nb\nc\n" }, doc)
  assert.deepEqual(markersOf(rangeSet), [])
})

test("a drawable resolved-clean state where base equals the full buffer (regression for the empty-base bug) yields no markers", () => {
  const doc = EditorState.create({ doc: "a\nb\nc\n" }).doc
  const rangeSet = buildMarkers({ kind: "resolved-clean", base: "a\nb\nc\n" }, doc)
  assert.deepEqual(markersOf(rangeSet), [])
})

test("a resolved-changed state whose base is CRLF-normalized ahead of time and equals the buffer yields no markers", () => {
  const doc = EditorState.create({ doc: "a\nb\nc\n" }).doc
  const rangeSet = buildMarkers({ kind: "resolved-changed", base: "a\nb\nc\n" }, doc)
  assert.deepEqual(markersOf(rangeSet), [])
})

test("a drawable resolved-changed state yields one marker per changed line", () => {
  const doc = EditorState.create({ doc: "a\nB\nc\n" }).doc
  const rangeSet = buildMarkers({ kind: "resolved-changed", base: "a\nb\nc\n" }, doc)
  const markers = markersOf(rangeSet)
  assert.equal(markers.length, 1)
  assert.equal(markers[0].kind, "modified")
})

for (const kind of ["unknown", "ambiguous", "unsupported", "stale"]) {
  test(`a non-drawable state (${kind}) shades every line with its reason`, () => {
    const doc = EditorState.create({ doc: "a\nb\nc\n" }).doc
    const rangeSet = buildMarkers({ kind, reason: `reason-${kind}` }, doc)
    const markers = markersOf(rangeSet)
    assert.equal(markers.length, doc.lines)
    assert.ok(markers.every((marker) => marker.shaded))
  })
}

test("the gutterSnapshotField starts shaded with the not-resolved-yet reason", () => {
  const state = EditorState.create({ doc: "a\nb\n", extensions: [gutterSnapshotField] })
  const rangeSet = state.field(gutterSnapshotField)
  const markers = markersOf(rangeSet)
  assert.equal(markers.length, state.doc.lines)
})

test("dispatching setGutterSnapshot swaps the field to the new snapshot", () => {
  let state = EditorState.create({ doc: "a\nb\nc\n", extensions: [gutterSnapshotField] })
  state = state.update({ effects: setGutterSnapshot.of({ kind: "resolved-changed", base: "a\nB\nc\n" }) }).state
  const markers = markersOf(state.field(gutterSnapshotField))
  assert.equal(markers.length, 1)
  assert.equal(markers[0].kind, "modified")
})

test("typing without a new snapshot keeps the field mapped through the edit, not recomputed", () => {
  let state = EditorState.create({ doc: "a\nb\nc\n", extensions: [gutterSnapshotField] })
  state = state.update({ effects: setGutterSnapshot.of({ kind: "resolved-changed", base: "a\nB\nc\n" }) }).state
  const before = markersOf(state.field(gutterSnapshotField))
  state = state.update({ changes: { from: 0, insert: "x" } }).state
  const after = markersOf(state.field(gutterSnapshotField))
  assert.equal(after.length, before.length)
})
