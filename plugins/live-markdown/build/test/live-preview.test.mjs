import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { ensureSyntaxTree } from "@codemirror/language"
import { EditorState, Text } from "@codemirror/state"
import { GFM, parser } from "@lezer/markdown"
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  computeEntries,
  frontMatterEnd,
  isLivePreviewEnabled,
  MAX_LIVE_LENGTH
} from "../src/live-preview.js"
import { highlightCode, languageKey, languageLabel, MAX_HIGHLIGHT_LENGTH } from "../src/code-highlight.js"

const gfmParser = parser.configure(GFM)

function analyze(source, selections, options = {}) {
  const doc = Text.of(source.split("\n"))
  const tree = gfmParser.parse(source)
  const ranges = selections.map((selection) =>
    typeof selection === "number" ? { from: selection, to: selection } : selection
  )
  const visibleRanges = options.visibleRanges ?? [{ from: 0, to: doc.length }]
  const entries = computeEntries({ tree, doc, ranges, visibleRanges, composing: options.composing })
  return { doc, entries }
}

function describe(doc, entries, kind, limit = Infinity) {
  return entries
    .filter((entry) => entry.kind === kind && entry.from < limit)
    .map((entry) =>
      kind === "line" ? entry.className : `${doc.sliceString(entry.from, entry.to)}@${entry.from}`
    )
    .sort()
}

const HEADING = "#### **Вопросы по контексту**"
const SCREENSHOT_DOC = `${HEADING}\n\n1. Первый шаг: \`--control-plane-endpoint\` задан\n2. Второй шаг\n\nОбычный абзац`

const END = HEADING.length + 1

test("active heading line: marks dimmed, heading class always present", () => {
  const { doc, entries } = analyze(SCREENSHOT_DOC, [10])
  assert.deepEqual(describe(doc, entries, "line", END), ["cm-live-h4"])
  assert.deepEqual(describe(doc, entries, "hide", END), [])
  assert.deepEqual(describe(doc, entries, "dim", END), ["#### @0", "**@27", "**@5"])
  assert.deepEqual(describe(doc, entries, "style", END), [`${HEADING.slice(5)}@5`])
})

test("inactive heading line: heading mark with its space and bold marks hidden", () => {
  const { doc, entries } = analyze(SCREENSHOT_DOC, [SCREENSHOT_DOC.length])
  assert.deepEqual(describe(doc, entries, "line", END), ["cm-live-h4"])
  assert.deepEqual(describe(doc, entries, "hide", END), ["#### @0", "**@27", "**@5"])
  assert.deepEqual(describe(doc, entries, "dim", END), [])
})

test("cursor on heading line but outside bold: heading mark dimmed, bold marks hidden", () => {
  const { doc, entries } = analyze(SCREENSHOT_DOC, [0])
  assert.deepEqual(describe(doc, entries, "dim", END), ["#### @0"])
  assert.deepEqual(describe(doc, entries, "hide", END), ["**@27", "**@5"])
})

test("cursor adjacent to the closing bold mark reveals it", () => {
  const { doc, entries } = analyze(SCREENSHOT_DOC, [HEADING.length])
  assert.deepEqual(describe(doc, entries, "hide", END), [])
  assert.deepEqual(describe(doc, entries, "dim", END), ["#### @0", "**@27", "**@5"])
})

test("heading size classes follow the level h1..h6", () => {
  for (let level = 1; level <= 6; level++) {
    const source = `${"#".repeat(level)} Title\n\nbody`
    const { doc, entries } = analyze(source, [source.length])
    assert.deepEqual(describe(doc, entries, "line"), [`cm-live-h${level}`])
    assert.deepEqual(describe(doc, entries, "hide"), [`${"#".repeat(level)} @0`])
  }
})

test("closing hashes of an ATX heading are hidden together with the space before them", () => {
  const source = "## Title ##\n\nbody"
  const inactive = analyze(source, [source.length])
  assert.deepEqual(describe(inactive.doc, inactive.entries, "hide"), [" ##@8", "## @0"])
  const active = analyze(source, [3])
  assert.deepEqual(describe(active.doc, active.entries, "hide"), [])
  assert.deepEqual(describe(active.doc, active.entries, "dim"), [" ##@8", "## @0"])
})

