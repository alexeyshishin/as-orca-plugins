import assert from "node:assert/strict"
import { test } from "node:test"
import { bareTarget, buildAnchors, classifyTarget, findAnchor, headingPlainText, slugify } from "../src/links.js"

test("web and mail targets are external, case-insensitive on the scheme", () => {
  assert.deepEqual(classifyTarget("https://a.b/c?d=1#e"), { kind: "external", url: "https://a.b/c?d=1#e" })
  assert.deepEqual(classifyTarget("HTTP://a.b"), { kind: "external", url: "HTTP://a.b" })
  assert.deepEqual(classifyTarget("mailto:x@y.z"), { kind: "external", url: "mailto:x@y.z" })
  assert.deepEqual(classifyTarget("<https://a.b/c>"), { kind: "external", url: "https://a.b/c" })
})

test("every other scheme is blocked", () => {
  for (const target of ["javascript:alert(1)", "JavaScript:alert(1)", "file:///etc/passwd", "data:text/html,x", "vbscript:x", "orca://plugins/x", "C:\\Windows\\x", "//evil.example/x", "https://a.b/ c", "ftp://x"]) {
    assert.equal(classifyTarget(target).kind, "blocked", target)
  }
})

test("anchors, files and empty targets", () => {
  assert.deepEqual(classifyTarget("#Заголовок%201"), { kind: "anchor", fragment: "Заголовок 1" })
  assert.deepEqual(classifyTarget("#%E0%A4%A"), { kind: "anchor", fragment: "%E0%A4%A" })
  assert.deepEqual(classifyTarget("plugins/live-markdown"), { kind: "file", target: "plugins/live-markdown" })
  assert.deepEqual(classifyTarget("./a b.md"), { kind: "file", target: "./a b.md" })
  assert.deepEqual(classifyTarget("<a b/c.md>"), { kind: "file", target: "a b/c.md" })
  assert.deepEqual(classifyTarget("/docs/x.md"), { kind: "file", target: "/docs/x.md" })
  assert.equal(classifyTarget("").kind, "empty")
  assert.equal(classifyTarget("   ").kind, "empty")
  assert.equal(classifyTarget(null).kind, "empty")
})

test("bare URLs without a scheme get one", () => {
  assert.equal(bareTarget("www.example.com/x"), "https://www.example.com/x")
  assert.equal(bareTarget("mail@example.com"), "mailto:mail@example.com")
  assert.equal(bareTarget("https://example.com"), "https://example.com")
})

test("GitHub-style slugs keep letters, digits, Cyrillic, hyphens and underscores", () => {
  assert.equal(slugify("Hello, World!"), "hello-world")
  assert.equal(slugify("Вопросы по контексту"), "вопросы-по-контексту")
  assert.equal(slugify("snake_case & more -- stuff"), "snake_case--more----stuff")
  assert.equal(slugify("  Trim me  "), "trim-me")
  assert.equal(slugify("A.B (c)"), "ab-c")
})

test("heading text loses marks, links and emphasis", () => {
  assert.equal(headingPlainText("## Title ##"), "Title")
  assert.equal(headingPlainText("### **Bold** and `code`"), "Bold and code")
  assert.equal(headingPlainText("# [Link text](http://x) tail"), "Link text tail")
})

test("duplicate headings get -1, -2 suffixes", () => {
  const anchors = buildAnchors([{ text: "Setup", from: 0 }, { text: "Usage", from: 10 }, { text: "Setup", from: 20 }, { text: "Setup", from: 30 }])
  assert.deepEqual(anchors.map((anchor) => anchor.slug), ["setup", "usage", "setup-1", "setup-2"])
})

test("anchor lookup by slug first, then by exact heading text ignoring case", () => {
  const headings = [{ text: "Вопросы по контексту", from: 5 }, { text: "Install Guide", from: 50 }, { text: "Install Guide", from: 90 }]
  assert.equal(findAnchor(headings, "вопросы-по-контексту").from, 5)
  assert.equal(findAnchor(headings, "install-guide-1").from, 90)
  assert.equal(findAnchor(headings, "Вопросы по контексту").from, 5)
  assert.equal(findAnchor(headings, "INSTALL GUIDE").from, 50)
  assert.equal(findAnchor(headings, "missing"), null)
  assert.equal(findAnchor(headings, ""), null)
})
