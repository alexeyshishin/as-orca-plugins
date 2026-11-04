import { css } from "@codemirror/lang-css"
import { go } from "@codemirror/lang-go"
import { html } from "@codemirror/lang-html"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdownLanguage } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import { rust } from "@codemirror/lang-rust"
import { sql, StandardSQL } from "@codemirror/lang-sql"
import { yaml } from "@codemirror/lang-yaml"
import { StreamLanguage } from "@codemirror/language"
import { shell } from "@codemirror/legacy-modes/mode/shell"
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight"

export const MAX_HIGHLIGHT_LENGTH = 60000
const MAX_LABEL_LENGTH = 24
const CACHE_LIMIT = 64

const FACTORIES = {
  shell: () => StreamLanguage.define(shell),
  javascript: () => javascript({ jsx: true }).language,
  typescript: () => javascript({ typescript: true, jsx: true }).language,
  json: () => json().language,
  yaml: () => yaml().language,
  python: () => python().language,
  html: () => html().language,
  css: () => css().language,
  go: () => go().language,
  rust: () => rust().language,
  sql: () => sql({ dialect: StandardSQL }).language,
  markdown: () => markdownLanguage
}

const ALIASES = {
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  shell: "shell",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  javascript: "javascript",
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  python: "python",
  py: "python",
  html: "html",
  htm: "html",
  css: "css",
  go: "go",
  golang: "go",
  rust: "rust",
  rs: "rust",
  sql: "sql",
  markdown: "markdown",
  md: "markdown"
}

const highlighter = tagHighlighter([
  {
    tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.self],
    class: "cm-hl-keyword"
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character, tags.docString], class: "cm-hl-string" },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom, tags.unit], class: "cm-hl-number" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], class: "cm-hl-comment" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.function(tags.variableName)), tags.macroName, tags.standard(tags.variableName)],
    class: "cm-hl-function"
  },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.labelName, tags.special(tags.variableName), tags.local(tags.variableName)], class: "cm-hl-type" },
  { tag: [tags.propertyName, tags.attributeName, tags.definition(tags.propertyName)], class: "cm-hl-property" },
  { tag: [tags.tagName, tags.angleBracket], class: "cm-hl-tag" },
  { tag: [tags.meta, tags.processingInstruction, tags.annotation, tags.documentMeta], class: "cm-hl-meta" },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], class: "cm-hl-punct" },
  { tag: [tags.heading, tags.strong], class: "cm-hl-strong" },
  { tag: [tags.emphasis], class: "cm-hl-em" },
  { tag: [tags.link, tags.url], class: "cm-hl-link" },
  { tag: [tags.invalid], class: "cm-hl-invalid" }
])

const languages = new Map()
const cache = new Map()

export function infoWord(info) {
  return info.trim().split(/[\s{]/)[0]
}

export function languageLabel(info) {
  const word = infoWord(info)
  return word.length > MAX_LABEL_LENGTH ? `${word.slice(0, MAX_LABEL_LENGTH - 1)}…` : word
}

export function languageKey(info) {
  const alias = ALIASES[infoWord(info).toLowerCase()]
  return alias ?? null
}

function languageFor(key) {
  if (!languages.has(key)) languages.set(key, FACTORIES[key]())
  return languages.get(key)
}

function computeHighlight(key, code) {
  const tree = languageFor(key).parser.parse(code)
  const tokens = []
  highlightTree(tree, highlighter, (from, to, className) => {
    if (from < to) tokens.push({ from, to, className })
  })
  return tokens
}

export function highlightCode(key, code) {
  if (!key || !FACTORIES[key] || code.length === 0 || code.length > MAX_HIGHLIGHT_LENGTH) return []
  const cacheKey = `${key}\n${code}`
  const hit = cache.get(cacheKey)
  if (hit) return hit
  const tokens = computeHighlight(key, code)
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
  cache.set(cacheKey, tokens)
  return tokens
}
