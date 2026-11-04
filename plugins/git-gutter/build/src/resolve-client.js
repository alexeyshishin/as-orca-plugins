const TIMEOUT_MS = 5000

function requestWorker(name, input) {
  if (orca.plugin?.request) return orca.plugin.request(name, input, { timeoutMs: TIMEOUT_MS })
  return orca.host.call("plugin.request", { name, input, timeoutMs: TIMEOUT_MS }).then((answer) => answer.output)
}

export function resolveGutter(blobIds, workspaceId) {
  return requestWorker("gutter.resolve", workspaceId ? { blobIds, workspaceId } : { blobIds })
}

export function gutterHead(workspaceId) {
  return requestWorker("gutter.head", { workspaceId })
}
