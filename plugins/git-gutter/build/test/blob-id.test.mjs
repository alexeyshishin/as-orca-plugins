import { execFileSync } from "node:child_process"
import assert from "node:assert/strict"
import { test } from "node:test"
import { gitBlobId, gitBlobIds } from "../src/blob-id.js"
import { detectFormat, toEditorText } from "../src/format.js"

function realHashObject(text) {
  return execFileSync("git", ["hash-object", "--no-filters", "--stdin"], { input: Buffer.from(text, "utf8") })
    .toString("utf8")
    .trim()
}

const FIXTURES = {
  ascii: "hello world\n",
  cyrillic: "Привет, мир\n",
  surrogatePairs: "a\u{1F389}b\u{1F38A}\n",
  crlf: "line one\r\nline two\r\n",
  bom: "﻿line one\nline two\n",
  empty: "",
  noFinalNewline: "no trailing newline here"
}

for (const [name, text] of Object.entries(FIXTURES)) {
  test(`gitBlobId matches git hash-object: ${name}`, () => {
    assert.equal(gitBlobId(text), realHashObject(text))
  })
}

test("gitBlobIds returns a single id when raw equals normalized", () => {
  const ids = gitBlobIds(FIXTURES.ascii, FIXTURES.ascii)
  assert.deepEqual(ids, [gitBlobId(FIXTURES.ascii)])
})

test("gitBlobIds returns two distinct ids for CRLF, matching real git on each form", () => {
  const format = detectFormat(FIXTURES.crlf)
  const normalized = toEditorText(FIXTURES.crlf, format)
  const ids = gitBlobIds(FIXTURES.crlf, normalized)
  assert.equal(ids.length, 2)
  assert.equal(ids[0], realHashObject(FIXTURES.crlf))
  assert.equal(ids[1], realHashObject(normalized))
})

test("gitBlobIds returns two distinct ids for a BOM-prefixed file", () => {
  const format = detectFormat(FIXTURES.bom)
  const normalized = toEditorText(FIXTURES.bom, format)
  const ids = gitBlobIds(FIXTURES.bom, normalized)
  assert.equal(ids.length, 2)
  assert.equal(ids[0], realHashObject(FIXTURES.bom))
  assert.equal(ids[1], realHashObject(normalized))
})
