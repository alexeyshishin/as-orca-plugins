import { hashObjectStdinPaths, runGit } from "./git.mjs"
import { headStatus, resolve } from "./resolve.mjs"

const BLOB_ID_PATTERN = /^[0-9a-f]{40}$/

export function validateBlobIds(blobIds) {
  if (!Array.isArray(blobIds) || blobIds.length < 1 || blobIds.length > 2) return null
  if (!blobIds.every((id) => typeof id === "string" && BLOB_ID_PATTERN.test(id))) return null
  return blobIds
}

export function isLocalWorktree(workspace) {
  return workspace.kind === "worktree" && (workspace.hostId === null || workspace.hostId === "local")
}

async function validatedWorkspaceId(orca, workspaceId) {
  const listing = await orca.host.call("workspace.list", {})
  if (typeof workspaceId !== "string" || workspaceId === "") return { workspaceId: undefined, listing }
  const workspace = listing.workspaces.find((item) => item.id === workspaceId)
  return workspace && isLocalWorktree(workspace) ? { workspaceId, listing } : { workspaceId: undefined, listing }
}

const QUIET_STATUSES = new Set(["unchanged", "changed"])

function logResolveOutcome(status, reason) {
  if (QUIET_STATUSES.has(status)) return
  console.log(`gutter.resolve status=${status} reason=${reason ?? "-"}`)
}

export async function handleResolve(orca, input) {
  const blobIds = validateBlobIds(input?.blobIds)
  if (!blobIds) {
    logResolveOutcome("unsupported", "invalid-input")
    return { status: "unsupported", reason: "invalid-input" }
  }
  const { workspaceId, listing } = await validatedWorkspaceId(orca, input?.workspaceId)
  const context = await orca.host.call("workspace.readContext", {})
  const result = await resolve(runGit, hashObjectStdinPaths, {
    blobIds,
    workspaceId,
    workspaces: listing.workspaces,
    context
  })
  logResolveOutcome(result.status, result.reason)
  return result
}

export async function handleHead(orca, input) {
  const { workspaceId, listing } = await validatedWorkspaceId(orca, input?.workspaceId)
  if (!workspaceId) return { status: "unsupported", reason: "invalid-input" }
  return headStatus(runGit, { workspaceId, workspaces: listing.workspaces })
}

export default function activate(orca) {
  orca.panels.handle("gutter.resolve", (input) => handleResolve(orca, input))
  orca.panels.handle("gutter.head", (input) => handleHead(orca, input))
}
