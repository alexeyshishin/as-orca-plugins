const MAX_TARGET_LENGTH = 1024
const REQUIRED_METHODS = ["workspace.readContext", "workspace.list", "editor.open"]

function refusal(message) {
  return { ok: false, message }
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return null
  }
}

function cleanRoot(root) {
  return typeof root === "string" ? root.replace(/\\/g, "/").replace(/\/+$/, "") : ""
}

function parentOf(root) {
  return root.slice(0, root.lastIndexOf("/") + 1)
}

export function resolveTarget(raw, workspaceRoot) {
  if (typeof raw !== "string" || raw.trim() === "") return refusal("Пустая ссылка")
  if (raw.length > MAX_TARGET_LENGTH) return refusal("Ссылка слишком длинная")
  if (raw.includes("\u0000")) return refusal("Недопустимые символы в ссылке")
  let target = raw.trim()
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim()
  target = target.split("#")[0].split("?")[0]
  const decoded = safeDecode(target)
  if (decoded === null || decoded.includes("\u0000")) return refusal("Недопустимые символы в ссылке")
  let path = decoded.replace(/\\/g, "/")
  if (/^[a-z]:/i.test(path)) return refusal("Путь вне воркспейса")
  if (path.startsWith("/")) {
    const root = cleanRoot(workspaceRoot)
    if (root === "" && /^\/(Users|home)\//.test(path)) return refusal("Корень воркспейса недоступен")
    if (root !== "" && (path === root || path.startsWith(`${root}/`))) {
      path = path.slice(root.length)
    } else if (root !== "" && path.startsWith(parentOf(root)) && parentOf(root).length > 1) {
      return refusal("Путь вне воркспейса")
    }
  }
  const segments = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0) return refusal("Путь вне воркспейса")
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  if (segments.length === 0) return refusal("Ссылка указывает на корень воркспейса")
  const joined = segments.join("/")
  if (joined.length > MAX_TARGET_LENGTH) return refusal("Ссылка слишком длинная")
  return { ok: true, path: joined }
}

function normalizeBranch(branch) {
  return typeof branch === "string" ? branch.replace(/^refs\/heads\//, "") : null
}

export function pickWorkspace(context, workspaces) {
  if (!context) return null
  const branch = normalizeBranch(context.branch)
  const sameName = workspaces.filter((workspace) => workspace.name === context.displayName)
  const sameBranch = (list) => list.filter((workspace) => normalizeBranch(workspace.branch) === branch)
  for (const candidates of [sameBranch(sameName), sameName, branch ? sameBranch(workspaces) : [], workspaces.length === 1 ? workspaces : []]) {
    if (candidates.length === 1) return candidates[0]
  }
  return null
}

function hostMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export async function openLink(orca, input) {
  const target = input && typeof input === "object" ? input.target : undefined
  if (typeof target !== "string") return refusal("Пустая ссылка")
  const early = resolveTarget(target, "")
  if (!early.ok && early.message !== "Корень воркспейса недоступен") return early
  for (const method of REQUIRED_METHODS) {
    if (!orca.host.has(method)) return refusal("Эта версия Orca не умеет открывать файлы из плагина")
  }
  let context
  let listing
  try {
    context = await orca.host.call("workspace.readContext", {})
    if (!context) return refusal("Нет активного воркспейса")
    listing = await orca.host.call("workspace.list", {})
  } catch (error) {
    return refusal(`Не удалось определить воркспейс: ${hostMessage(error)}`)
  }
  const workspace = pickWorkspace(context, listing.workspaces)
  if (!workspace) return refusal("Не удалось определить воркспейс")
  const resolved = resolveTarget(target, workspace.path)
  if (!resolved.ok) return resolved
  try {
    await orca.host.call("editor.open", { workspaceId: workspace.id, path: resolved.path })
  } catch (error) {
    const hint = /\.[^/.]+$/.test(resolved.path) ? "" : " (возможно, это каталог)"
    return refusal(`Не удалось открыть ${resolved.path}${hint}: ${hostMessage(error)}`)
  }
  return { ok: true, path: resolved.path, workspace: workspace.name }
}

export default function activate(orca) {
  orca.panels.handle("link.open", (input) => openLink(orca, input))
}