test("ordered list marks stay dimmed on every line, never hidden", () => {
  const onList = analyze(SCREENSHOT_DOC, [SCREENSHOT_DOC.indexOf("1.") + 4])
  const elsewhere = analyze(SCREENSHOT_DOC, [SCREENSHOT_DOC.length])
  for (const { doc, entries } of [onList, elsewhere]) {
    const dimmed = describe(doc, entries, "dim")
    assert.ok(dimmed.some((item) => item.startsWith("1.@")))
    assert.ok(dimmed.some((item) => item.startsWith("2.@")))
    assert.ok(!describe(doc, entries, "hide").some((item) => /^\d\./.test(item)))
  }
})

test("inline code: pill style over the node, backticks hidden outside and dimmed inside", () => {
  const codeStart = SCREENSHOT_DOC.indexOf("`")
  const code = "`--control-plane-endpoint`"
  const outside = analyze(SCREENSHOT_DOC, [SCREENSHOT_DOC.length])
  assert.ok(describe(outside.doc, outside.entries, "style").includes(`${code}@${codeStart}`))
  assert.deepEqual(
    describe(outside.doc, outside.entries, "hide").filter((item) => item.startsWith("`")),
    [`\`@${codeStart}`, `\`@${codeStart + code.length - 1}`]
  )
  const inside = analyze(SCREENSHOT_DOC, [codeStart + 5])
  assert.deepEqual(
    describe(inside.doc, inside.entries, "hide").filter((item) => item.startsWith("`")),
    []
  )
  assert.ok(describe(inside.doc, inside.entries, "dim").includes(`\`@${codeStart}`))
  assert.ok(!describe(inside.doc, inside.entries, "hide").some((item) => item.includes("control-plane")))
})

test("strikethrough, emphasis and nested emphasis hide outside and dim inside", () => {
  const source = "~~gone~~ and *it* and ***both***\n\nend"
  const outside = analyze(source, [source.length])
  assert.deepEqual(
    describe(outside.doc, outside.entries, "style"),
    ["**both**@23", "***both***@22", "*it*@13", "~~gone~~@0"].sort()
  )
  const hidden = describe(outside.doc, outside.entries, "hide")
  assert.ok(hidden.includes("~~@0") && hidden.includes("~~@6") && hidden.includes("*@13") && hidden.includes("*@16"))
  const insideStrike = analyze(source, [3])
  assert.deepEqual(describe(insideStrike.doc, insideStrike.entries, "dim"), ["~~@0", "~~@6"])
  assert.ok(!describe(insideStrike.doc, insideStrike.entries, "hide").some((item) => item.startsWith("~~")))
})

test("blockquote mark is dimmed and not hidden", () => {
  const source = "> quoted\n\nend"
  const { doc, entries } = analyze(source, [source.length])
  assert.deepEqual(describe(doc, entries, "dim"), [">@0"])
  assert.deepEqual(describe(doc, entries, "hide"), [])
})

test("fenced code away from the cursor: fences hidden, the language label replaces the opening fence", () => {
  const source = "```js\nconst a = 1\n```\n\nend"
  const { doc, entries } = analyze(source, [source.length])
  const lines = describe(doc, entries, "line")
  assert.equal(lines.filter((name) => name === "cm-live-codeblock").length, 3)
  assert.deepEqual(lines.filter((name) => name !== "cm-live-codeblock").sort(), ["cm-live-codeblock-first", "cm-live-codeblock-last"])
  assert.deepEqual(describe(doc, entries, "hide"), ["```@18"])
  assert.deepEqual(entries.filter((entry) => entry.kind === "label"), [{ kind: "label", from: 0, to: 5, text: "js" }])
  assert.deepEqual(describe(doc, entries, "dim"), [])
})

test("fenced code with the cursor inside or on a fence: fences visible and dimmed", () => {
  const source = "```js\nconst a = 1\n```\n\nend"
  for (const cursor of [0, 3, 8, 14, 18, 21]) {
    const { doc, entries } = analyze(source, [cursor])
    assert.deepEqual(describe(doc, entries, "hide"), [], `cursor ${cursor}`)
    assert.deepEqual(entries.filter((entry) => entry.kind === "label"), [], `cursor ${cursor}`)
    assert.ok(describe(doc, entries, "dim").includes("```@0"), `cursor ${cursor}`)
    assert.ok(describe(doc, entries, "dim").includes("js@3"), `cursor ${cursor}`)
  }
})

