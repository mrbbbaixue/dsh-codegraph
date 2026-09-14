/**
 * Process execution for the `codegraph` CLI.
 *
 * Three concerns live here, and nothing else:
 *
 * 1. **Resolving** which `codegraph` to run, re-read on every call (never at
 *    `apply()` time — an early probe turns a missing runtime into a startup
 *    crash instead of a readable tool error).
 * 2. **Invoking** it in a form that works on Windows, where Node ≥ 22 refuses to
 *    spawn a `.cmd` shim directly (`EINVAL`, the CVE-2024-27980 hardening).
 * 3. **Collecting** its output with bounded retention, controllable truncation,
 *    and one normalized error shape.
 *
 * @module @mrbbbaixue/dsh-codegraph/runner
 */

import { createRequire } from 'node:module'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

const require = createRequire(import.meta.url)

/** Head-preserving stdout budget. `explore` markdown leads with the source, so the head is the useful part. */
const STDOUT_MAX_BYTES = 400_000
/** Retained stderr tail, used only to explain a non-zero exit. */
const STDERR_MAX_BYTES = 16_000
/** Terminate-escalation grace handed to the subprocess seam; the seam rejects anything non-positive. */
const GRACE_MS = 5_000
/** A per-process marker directory the indexer writes at the project root. */
const INDEX_DIR = '.codegraph'
/** The index database inside {@link INDEX_DIR}; its presence is what "indexed" means. */
const INDEX_DB = 'codegraph.db'
/** Inclusive ceiling on the upward index probe, so an unindexed path cannot scan a whole drive. */
const MAX_INDEX_WALK = 12
/** Passed through from the installed launcher: the SDK's own V8 flag, avoiding tree-sitter WASM Zone OOM. */
const V8_LIFTOFF_FLAG = '--liftoff-only'
/** Node's `node:sqlite` experimental-import warning is expected output, not a diagnostic. */
const NODE_WARNING_FLAG = '--disable-warning=ExperimentalWarning'
/** The default `executable` value; anything else means the deployment configured one on purpose. */
const DEFAULT_EXECUTABLE = 'codegraph'

/** A `codegraph` run that could not be started, or exited non-zero. */
export class CodegraphRunError extends Error {
  /**
   * @param message - operator- and model-facing text, usually the CLI's own words.
   * @param details - exit facts and the captured streams, when a run happened.
   */
  constructor(message, details = {}) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined)
    this.name = 'CodegraphRunError'
    this.exitCode = details.exitCode
    this.stdout = details.stdout ?? ''
    this.stderr = details.stderr ?? ''
    this.truncated = details.truncated ?? false
  }
}

/**
 * A `codegraph` invocation form. `argv0` is the program; `prefixArgs` precede the
 * CLI arguments (a shim path, or the interpreter flags and script of a bundled
 * runtime).
 *
 * @typedef {{ kind: 'shim' | 'local' | 'path', argv0: string, prefixArgs: string[], display: string }} CodegraphCommand
 */

/**
 * Whether a path is an existing directory.
 * @param path - absolute path to test.
 * @returns true when a directory lives there.
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Whether a path is an existing file.
 * @param path - absolute path to test.
 * @returns true when a file lives there.
 */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Recognise a self-contained `codegraph` install by shape rather than by
 * location: a bundled Node plus the CLI entry the official launcher runs.
 *
 * The shape is taken from the installed launcher's own single line —
 * `@"%~dp0..\node.exe" --liftoff-only --disable-warning=ExperimentalWarning "%~dp0..\lib\dist\bin\codegraph.js" %*`
 * — so an `install.ps1` install, a downloaded bundle, and a platform package all
 * resolve through one recogniser.
 *
 * @param root - candidate install root.
 * @returns the interpreter and entry to run, or undefined when the shape does not match.
 */
