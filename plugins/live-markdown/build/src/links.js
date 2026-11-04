const EXTERNAL_SCHEMES = new Set(["http", "https", "mailto"])
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/
const UNSAFE_URL = /[\u0000- \u007f]/
const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/

export function unwrapTarget(raw) {
  const trimmed = raw.trim()
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed
}

export function bareTarget(text) {
  if (/^www\./i.test(text)) return `https://${text}`
  if (EMAIL.test(text)) return `mailto:${text}`
  return text
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

export function classifyTarget(raw) {
  if (typeof raw !== "string") return { kind: "empty" }
  const target = unwrapTarget(raw)
  if (target === "") return { kind: "empty" }
  if (target.startsWith("#")) return { kind: "anchor", fragment: safeDecode(target.slice(1)) }
  if (target.startsWith("//")) return { kind: "blocked" }
  const scheme = SCHEME.exec(target)
  if (scheme) {
    if (!EXTERNAL_SCHEMES.has(scheme[1].toLowerCase()) || UNSAFE_URL.test(target)) return { kind: "blocked" }
    return { kind: "external", url: target }
  }
  return { kind: "file", target }
}

export function headingPlainText(raw) {
  return raw
    .replace(/^\s{0,3}#{1,6}[ \t]*/, "")
    .replace(/[ \t]+#+[ \t]*$/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*~]/g, "")
    .trim()
}

export function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-")
}

export function buildAnchors(headings) {
  const seen = new Map()
  return headings.map((heading) => {
    const base = slugify(heading.text)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return { ...heading, slug: count === 0 ? base : `${base}-${count}` }
  })
}

export function findAnchor(headings, fragment) {
  const wanted = fragment.trim().toLowerCase()
  if (wanted === "") return null
  const anchors = buildAnchors(headings)
  return (
    anchors.find((anchor) => anchor.slug === wanted) ??
    anchors.find((anchor) => anchor.text.toLowerCase() === wanted) ??
    null
  )
}

export function linkTooltip(target, title) {
  return `${title ? `${title}\n` : ""}${target}\n\u2318/Ctrl+\u043a\u043b\u0438\u043a \u2014 \u043e\u0442\u043a\u0440\u044b\u0442\u044c`
}