test("tilde fences behave like backtick fences", () => {
  const source = "~~~python\nx = 1\n~~~\n\nend"
  const away = analyze(source, [source.length])
  assert.deepEqual(entries(away).filter((entry) => entry.kind === "label").map((entry) => entry.text), ["python"])
  assert.deepEqual(describe(away.doc, away.entries, "hide"), ["~~~@16"])
  const inside = analyze(source, [12])
  assert.deepEqual(describe(inside.doc, inside.entries, "hide"), [])
  assert.ok(describe(inside.doc, inside.entries, "dim").includes("~~~@0"))
})

test("a fence without a language is hidden without a label, an unclosed fence hides only its opening", () => {
  const bare = "```\ncode\n```\n\nend"
  const bareResult = analyze(bare, [bare.length])
  assert.deepEqual(describe(bareResult.doc, bareResult.entries, "hide"), ["```@0", "```@9"])
  assert.deepEqual(bareResult.entries.filter((entry) => entry.kind === "label"), [])
  const open = "text\n\n```sh\nls\n"
  const openResult = analyze(open, [0])
  assert.deepEqual(openResult.entries.filter((entry) => entry.kind === "label").map((entry) => entry.text), ["sh"])
  assert.deepEqual(describe(openResult.doc, openResult.entries, "hide"), [])
})

test("composition keeps the fences visible", () => {
  const source = "```js\nx\n```\n\nend"
  const { doc, entries } = analyze(source, [source.length], { composing: true })
  assert.deepEqual(describe(doc, entries, "hide"), [])
  assert.deepEqual(entries.filter((entry) => entry.kind === "label"), [])
  assert.ok(describe(doc, entries, "dim").includes("```@0"))
})

test("highlighting maps tokens onto document offsets for known languages only", () => {
  const source = "intro\n\n```js\nconst a = 1\n```\n\n```weird\nconst b = 2\n```\n"
  const { doc, entries } = analyze(source, [0])
  const styles = entries.filter((entry) => entry.kind === "style" && entry.className.startsWith("cm-hl-"))
  const words = styles.map((entry) => `${doc.sliceString(entry.from, entry.to)}:${entry.className}`)
  assert.ok(words.includes("const:cm-hl-keyword"))
  assert.ok(words.includes("1:cm-hl-number"))
  assert.ok(styles.every((entry) => entry.from < source.indexOf("weird")))
  const labels = entries.filter((entry) => entry.kind === "label").map((entry) => entry.text)
  assert.deepEqual(labels, ["js", "weird"])
})

test("highlighting inside a blockquote stitches the separate code lines together", () => {
  const source = "> ```js\n> const s = `a\n> b`\n> ```\n\nend"
  const { doc, entries } = analyze(source, [source.length])
  const styles = entries.filter((entry) => entry.kind === "style" && entry.className.startsWith("cm-hl-"))
  const strings = styles.filter((entry) => entry.className === "cm-hl-string").map((entry) => doc.sliceString(entry.from, entry.to))
  assert.deepEqual(strings, ["`a", "b`"])
  for (const entry of styles) assert.equal(doc.lineAt(entry.from).number, doc.lineAt(entry.to).number)
})

test("code language labels and keys come from the first word of the info string", () => {
  assert.equal(languageLabel("js"), "js")
  assert.equal(languageLabel("  python title=x"), "python")
  assert.equal(languageLabel("{r}"), "")
  assert.equal(languageLabel("rust{1,3}"), "rust")
  assert.equal(languageLabel("x".repeat(40)).length, 24)
  assert.equal(languageKey("JS"), "javascript")
  assert.equal(languageKey("tsx"), "typescript")
  assert.equal(languageKey("zsh"), "shell")
  assert.equal(languageKey("yml"), "yaml")
  assert.equal(languageKey("golang"), "go")
  assert.equal(languageKey("weird"), null)
  assert.equal(languageKey(""), null)
})

test("highlighting covers sh, js, ts, json, yaml, python, html, css, go, rust, sql and markdown", () => {
  const samples = {
    shell: 'echo "hi" | grep x # c',
    javascript: "const a = 1 // c",
    typescript: "interface A { x: number }",
    json: '{"a": [1, true]}',
    yaml: "a: 1\nb:\n  - x",
    python: "def f(x):\n  return 1",
    html: '<div class="a">x</div>',
    css: "a { color: red }",
    go: "func main() {}",
    rust: "fn main() { let x = 1; }",
    sql: "SELECT a FROM t",
    markdown: "# H\n**b**"
  }
  for (const [key, code] of Object.entries(samples)) {
    const tokens = highlightCode(key, code)
    assert.ok(tokens.length > 0, key)
    assert.ok(tokens.every((token) => token.from < token.to && token.to <= code.length), key)
  }
  assert.deepEqual(highlightCode("weird", "x"), [])
  assert.deepEqual(highlightCode("javascript", "x".repeat(MAX_HIGHLIGHT_LENGTH + 1)), [])
})