function localInstallAt(root) {
  if (root === undefined || root === '' || !isDirectory(root)) return undefined
  const nodeExe = isFile(join(root, 'node.exe')) ? join(root, 'node.exe') : join(root, 'node')
  if (!isFile(nodeExe)) return undefined
  const entry = join(root, 'lib', 'dist', 'bin', 'codegraph.js')
  if (!isFile(entry)) return undefined
  return { root, nodeExe, entry }
}

/**
 * Candidate install roots, most specific first. Covers the `install.ps1` layout,
 * the POSIX versioned layout, and the shim's self-healing bundle cache.
 *
 * @returns candidate absolute directories.
 */
function candidateInstallRoots() {
  const home = homedir()
  const roots = []
  const localAppData = process.env.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData !== '') {
    roots.push(join(localAppData, 'codegraph', 'current'))
  }
  roots.push(join(home, '.codegraph', 'current'))

  const versions = join(home, '.codegraph', 'versions')
  for (const entry of safeReadDir(versions)) {
    roots.push(join(versions, entry, 'current'), join(versions, entry))
  }
  for (const entry of safeReadDir(join(home, '.codegraph', 'bundles'))) {
    roots.push(join(home, '.codegraph', 'bundles', entry))
  }
  return roots
}

/**
 * Read a directory without throwing.
 * @param path - directory to list.
 * @returns child names, or an empty list when unreadable.
 */
