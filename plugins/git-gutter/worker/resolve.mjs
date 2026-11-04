import { stat } from "node:fs/promises"
import path from "node:path"
import { isDubiousOwnership } from "./git.mjs"

const MAX_CANDIDATE_BYTES = 1024 * 1024
const MAX_CANDIDATES = 2000
const MAX_TREE_OUTPUT_BYTES = 32 * 1024 * 1024
const MAX_RESPONSE_BYTES = 700000
const MAX_BASE_BYTES = 512 * 1024
const MAX_WORKSPACES = 20
const TREE_CACHE_LIMIT = 20
const LFS_POINTER_PREFIX = "version https://git-lfs"
const UNMERGED_CODES = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"])

const treeCache = new Map()

function normalizeBranch(branch) {
  return typeof branch === "string" ? branch.replace(/^refs\/heads\//, "") : null
}

export function localWorktrees(workspaces) {
  return workspaces.filter((workspace) => workspace.kind === "worktree" && (workspace.hostId === null || workspace.hostId === "local"))
}

export function orderWorkspaces(context, local) {
  if (!context) return local
  const branch = normalizeBranch(context.branch)
  const matched = local.filter((workspace) => workspace.name === context.displayName && normalizeBranch(workspace.branch) === branch)
  const rest = local.filter((workspace) => !matched.includes(workspace))
  return [...matched, ...rest]
}

function cacheTree(key, value) {
  treeCache.set(key, value)
  if (treeCache.size > TREE_CACHE_LIMIT) treeCache.delete(treeCache.keys().next().value)
}

async function readTree(runGit, cwd, head) {
  const key = `${cwd}@${head}`
  if (treeCache.has(key)) return treeCache.get(key)
  const result = await runGit(cwd, ["ls-tree", "-r", "-z", "HEAD"], { maxBuffer: MAX_TREE_OUTPUT_BYTES })
  if (!result.ok) {
    const value = { blobIds: new Set(), tooLarge: true }
    cacheTree(key, value)
    return value
  }
  const blobIds = new Set()
  const text = result.stdout.toString("utf8")
  for (const entry of text.split("\0")) {
    if (entry === "") continue
    const tabIndex = entry.indexOf("\t")
    if (tabIndex === -1) continue
    const meta = entry.slice(0, tabIndex).split(" ")
    const blobId = meta[2]
    if (blobId) blobIds.add(blobId)
  }
  const value = { blobIds, tooLarge: false }
  cacheTree(key, value)
  return value
}

function parseStatusEntries(text) {
  const tokens = text.split("\0")
  const entries = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    index++
    if (token === "") continue
    const code = token.slice(0, 2)
    const entryPath = token.slice(3)
    let origPath = null
    if ((code[0] === "R" || code[0] === "C") && index < tokens.length) {
      origPath = tokens[index]
      index++
    }
    entries.push({ code, path: entryPath, origPath })
  }
  return entries
}

export function classifyStatus(entries) {
  const unmerged = []
  const candidates = []
  for (const entry of entries) {
    if (UNMERGED_CODES.has(entry.code)) {
      unmerged.push(entry)
      continue
    }
    if (entry.code === "??") {
      candidates.push({ ...entry, kind: "untracked" })
      continue
    }
    if (entry.code[0] === "D" || entry.code[1] === "D") continue
    if (entry.code[0] === "A") {
      candidates.push({ ...entry, kind: "added" })
      continue
    }
    if (entry.code[0] === "R" || entry.code[1] === "R") {
      candidates.push({ ...entry, kind: "renamed" })
      continue
    }
    candidates.push({ ...entry, kind: "modified" })
  }
  return { unmerged, candidates }
}

async function filterCandidates(cwd, entries) {
  const filtered = []
  for (const entry of entries) {
    if (entry.path.includes("\n")) continue
    try {
      const info = await stat(path.join(cwd, entry.path))
      if (!info.isFile() || info.size > MAX_CANDIDATE_BYTES) continue
    } catch {
      continue
    }
    filtered.push(entry)
    if (filtered.length >= MAX_CANDIDATES) break
  }
  return filtered
}

function isUnsupportedBase(buffer) {
  if (buffer.includes(0)) return "binary"
  if (buffer.byteLength > MAX_BASE_BYTES) return "base-too-large"
  const text = buffer.toString("utf8")
  if (text.startsWith(LFS_POINTER_PREFIX)) return "lfs-pointer"
  return null
}