const bulletOf = (entries) => entries.filter((entry) => entry.kind === "style" && entry.className === "cm-live-bullet")

test("bullet markers - * + become dots while the cursor is away", () => {
  const source = "- one\n* two\n+ three\n\nend"
  const { doc, entries } = analyze(source, [source.length])
  assert.deepEqual(bulletOf(entries).map((entry) => doc.sliceString(entry.from, entry.to)), ["-", "*", "+"])
  assert.deepEqual(describe(doc, entries, "hide"), [])
  assert.deepEqual(describe(doc, entries, "dim"), [])
})

test("nested bullets each get their own dot, ordered markers stay dimmed", () => {
  const source = "- a\n  - b\n    * c\n\n1. x\n2) y\n\nend"
  const { doc, entries } = analyze(source, [source.length])
  assert.deepEqual(bulletOf(entries).map((entry) => entry.from), [0, 6, 14])
  const dimmed = describe(doc, entries, "dim")
  assert.ok(dimmed.some((item) => item.startsWith("1.@")))
  assert.ok(dimmed.some((item) => item.startsWith("2)@")))
})

test("a bullet marker touched by the cursor or a selection shows the raw dimmed marker", () => {
  const source = "- one\n- two\n\nend"
  const onMarker = analyze(source, [0])
  assert.deepEqual(bulletOf(onMarker.entries).map((entry) => entry.from), [6])
  assert.ok(describe(onMarker.doc, onMarker.entries, "dim").includes("-@0"))
  const afterMarker = analyze(source, [1])
  assert.deepEqual(bulletOf(afterMarker.entries).map((entry) => entry.from), [6])
  const inText = analyze(source, [4])
  assert.deepEqual(bulletOf(inText.entries).map((entry) => entry.from), [0, 6])
  const insideText = analyze(source, [{ from: 2, to: 4 }])
  assert.deepEqual(bulletOf(insideText.entries).map((entry) => entry.from), [0, 6])
  const covering = analyze(source, [{ from: 0, to: 3 }])
  assert.deepEqual(bulletOf(covering.entries).map((entry) => entry.from), [6])
})

test("dashes that are not list markers are untouched", () => {
  const source = "text - with dash\n\n---\n\nTitle\n---\n\n-not a list\n"
  const { entries } = analyze(source, [0])
  assert.deepEqual(bulletOf(entries), [])
})

const entries = (result) => result.entries
test("setext heading: text lines sized, underline dimmed and never hidden", () => {
  const source = "Заголовок\n=========\n\nтекст"
  const { doc, entries } = analyze(source, [source.length])
  assert.deepEqual(describe(doc, entries, "line"), ["cm-live-h1"])
  assert.deepEqual(describe(doc, entries, "hide"), [])
  assert.deepEqual(describe(doc, entries, "dim"), ["=========@10"])
})

test("Cyrillic and astral characters keep offsets aligned with the document", () => {
  const source = "## Привет 🎉 **мир**\n\nконец"
  const { doc, entries } = analyze(source, [source.length])
  const hidden = describe(doc, entries, "hide")
  assert.deepEqual(hidden, ["## @0", `**@${source.indexOf("**")}`, `**@${source.lastIndexOf("**")}`].sort())
  for (const entry of entries.filter((item) => item.kind === "hide")) {
    assert.ok(["## ", "**"].includes(doc.sliceString(entry.from, entry.to)))
  }
})

test("empty document and whitespace-only document produce nothing", () => {
  assert.deepEqual(analyze("", [0]).entries, [])
  assert.deepEqual(analyze("   \n\n", [0]).entries, [])
})

test("multiple cursors reveal every touched line", () => {
  const source = "# One **a**\n\n# Two **b**\n\n# Three **c**"
  const secondLine = source.indexOf("# Two")
  const thirdLine = source.indexOf("# Three")
  const { doc, entries } = analyze(source, [secondLine + 2, thirdLine + 2])
  const hidden = describe(doc, entries, "hide")
  assert.ok(hidden.includes("# @0"))
  assert.ok(!hidden.includes(`# @${secondLine}`))
  assert.ok(!hidden.includes(`# @${thirdLine}`))
  const dimmed = describe(doc, entries, "dim")
  assert.ok(dimmed.includes(`# @${secondLine}`) && dimmed.includes(`# @${thirdLine}`))
})