function safeReadDir(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/**
 * The thin npm package's shim, which resolves the platform package, survives
 * mirror-skipped optional dependencies by self-healing into `~/.codegraph/bundles`,
 * and avoids Windows `.cmd` spawning on our behalf.
 *
 * The subpath is tried first and the package root second, because a restrictive
 * `exports` map in the thin package would reject the subpath form.
 *
 * @returns the shim's absolute path, or undefined when the dependency is absent.
 */
function resolveShim() {
  try {
    const resolved = require.resolve('@colbymchenry/codegraph/npm-shim.js')
    if (isFile(resolved)) return resolved
  } catch {
    // Fall through to the package-root probe.
  }
  try {
    const manifest = require.resolve('@colbymchenry/codegraph/package.json')
    const shim = join(dirname(manifest), 'npm-shim.js')
    if (isFile(shim)) return shim
  } catch {
    // Not installed.
  }
  return undefined
}

/**
 * Render an argv vector for a diagnostic message. The vector is never
 * shell-interpreted; quoting here only keeps the message unambiguous.
 *
 * @param argv - the full command line.
 * @returns a single display string.
 */
function displayArgv(argv) {
  return argv.map((part) => (part === process.execPath ? 'node' : /\s/.test(part) ? JSON.stringify(part) : part)).join(' ')
}

/**
 * Turn a `.cmd` launcher path back into the install root it wraps.
 * @param launcherPath - path to `…/bin/codegraph.cmd`.
 * @returns the install root, or undefined when the path is not the known shape.
 */
function installRootFromLauncher(launcherPath) {
  const root = dirname(dirname(launcherPath))
  return localInstallAt(root) === undefined ? undefined : root
}

/**
 * Turn one resolved candidate into the form that can actually be spawned.
 *
 * `.cmd`/`.bat` launchers are the whole reason this function exists: Node ≥ 22
 * refuses to spawn them (`EINVAL`, the CVE-2024-27980 hardening), and on Windows
 * `resolveExecutable` answers with exactly that shape under `PATHEXT`. A launcher
 * is mapped back onto the install it wraps and refused loudly when the sibling
 * interpreter and entry are not there, because spawning it anyway is a guaranteed
 * failure with a useless message.
 *
 * @param candidate - a resolved executable or launcher path.
 * @returns the invocation form.
 * @throws {CodegraphRunError} when only a launcher exists with no install beside it.
 */
function formFor(candidate) {
  if (!/\.(cmd|bat)$/iu.test(candidate)) {
    return { kind: 'path', argv0: candidate, prefixArgs: [], display: candidate }
  }
  const root = installRootFromLauncher(candidate)
  if (root === undefined) {
    throw new CodegraphRunError(
      `codegraph resolved to the launcher "${candidate}", which Node ${process.version} refuses to spawn directly (EINVAL). No node.exe + lib/dist/bin/codegraph.js was found beside it. Install a self-contained codegraph build, or set the "executable" config to that build's node executable.`,
    )
  }
  const install = localInstallAt(root)
  return {
    kind: 'local',
    argv0: install.nodeExe,
    prefixArgs: [V8_LIFTOFF_FLAG, NODE_WARNING_FLAG, install.entry],
    display: `${install.nodeExe} ${install.entry}`,
  }
}

/**
 * Ask the harness to resolve a bare command name on `PATH`.
 * @param ctx - the plugin context.
 * @param command - the bare name.
 * @returns the resolved path, or undefined when nothing matches.
 */
async function resolveOnPath(ctx, command) {
  try {
    return await ctx.subprocess.resolveExecutable(command)
  } catch {
    return undefined
  }
}

/**
 * Resolve the command to run, in order:
 *
 * 1. the **configured** `executable` — an explicit path is the clearest signal
 *    there is, so it wins over anything discovered;
 * 2. the plugin's own `@colbymchenry/codegraph` dependency (whose shim also
 *    covers the `~/.codegraph/bundles` cache and the self-healing download);
 * 3. a self-contained install on disk — the `install.ps1` layout, a POSIX
 *    versioned layout, or a cache the shim left behind;
 * 4. the default `codegraph` on `PATH`.
 *
 * Resolution happens on **every call** — never at `apply()` time — so a runtime
 * installed or removed mid-session is picked up, and a missing one becomes a
 * readable tool error instead of a startup crash.
 *
 * @param options - the harness context and the resolved plugin config.
 * @returns the resolved invocation form.
 * @throws {CodegraphRunError} when no usable runtime exists, or the configured one is unusable.
 */
export async function resolveCommand({ ctx, config }) {
  const configured = config.executable

  // An explicitly configured path is authoritative: it is also the only way to
  // override a stale install the scan would otherwise keep finding.
  if (isAbsolute(configured)) {
    if (!isFile(configured)) {
      throw new CodegraphRunError(`the configured executable "${configured}" does not exist. Fix the "executable" config or remove it to use the automatic search.`)
    }
    return formFor(configured)
  }
  if (configured !== DEFAULT_EXECUTABLE) {
    const fromPath = await resolveOnPath(ctx, configured)
    if (fromPath !== undefined) return formFor(fromPath)
  }

  const shim = resolveShim()
  if (shim !== undefined) {
    return { kind: 'shim', argv0: process.execPath, prefixArgs: [shim], display: `node ${shim}` }
  }

  for (const root of candidateInstallRoots()) {
    const install = localInstallAt(root)
    if (install !== undefined) {
      return {
        kind: 'local',
        argv0: install.nodeExe,
        prefixArgs: [V8_LIFTOFF_FLAG, NODE_WARNING_FLAG, install.entry],
        display: `${install.nodeExe} ${install.entry}`,
      }
    }
  }

  const fromPath = await resolveOnPath(ctx, configured)
  if (fromPath === undefined) {
    throw new CodegraphRunError(
      `codegraph could not be found. Tried the plugin's own dependency, ${candidateInstallRoots().join(', ')}, and "${configured}" on PATH. Install it (npm i -D @colbymchenry/codegraph, or the official installer), or point the "executable" config at one.`,
    )
  }
  return formFor(fromPath)
}

/**
 * Accumulate the head of a byte stream under a cap, remembering whether anything
 * was dropped.
 *
 * The subprocess seam's own collect mode retains the **tail** on overflow, which
 * is the wrong end for `explore`: its markdown leads with the source the model
 * actually needs. Reading the stream ourselves is what buys a head-preserving
 * cut, and with it a truncation marker the model can trust.
 *
 * @param maxBytes - the retention budget.
 * @returns a sink plus a terminator.
 */
function makeHeadRetainer(maxBytes) {
  const chunks = []
  let kept = 0
  let truncated = false
  return {
    /** @param chunk - the next Buffer from the stream. */
    push(chunk) {
      if (kept >= maxBytes) {
        truncated = true
        return
      }
      const remaining = maxBytes - kept
      if (chunk.length <= remaining) {
        chunks.push(chunk)
        kept += chunk.length
        return
      }
      chunks.push(chunk.subarray(0, remaining))
      kept = maxBytes
      truncated = true
    },
    /** @returns the decoded head and whether bytes were dropped. */
    finish() {
      return { text: stripVTControlCharacters(Buffer.concat(chunks, kept).toString('utf8')), truncated }
    },
  }
}

/**
 * Combine an abort signal with a hard budget.
 * @param signals - candidate signals, any of which may be undefined.
 * @returns one signal, or undefined when none was supplied.
 */
function combineSignals(...signals) {
  const live = signals.filter((signal) => signal !== undefined)
  if (live.length === 0) return undefined
  if (live.length === 1) return live[0]
  return AbortSignal.any(live)
}

/**
 * Await the process outcome under an optional wall-clock budget.
 *
 * The budget bounds the *caller's wait*, not the child's life: on expiry the
 * managed process range is terminated and the wait returns immediately. B2
 * depends on this — it runs on the user's prompt path and must never hold a turn
 * open for the termination grace period.
 *
 * @param handle - the live subprocess handle.
 * @param budgetMs - the caller's budget, or undefined to wait for the outcome.
 * @returns the outcome, or an expiry marker.
 */
async function awaitOutcome(handle, budgetMs) {
  if (budgetMs === undefined) {
    try {
      return { kind: 'outcome', outcome: await handle.done }
    } catch (error) {
      return { kind: 'failure', error }
    }
  }
  let timer
  const expiry = new Promise((settle) => {
    timer = setTimeout(() => settle('expired'), budgetMs)
  })
  try {
    const settled = await Promise.race([
      handle.done.then(
        (outcome) => ({ kind: 'outcome', outcome }),
        (error) => ({ kind: 'failure', error }),
      ),
      expiry,
    ])
    if (settled === 'expired') {
      handle.terminate()
      return { kind: 'expired' }
    }
    return settled
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run the CLI once and return its captured output.
 *
 * `exec.signal` carries the harness's own tool-call timeout and caller
 * cancellation — this seam has no `timeoutMs` field, only a signal — so the
 * per-tool budgets declared on the tool definitions are what actually bound a
 * call. `budgetMs` is the separate, caller-owned deadline B2 needs.
 *
 * @param options - run inputs: context, config, cwd, CLI arguments, optional stdin, and limits.
 * @returns the captured streams and a truncation flag.
 * @throws {CodegraphRunError} on launch failure, expiry, signal death, or a non-zero exit.
 */
export async function runCodegraph({ ctx, config, cwd, args, stdinData, signal, budgetMs, label }) {
  const command = await resolveCommand({ ctx, config })
  const argv = [command.argv0, ...command.prefixArgs, ...args]
  const timeoutSignal = budgetMs === undefined ? undefined : AbortSignal.timeout(budgetMs)
  const combined = combineSignals(signal, timeoutSignal)
  const retainer = makeHeadRetainer(STDOUT_MAX_BYTES)

  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: stdinData === undefined ? 'ignore' : { data: stdinData },
        stdout: 'pipe',
        stderr: { maxBytes: STDERR_MAX_BYTES },
      },
      graceMs: GRACE_MS,
      signal: combined,
    })
  } catch (error) {
    throw new CodegraphRunError(`${label} could not start: ${command.display}. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }

  // Flowing mode from the first tick: an unread pipe would stall the child.
  handle.stdout?.on('data', (chunk) => retainer.push(chunk))

  const settled = await awaitOutcome(handle, budgetMs)
  const captured = retainer.finish()
  const stderr = stripVTControlCharacters(handle.collected.stderr?.readFrom(0).text ?? '')

  if (settled.kind === 'expired') {
    throw new CodegraphRunError(`${label} did not finish within ${budgetMs} ms and was terminated.`, {
      stdout: captured.text,
      stderr,
      truncated: captured.truncated,
    })
  }
  if (settled.kind === 'failure') {
    throw new CodegraphRunError(`${label} failed before reporting an outcome (${command.display}). ${settled.error instanceof Error ? settled.error.message : String(settled.error)}`, {
      cause: settled.error,
      stdout: captured.text,
      stderr,
      truncated: captured.truncated,
    })
  }

  const { exitCode, signal: deathSignal } = settled.outcome
  if (signal?.aborted === true) {
    const aborted = new Error(`${label} was cancelled.`)
    aborted.name = 'AbortError'
    throw aborted
  }
  if (deathSignal !== null || exitCode === null) {
    throw new CodegraphRunError(`${label} was killed by signal ${deathSignal ?? '(unknown)'}.`, {
      stdout: captured.text,
      stderr,
      truncated: captured.truncated,
    })
  }
  if (exitCode !== 0) {
    const detail = stderr.trim() !== '' ? stderr.trim() : captured.text.trim() !== '' ? captured.text.trim() : `exit code ${exitCode}`
    throw new CodegraphRunError(`${label} exited ${exitCode}: ${detail}`, {
      exitCode,
      stdout: captured.text,
      stderr,
      truncated: captured.truncated,
    })
  }

  return { stdout: captured.text, stderr, truncated: captured.truncated, command: displayArgv(argv) }
}

/**
 * Resolve the project root to operate on.
 *
 * The session's workspace cwd is authoritative; the tool's `path` argument
 * overrides it. There is deliberately no `/` or `process.cwd()` fallback for the
 * implicit case — silently indexing or querying the harness's own start
 * directory is worse than refusing, and the error tells the model what to pass
 * instead. `process.cwd()` is used only as the base for a *relative* explicit path.
 *
 * @param exec - the tool-execution context supplying the session cwd.
 * @param explicitPath - the caller's `path` argument, when given.
 * @returns the absolute root directory.
 * @throws {CodegraphRunError} when no root can be established, or the named path is not a directory.
 */
export function resolveRoot(exec, explicitPath) {
  const sessionCwd = exec?.agent?.session?.header?.cwd
  const trimmed = typeof explicitPath === 'string' ? explicitPath.trim() : ''

  if (trimmed !== '') {
    const base = typeof sessionCwd === 'string' && sessionCwd !== '' ? sessionCwd : process.cwd()
    const candidate = isAbsolute(trimmed) ? resolvePath(trimmed) : resolvePath(base, trimmed)
    if (!isDirectory(candidate)) {
      throw new CodegraphRunError(`path "${explicitPath}" is not an existing directory.`)
    }
    return candidate
  }

  if (typeof sessionCwd !== 'string' || sessionCwd === '') {
    throw new CodegraphRunError('no workspace directory is available for this call. Pass an absolute "path" to the project you want codegraph to work on.')
  }
  if (!isDirectory(sessionCwd)) {
    throw new CodegraphRunError(`the session workspace "${sessionCwd}" is not an existing directory. Pass an absolute "path" instead.`)
  }
  return sessionCwd
}

/**
 * Find the project whose index governs a directory, by walking up for the
 * marker database. The index lives at the **project root**, not the cwd, so
 * every operation agrees on which index it is talking about.
 *
 * @param startDir - the directory to search from.
 * @returns the indexed project root, or undefined when nothing up to the cap is indexed.
 */
export function findIndexRoot(startDir) {
  let current = resolvePath(startDir)
  for (let depth = 0; depth <= MAX_INDEX_WALK; depth += 1) {
    if (isFile(join(current, INDEX_DIR, INDEX_DB))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * Whether a directory is governed by an existing index.
 * @param dir - the directory to test.
 * @returns true when an ancestor (up to the walk cap) is indexed.
 */
export function isIndexed(dir) {
  return findIndexRoot(dir) !== undefined
}
