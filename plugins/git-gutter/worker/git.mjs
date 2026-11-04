import { execFile, spawn } from "node:child_process"

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_MAX_BUFFER = 33 * 1024 * 1024
const FORBIDDEN_ARGS = ["diff", "--textconv", "--ext-diff"]

function gitEnv() {
  return { ...process.env, LC_ALL: "C", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" }
}

function assertAllowed(args) {
  for (const arg of args) {
    if (FORBIDDEN_ARGS.includes(arg)) throw new Error(`forbidden git argument: ${arg}`)
  }
}

export function runGit(cwd, args, options = {}) {
  assertAllowed(args)
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        encoding: "buffer",
        env: gitEnv()
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error, stderr: stderr ? stderr.toString("utf8") : "" })
          return
        }
        resolve({ ok: true, stdout, stderr: stderr ? stderr.toString("utf8") : "" })
      }
    )
  })
}

export function isDubiousOwnership(result) {
  return typeof result.stderr === "string" && result.stderr.includes("detected dubious ownership")
}

export function hashObjectStdinPaths(cwd, relativePaths, options = {}) {
  return new Promise((resolve) => {
    if (relativePaths.length === 0) {
      resolve({ ok: true, ids: [] })
      return
    }
    assertAllowed(["hash-object"])
    const child = spawn(
      "git",
      ["-C", cwd, "--no-optional-locks", "-c", "core.fsmonitor=false", "hash-object", "--no-filters", "--stdin-paths"],
      { env: gitEnv() }
    )
    let stdout = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ ok: false, reason: "timeout" })
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
    })
    child.on("error", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, reason: "spawn-error" })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        resolve({ ok: false, reason: `exit-${code}` })
        return
      }
      resolve({ ok: true, ids: stdout.split("\n").filter((line) => line !== "") })
    })
    child.stdin.write(relativePaths.join("\n") + "\n")
    child.stdin.end()
  })
}