const hiddenWords = (doc, entries) => describe(doc, entries, "hide")
const dimmedWords = (doc, entries) => describe(doc, entries, "dim")

test("inline markers are revealed by node: a cursor in the middle of one node opens only that node", () => {
  const source = "a **b** c *d*\n\nend"
  const inBold = analyze(source, [4])
  assert.deepEqual(dimmedWords(inBold.doc, inBold.entries), ["**@2", "**@5"])
  assert.deepEqual(hiddenWords(inBold.doc, inBold.entries), ["*@10", "*@12"])
  const inItalic = analyze(source, [11])
  assert.deepEqual(dimmedWords(inItalic.doc, inItalic.entries), ["*@10", "*@12"])
  assert.deepEqual(hiddenWords(inItalic.doc, inItalic.entries), ["**@2", "**@5"])
  const between = analyze(source, [8])
  assert.deepEqual(dimmedWords(between.doc, between.entries), [])
  assert.equal(hiddenWords(between.doc, between.entries).length, 4)
})

test("a selection across two nodes opens both and only them", () => {
  const source = "**a** x *b* y ~~c~~ z `d`\n\nend"
  const { doc, entries } = analyze(source, [{ from: 3, to: 9 }])
  assert.deepEqual(dimmedWords(doc, entries), ["*@10", "*@8", "**@0", "**@3"].sort())
  assert.deepEqual(hiddenWords(doc, entries), ["`@22", "`@24", "~~@14", "~~@17"].sort())
})

test("a selection spanning lines opens only the nodes it intersects, not the whole lines", () => {
  const source = "**a** x\n**b** y\n**c** z\n\nend"
  const { doc, entries } = analyze(source, [{ from: 6, to: 20 }])
  assert.deepEqual(dimmedWords(doc, entries), ["**@16", "**@19", "**@8", "**@11"].sort())
  assert.deepEqual(hiddenWords(doc, entries), ["**@0", "**@3"].sort())
})

test("several cursors open one node each", () => {
  const source = "**a** x *b* y ~~c~~\n\nend"
  const { doc, entries } = analyze(source, [2, 17])
  assert.deepEqual(dimmedWords(doc, entries), ["**@0", "**@3", "~~@14", "~~@17"].sort())
  assert.deepEqual(hiddenWords(doc, entries), ["*@10", "*@8"].sort())
})

test("nested nodes: a cursor in the inner node opens the whole ancestor chain, siblings stay hidden", () => {
  const source = "**a *b* c** and *d*\n\nend"
  const { doc, entries } = analyze(source, [6])
  assert.deepEqual(dimmedWords(doc, entries), ["*@4", "*@6", "**@0", "**@9"].sort())
  assert.deepEqual(hiddenWords(doc, entries), ["*@16", "*@18"].sort())
  const outerOnly = analyze(source, [1])
  assert.deepEqual(dimmedWords(outerOnly.doc, outerOnly.entries), ["**@0", "**@9"])
})

test("block markers stay line based while inline markers are node based", () => {
  const source = "## Head **b** x *i*\n\nend"
  const { doc, entries } = analyze(source, [4])
  assert.deepEqual(dimmedWords(doc, entries), ["## @0"])
  assert.equal(hiddenWords(doc, entries).length, 4)
})

const checkboxes = (entries) => entries.filter((entry) => entry.kind === "checkbox")

test("task items become checkboxes replacing the bullet and the marker", () => {
  for (const bullet of ["-", "*", "+"]) {
    const source = `${bullet} [ ] todo\n${bullet} [x] done\n${bullet} [X] big\n\nend`
    const { doc, entries } = analyze(source, [source.length])
    assert.deepEqual(checkboxes(entries).map((entry) => [entry.from, entry.to, entry.checked, entry.offset]), [
      [0, 5, false, 3],
      [11, 16, true, 3],
      [22, 27, true, 3]
    ])
    assert.equal(doc.sliceString(0, 5), `${bullet} [ ]`)
    assert.deepEqual(bulletOf(entries), [])
    assert.deepEqual(describe(doc, entries, "dim"), [])
  }
})

test("a checked task strikes its text, an unchecked one does not", () => {
  const source = "- [x] done text\n- [ ] open text\n\nend"
  const { doc, entries } = analyze(source, [source.length])
  const done = entries.filter((entry) => entry.kind === "style" && entry.className === "cm-live-task-done")
  assert.deepEqual(done.map((entry) => doc.sliceString(entry.from, entry.to)), [" done text"])
})