async function loadBase(runGit, cwd, baseRef) {
  if (baseRef === null) return { status: "changed", text: "" }
  const result = await runGit(cwd, ["show", baseRef])
  if (!result.ok) return { status: "unsupported", reason: "show-failed" }
  const reason = isUnsupportedBase(result.stdout)
  if (reason) return { status: "unsupported", reason }
  const text = result.stdout.toString("utf8")
  if (Buffer.byteLength(JSON.stringify({ text }), "utf8") > MAX_RESPONSE_BYTES) {
    return { status: "unsupported", reason: "response-too-large" }
  }
  return { status: "changed", text }
}

async function resolveWorkspace(runGit, hashObjectStdinPaths, workspace, blobIds) {
  const headResult = await runGit(workspace.path, ["rev-parse", "HEAD"])
  if (!headResult.ok) {
    if (isDubiousOwnership(headResult)) return { kind: "unsupported", reason: "dubious-ownership" }
    return { kind: "none" }
  }
  const head = headResult.stdout.toString("utf8").trim()
  const tree = await readTree(runGit, workspace.path, head)
  const statusResult = await runGit(workspace.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  if (!statusResult.ok) return { kind: "none", head }
  const { unmerged, candidates } = classifyStatus(parseStatusEntries(statusResult.stdout.toString("utf8")))
  const filteredCandidates = await filterCandidates(workspace.path, candidates)
  const filteredUnmerged = await filterCandidates(workspace.path, unmerged)
  const hashed = await hashObjectStdinPaths(workspace.path, filteredCandidates.map((entry) => entry.path))
  const hashedUnmerged = await hashObjectStdinPaths(workspace.path, filteredUnmerged.map((entry) => entry.path))
  const unmergedMatch = hashedUnmerged.ok && hashedUnmerged.ids.some((id) => blobIds.includes(id))
  if (unmergedMatch) return { kind: "unsupported", reason: "conflict", head }
  const changedMatches = []
  if (hashed.ok) {
    for (let index = 0; index < filteredCandidates.length; index++) {
      const id = hashed.ids[index]
      if (!blobIds.includes(id)) continue
      const candidate = filteredCandidates[index]
      const baseRef =
        candidate.kind === "added" || candidate.kind === "untracked" ? null : `HEAD:${candidate.origPath ?? candidate.path}`
      changedMatches.push({ baseRef })
    }
  }
  const unchangedMatch = !tree.tooLarge && blobIds.some((id) => tree.blobIds.has(id))
  return { kind: "resolved", head, unchangedMatch, changedMatches, treeTooLarge: tree.tooLarge }
}

export async function resolve(runGit, hashObjectStdinPaths, input) {
  const { blobIds, workspaceId, workspaces, context } = input
  const candidateWorkspaces = workspaceId
    ? workspaces.filter((workspace) => workspace.id === workspaceId)
    : orderWorkspaces(context, localWorktrees(workspaces)).slice(0, MAX_WORKSPACES)
  const results = []
  let anyTooLarge = false
  for (const workspace of candidateWorkspaces) {
    const result = await resolveWorkspace(runGit, hashObjectStdinPaths, workspace, blobIds)
    if (result.kind === "unsupported") {
      return { status: "unsupported", reason: result.reason, workspaceId: workspace.id, head: result.head }
    }
    if (result.kind !== "resolved") continue
    if (result.treeTooLarge) anyTooLarge = true
    if (result.unchangedMatch) results.push({ workspace, kind: "unchanged", head: result.head })
    for (const match of result.changedMatches) {
      results.push({ workspace, kind: "changed", head: result.head, baseRef: match.baseRef })
    }
  }
  if (results.length === 0) {
    return { status: "unknown", reason: anyTooLarge ? "repository-too-large" : "draft-or-unfocused-workspace" }
  }
  const kinds = new Set(results.map((item) => item.kind))
  if (kinds.size > 1) return { status: "ambiguous", reason: "same-content-multiple-files" }
  if (kinds.has("unchanged")) {
    const first = results[0]
    return { status: "unchanged", workspaceId: first.workspace.id, head: first.head }
  }
  const baseRefs = new Set(results.map((item) => item.baseRef))
  if (baseRefs.size > 1) return { status: "ambiguous", reason: "same-content-multiple-files" }
  const first = results[0]
  const base = await loadBase(runGit, first.workspace.path, first.baseRef)
  if (base.status !== "changed") return { status: base.status, reason: base.reason }
  return { status: "changed", workspaceId: first.workspace.id, head: first.head, base: base.text }
}

export async function headStatus(runGit, input) {
  const { workspaceId, workspaces } = input
  const workspace = workspaces.find((item) => item.id === workspaceId)
  if (!workspace) return { status: "unsupported", reason: "unknown-workspace" }
  const result = await runGit(workspace.path, ["rev-parse", "HEAD"])
  if (!result.ok) return { status: "unsupported", reason: "head-unavailable" }
  return { status: "ok", head: result.stdout.toString("utf8").trim(), workspaceId }
}