test("nested tasks and tasks in numbered lists", () => {
  const source = "- [ ] a\n  - [x] b\n\n1. [ ] n\n2. [x] m\n\nend"
  const { doc, entries } = analyze(source, [source.length])
  assert.deepEqual(checkboxes(entries).map((entry) => doc.sliceString(entry.from, entry.to)), ["- [ ]", "- [x]", "[ ]", "[x]"])
  const dimmed = describe(doc, entries, "dim")
  assert.ok(dimmed.some((item) => item.startsWith("1.@")) && dimmed.some((item) => item.startsWith("2.@")))
  assert.deepEqual(bulletOf(entries), [])
})

test("cursor or selection on the task marker shows the raw dimmed marker and bullet", () => {
  const source = "- [ ] todo\n- [x] done\n\nend"
  for (const cursor of [0, 1, 2, 3, 5]) {
    const { doc, entries } = analyze(source, [cursor])
    assert.deepEqual(checkboxes(entries).map((entry) => entry.from), [11], `cursor ${cursor}`)
    assert.ok(describe(doc, entries, "dim").includes("-@0") && describe(doc, entries, "dim").includes("[ ]@2"), `cursor ${cursor}`)
  }
  const inText = analyze(source, [8])
  assert.deepEqual(checkboxes(inText.entries).map((entry) => entry.from), [0, 11])
  const selected = analyze(source, [{ from: 1, to: 9 }])
  assert.deepEqual(checkboxes(selected.entries).map((entry) => entry.from), [11])
})

test("brackets outside a list or inside code are not tasks", () => {
  const source = "[ ] plain\n\n```\n- [ ] in code\n```\n\n> - [ ] quoted\n\n| a |\n|---|\n| [ ] |\n\nend"
  const { entries } = analyze(source, [source.length])
  assert.deepEqual(checkboxes(entries).map((entry) => entry.from), [source.indexOf("- [ ] quoted")])
})

test("composition keeps the task marker visible", () => {
  const source = "- [ ] todo\n\nend"
  const { doc, entries } = analyze(source, [source.length], { composing: true })
  assert.deepEqual(checkboxes(entries), [])
  assert.ok(describe(doc, entries, "dim").includes("[ ]@2"))
})

test("composition downgrades hidden markers to dimmed", () => {
  const { doc, entries } = analyze(SCREENSHOT_DOC, [SCREENSHOT_DOC.length], { composing: true })
  assert.deepEqual(describe(doc, entries, "hide"), [])
  assert.ok(describe(doc, entries, "dim").includes("#### @0"))
})

test("hidden ranges never cross a line break", () => {
  const sources = [SCREENSHOT_DOC, "## T ##\n\n**a\nb** *c\nd*\n\n~~x\ny~~", "`a\nb` text\n\nend"]
  for (const source of sources) {
    const { doc, entries } = analyze(source, [source.length])
    for (const entry of entries.filter((item) => item.kind === "hide")) {
      assert.equal(doc.lineAt(entry.from).number, doc.lineAt(entry.to).number, doc.sliceString(entry.from, entry.to))
    }
  }
})

test("front matter is skipped and dimmed, the heading after it is still decorated", () => {
  const source = "---\ntitle: x\n---\n# Heading\n\ntext"
  assert.equal(frontMatterEnd(Text.of(source.split("\n"))), 16)
  const { doc, entries } = analyze(source, [source.length])
  assert.deepEqual(describe(doc, entries, "line").sort(), ["cm-live-frontmatter", "cm-live-frontmatter", "cm-live-frontmatter", "cm-live-h1"])
  assert.deepEqual(describe(doc, entries, "hide"), ["# @17"])
})

test("front matter needs a closing delimiter", () => {
  assert.equal(frontMatterEnd(Text.of("---\ntitle: x\nno end".split("\n"))), 0)
  assert.equal(frontMatterEnd(Text.of(["text", "---", "x", "---"])), 0)
})

test("5k-line document: entries only for the visible range and fast", () => {
  const lines = []
  for (let index = 0; index < 5000; index++) {
    lines.push(index % 10 === 0 ? `## Раздел ${index} **жирный**` : `- пункт ${index} со \`кодом\` и *курсивом*`)
  }
  const source = lines.join("\n")
  const doc = Text.of(source.split("\n"))
  const tree = gfmParser.parse(source)
  const from = doc.line(2001).from
  const to = doc.line(2060).to
  const started = performance.now()
  const entries = computeEntries({ tree, doc, ranges: [{ from, to: from }], visibleRanges: [{ from, to }] })
  const elapsed = performance.now() - started
  console.log(`# 5k-line doc, 60 visible lines: ${entries.length} entries in ${elapsed.toFixed(2)} ms`)
  const full = computeEntries({ tree, doc, ranges: [{ from: 0, to: 0 }], visibleRanges: [{ from: 0, to: doc.length }] })
  assert.ok(entries.length > 0)
  assert.ok(entries.length < full.length / 20)
  for (const entry of entries) {
    assert.ok(entry.from >= from - 1 && entry.from <= to, `entry outside viewport at ${entry.from}`)
  }
  assert.ok(elapsed < 250, `took ${elapsed} ms`)
})

test("size threshold disables live preview above the limit", () => {
  assert.equal(isLivePreviewEnabled(0), true)
  assert.equal(isLivePreviewEnabled(MAX_LIVE_LENGTH), true)
  assert.equal(isLivePreviewEnabled(MAX_LIVE_LENGTH + 1), false)
})

test("the real markdown() language produces the same entries as the bare GFM parser", () => {
  const state = EditorState.create({ doc: SCREENSHOT_DOC, extensions: [markdown({ base: markdownLanguage })] })
  const tree = ensureSyntaxTree(state, state.doc.length, 5000)
  assert.ok(tree)
  const ranges = [{ from: 10, to: 10 }]
  const visibleRanges = [{ from: 0, to: state.doc.length }]
  const viaLanguage = computeEntries({ tree, doc: state.doc, ranges, visibleRanges })
  const viaParser = analyze(SCREENSHOT_DOC, [10]).entries
  assert.deepEqual(viaLanguage, viaParser)
})

test("horizontal rule away from the cursor: line flagged and the marker hidden", () => {
  for (const marker of ["---", "***", "___", "* * *"]) {
    const source = `text\n\n${marker}\n\nmore`
    const { doc, entries } = analyze(source, [source.length])
    assert.deepEqual(describe(doc, entries, "line"), ["cm-live-hr"], marker)
    assert.deepEqual(describe(doc, entries, "hide"), [`${marker}@6`], marker)
    assert.deepEqual(describe(doc, entries, "dim"), [], marker)
  }
})

test("horizontal rule under the cursor shows the raw marker dimmed and no rule", () => {
  const source = "text\n\n---\n\nmore"
  for (const cursor of [6, 7, 9]) {
    const { doc, entries } = analyze(source, [cursor])
    assert.deepEqual(describe(doc, entries, "line"), [])
    assert.deepEqual(describe(doc, entries, "hide"), [])
    assert.deepEqual(describe(doc, entries, "dim"), ["---@6"])
  }
})

test("horizontal rule revealed by a selection that merely crosses its line", () => {
  const source = "text\n\n---\n\nmore"
  const { doc, entries } = analyze(source, [{ from: 0, to: source.length }])
  assert.deepEqual(describe(doc, entries, "hide"), [])
  assert.deepEqual(describe(doc, entries, "dim"), ["---@6"])
})

test("horizontal rule next to front matter: only the real rule is decorated", () => {
  const source = "---\ntitle: x\n---\n\n---\n\ntext"
  const { doc, entries } = analyze(source, [source.length])
  assert.deepEqual(describe(doc, entries, "line"), ["cm-live-frontmatter", "cm-live-frontmatter", "cm-live-frontmatter", "cm-live-hr"])
  assert.deepEqual(describe(doc, entries, "hide"), [`---@${source.lastIndexOf("---")}`])
})

test("a setext underline is not a horizontal rule", () => {
  const source = "Title\n---\n\ntext"
  const { doc, entries } = analyze(source, [source.length])
  assert.deepEqual(describe(doc, entries, "line"), ["cm-live-h2"])
  assert.deepEqual(describe(doc, entries, "hide"), [])
  assert.deepEqual(describe(doc, entries, "dim"), ["---@6"])
})

test("a rule inside a fenced code block or a blockquote is left alone", () => {
  const fenced = "```\n---\n```\n\nend"
  const inFence = analyze(fenced, [5])
  assert.deepEqual(describe(inFence.doc, inFence.entries, "hide"), [])
  assert.ok(!describe(inFence.doc, inFence.entries, "line").includes("cm-live-hr"))
  const quoted = "> ---\n\nend"
  const inQuote = analyze(quoted, [quoted.length])
  assert.deepEqual(describe(inQuote.doc, inQuote.entries, "hide"), [])
  assert.deepEqual(describe(inQuote.doc, inQuote.entries, "line"), [])
  assert.ok(describe(inQuote.doc, inQuote.entries, "dim").includes("---@2"))
})

test("composition keeps the rule marker visible", () => {
  const source = "text\n\n---\n\nmore"
  const { doc, entries } = analyze(source, [source.length], { composing: true })
  assert.deepEqual(describe(doc, entries, "hide"), [])
  assert.deepEqual(describe(doc, entries, "line"), [])
  assert.deepEqual(describe(doc, entries, "dim"), ["---@6"])
})

const linksOf = (entries) => entries.filter((entry) => entry.kind === "link")

test("a link hides its syntax away from the cursor and keeps the text styled as a link", () => {
  const source = "see [the docs](https://a.b/c \"T\") now\n\nend"
  const { doc, entries } = analyze(source, [source.length])
  assert.deepEqual(linksOf(entries).map((entry) => [doc.sliceString(entry.from, entry.to), entry.target, entry.title]), [["the docs", "https://a.b/c", "T"]])
  assert.deepEqual(describe(doc, entries, "hide"), ["[@4", "](https://a.b/c \"T\")@13"])
  assert.deepEqual(describe(doc, entries, "dim"), [])
})

test("a link reveals its syntax dimmed only when the cursor touches it", () => {
  const source = "see [the docs](https://a.b/c) now and *it*\n\nend"
  for (const cursor of [4, 8, 14, 29]) {
    const { doc, entries } = analyze(source, [cursor])
    assert.deepEqual(describe(doc, entries, "dim"), ["](https://a.b/c)@13", "[@4"].sort(), `cursor ${cursor}`)
    assert.equal(linksOf(entries).length, 1)
  }
  const away = analyze(source, [35])
  assert.equal(describe(away.doc, away.entries, "hide").length, 4)
  const elsewhere = analyze(source, [31])
  assert.equal(describe(elsewhere.doc, elsewhere.entries, "dim").length, 0)
})

test("autolinks hide their brackets, bare URLs are links without hidden syntax", () => {
  const source = "<https://a.b> and https://c.d/x and www.e.f and mail@g.h\n\nend"
  const { doc, entries } = analyze(source, [source.length])
  assert.deepEqual(linksOf(entries).map((entry) => entry.target), ["https://a.b", "https://c.d/x", "https://www.e.f", "mailto:mail@g.h"])
  assert.deepEqual(describe(doc, entries, "hide"), ["<@0", ">@12"])
  const touched = analyze(source, [5])
  assert.deepEqual(describe(touched.doc, touched.entries, "dim"), ["<@0", ">@12"])
})

test("links work in headings, lists and next to formatting inside the label", () => {
  const source = "## Go [**bold** link](#top)\n\n- item [x](y.md)\n\nend"
  const { doc, entries } = analyze(source, [source.length])
  assert.deepEqual(linksOf(entries).map((entry) => entry.target), ["#top", "y.md"])
  assert.ok(describe(doc, entries, "style").some((item) => item.startsWith("**bold**")))
})

test("images, reference links and link definitions are left alone", () => {
  const source = "![alt](img.png) and [t][ref]\n\n[ref]: http://x.y\n\nend"
  const { entries } = analyze(source, [source.length])
  assert.deepEqual(linksOf(entries), [])
})

test("angle-bracket destinations with spaces keep the unwrapped target", () => {
  const source = "[sp](<a b/c.md>)\n\nend"
  assert.deepEqual(linksOf(analyze(source, [source.length]).entries).map((entry) => entry.target), ["a b/c.md"])
})

test("a link whose syntax spans lines is dimmed, never hidden", () => {
  const source = "[a](b \"multi\nline\") x\n\nend"
  const { doc, entries } = analyze(source, [source.length])
  assert.deepEqual(describe(doc, entries, "hide").filter((item) => item.includes("\n")), [])
})

test("links inside a raw table keep their syntax visible and dimmed", () => {
  const source = "| a |\n|---|\n| [x](y.md) |\n\n"
  const { doc, entries } = analyze(source, [2])
  assert.deepEqual(linksOf(entries).map((entry) => entry.target), ["y.md"])
  assert.deepEqual(describe(doc, entries, "hide"), [])
})
