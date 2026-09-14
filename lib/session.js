/**
 * Resident MCP sessions: one `codegraph serve --mcp` child per project root.
 *
 * Why the plugin talks MCP at all, after ADR-0001 chose CLI subprocesses: the
 * two things the CLI path cannot have both live behind `serve --mcp`.
 *
 * 1. **A file watcher.** The watcher is attached to the daemon's engine, not to
 *    anything the CLI exposes, and it is what makes "the index is already
 *    current" true — so a query no longer pays a `sync` first.
 * 2. **A resident reader.** One long-lived connection replaces a process spawn
 *    per call (measured at 300-500 ms each).
 *
 * ADR-0001's three objections to MCP do not survive this shape: the dropped
 * `instructions` field is replaced by this plugin's own system-prompt section,
 * the single-tool surface is irrelevant because the plugin registers its own
 * tools, and the resident daemon is now the goal rather than the cost.
 *
 * The launcher does its own thing: `serve --mcp` answers the handshake locally
 * from static constants and forwards `tools/call` to a detached shared daemon,
 * which holds the one watcher, the one SQLite writer and one engine for every
 * client of that project. This module never opens the database, never takes the
 * writer lock, and never spawns the daemon itself.
 *
 * @module @mrbbbaixue/dsh-codegraph/session
 */

import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CodegraphRunError, findIndexRoot, resolveCommand } from './runner.js'

/** MCP revision this client claims. The server answers with its own. */
const PROTOCOL_VERSION = '2024-11-05'
/** Handshake budget: node startup plus the proxy's local (static) reply. */
const HANDSHAKE_TIMEOUT_MS = 30_000
/** Retained stderr, used only to explain a failed session. */
const STDERR_MAX_BYTES = 16_000
/** Terminate-escalation grace handed to the subprocess seam. */
const GRACE_MS = 5_000
/**
 * Backstop cadence for the idle reaper. The same reap also runs inline on every
 * call, so this only decides how long a session nothing ever asks for again may
 * outlive its usefulness.
 */
const REAP_INTERVAL_MS = 30_000
/**
 * Most resident sessions kept at once. A session is a node process on top of the
 * shared daemon it proxies, so an agent sweeping many projects must not be able
 * to accumulate one process per project.
 */
const MAX_SESSIONS = 8

/**
 * Managed resident sessions, keyed by project root.
 *
 * One session per project because the daemon — and therefore the watcher and the
 * open database — is per-project. A session starts on first use and lives for the
 * plugin's lifetime; one whose child dies is dropped, and the next call starts a
 * fresh one.
 *
 * @param deps - the plugin context and the live configuration thunk.
 * @returns the call surface plus the teardown.
 */
export function createSessions(deps) {
  /** project root → session record. Presence means "a child exists or is starting". */
  const live = new Map()
  /** The backstop timer, created with the first session and cleared with the last. */
  let reaper

  /**
   * Terminate one session and forget it.
   *
   * The shared daemon it was proxying is deliberately **not** killed: other
   * clients may be using it, and it reaps itself once its own client sweep and
   * idle timeout see no one left. Killing it would break someone else's session.
   *
   * @param project - the session's key.
   * @param session - the session record.
   */
  function drop(project, session) {
    session.handle.terminate()
    if (live.get(project) === session) live.delete(project)
  }

  /**
   * Terminate every session idle past the configured window.
   *
   * Runs inline before each call *and* on a timer, because the two leak shapes
   * differ: a session the agent has moved away from is noticed by its next call,
   * while a session nothing will ever ask for again is only noticed by the timer.
   * A session with a call in flight is never touched.
   *
   * @param now - the current time, so both callers agree on one clock.
   */
  function reapIdle(now) {
    const idleMs = deps.readConfig().sessionIdleSec * 1_000
    for (const [project, session] of live) {
      if (session.inFlight > 0 || now - session.lastUsed < idleMs) continue
      drop(project, session)
    }
    // Nothing left to time out: stop ticking until a call starts a session again.
    if (live.size === 0 && reaper !== undefined) {
      clearInterval(reaper)
      reaper = undefined
    }
  }

  /**
   * Stop the least recently used session that is not serving a call.
   *
   * Busy sessions are never evicted, so a burst of calls across more projects
   * than the cap allows exceeds the cap rather than breaking a live call.
   */
  function evictOldest() {
    let oldest
    for (const [project, session] of live) {
      if (session.inFlight > 0) continue
      if (oldest === undefined || session.lastUsed < oldest.session.lastUsed) {
        oldest = { project, session }
      }
    }
    if (oldest !== undefined) drop(oldest.project, oldest.session)
  }

  /** Start the backstop timer, once. */
  function startReaper() {
    if (reaper !== undefined) return
    reaper = setInterval(() => reapIdle(Date.now()), REAP_INTERVAL_MS)
    // Tidy-up must never be the reason the host process stays alive.
    reaper.unref?.()
  }

  /**
   * Start one resident child and its request bookkeeping.
   *
   * @param project - the project root the daemon is keyed on.
   * @param argv - the full command line.
   * @returns the session record.
   */
  function start(project, argv) {
    /** id → settle callbacks for requests this client is still waiting on. */
    const pending = new Map()
    const record = { dead: undefined, inFlight: 0, lastUsed: Date.now() }
    let nextId = 1
    let buffer = ''

    const markDead = (reason) => {
      if (record.dead !== undefined) return
      record.dead = reason
      for (const entry of pending.values()) entry.reject(reason)
      pending.clear()
      if (live.get(project) === record) live.delete(project)
    }

    /** @param message - one decoded JSON-RPC frame. */
    function receive(message) {
      if (message === null || typeof message !== 'object') return

      // A server-initiated request. No client capability is advertised, but
      // `roots/list` is what the server falls back to when it has no project
      // path; it has ours, so answering accurately costs two fields and removes
      // a cwd guess from the daemon's startup.
      if (typeof message.method === 'string') {
        if (message.id === undefined) return
        const result =
          message.method === 'roots/list'
            ? { roots: [{ uri: pathToFileURL(project).href, name: basename(project) }] }
            : {}
        record.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
        return
      }

      if (message.id === undefined) return
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      if (message.error !== undefined) {
        entry.reject(new CodegraphRunError(`codegraph ${entry.label} failed over MCP: ${message.error.message ?? 'unknown error'}`))
        return
      }
      entry.resolve(message.result)
    }

    let handle
    try {
      handle = deps.ctx.subprocess.spawn({
        argv,
        cwd: project,
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: { maxBytes: STDERR_MAX_BYTES },
        },
        graceMs: GRACE_MS,
        // The whole point of this path is the daemon's watcher, so the opt-out
        // must not survive from the ambient environment: with it set the watcher
        // would move into this child, where it would contend for the project's
        // writer lock against the user's own agent sessions.
        env: { CODEGRAPH_NO_DAEMON: undefined },
      })
    } catch (error) {
      throw new CodegraphRunError(
        `could not start the CodeGraph resident session for ${project}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }

    record.handle = handle
    record.stdin = handle.stdin

    handle.stdout?.setEncoding('utf8')
    handle.stdout?.on('data', (chunk) => {
      buffer += chunk
      let cut = buffer.indexOf('\n')
      while (cut !== -1) {
        const line = buffer.slice(0, cut).trim()
        buffer = buffer.slice(cut + 1)
        if (line !== '') {
          try {
            receive(JSON.parse(line))
          } catch {
            // A frame this client cannot interpret is dropped rather than
            // crashing a long-lived connection; the handshake timeout is what
            // turns a silent server into a readable error.
          }
        }
        cut = buffer.indexOf('\n')
      }
    })
    handle.stdout?.on('error', (error) => {
      markDead(new CodegraphRunError(`the CodeGraph session for ${project} lost its output stream: ${error.message}`))
    })
    handle.done.then(
      (outcome) => {
        const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
        markDead(
          new CodegraphRunError(
            `the CodeGraph session for ${project} exited (${outcome.signal ?? `code ${outcome.exitCode}`}).${stderr === '' ? '' : ` ${stderr}`}`,
          ),
        )
      },
      (error) => {
        markDead(
          new CodegraphRunError(
            `the CodeGraph session for ${project} failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          ),
        )
      },
    )

    /**
     * Send one request and await its response.
     *
     * @param method - the JSON-RPC method.
     * @param params - its parameters.
     * @param signal - the tool call's cancellation, when there is one.
     * @param label - what to call this request in errors.
     * @returns the response's `result`.
     */
    record.request = (method, params, signal, label) => {
      if (record.dead !== undefined) return Promise.reject(record.dead)
      return new Promise((resolve, reject) => {
        const id = nextId
        nextId += 1
        const settle = (finish) => (value) => {
          signal?.removeEventListener('abort', abort)
          finish(value)
        }
        const abort = () => {
          if (!pending.delete(id)) return
          const cancelled = new Error(`codegraph ${label} was cancelled.`)
          cancelled.name = 'AbortError'
          reject(cancelled)
        }
        if (signal?.aborted === true) {
          abort()
          return
        }
        signal?.addEventListener('abort', abort, { once: true })
        pending.set(id, { label, resolve: settle(resolve), reject: settle(reject) })
        record.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    }

    return record
  }

  /**
   * Ask the daemon for one project's root, so every directory inside a project
   * shares its single session instead of starting a second proxy on the same
   * daemon.
   *
   * @param root - the directory the call targets.
   * @returns the project root.
   */
  function projectOf(root) {
    return findIndexRoot(root) ?? root
  }

  /**
   * Run one MCP tool call on the project's resident session, starting it when
   * this is the first call for that project.
   *
   * @param root - the directory the call targets.
   * @param toolName - the server-side tool name.
   * @param args - the server-side arguments.
   * @param signal - the tool call's cancellation.
   * @returns the model-facing text.
   * @throws {CodegraphRunError} when the session cannot start, dies, or answers with `isError`.
   */
  async function call(root, toolName, args, signal) {
    const project = projectOf(root)
    // Notice whatever this call has just made idle, before reusing anything.
    reapIdle(Date.now())
    let session = live.get(project)

    if (session === undefined || session.dead !== undefined) {
      if (live.size >= MAX_SESSIONS) evictOldest()
      const command = await resolveCommand({ ctx: deps.ctx, config: deps.readConfig() })
      session = start(project, [command.argv0, ...command.prefixArgs, 'serve', '--mcp', '-p', project])
      live.set(project, session)
      startReaper()
      try {
        await withTimeout(
          session.request(
            'initialize',
            {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: '@mrbbbaixue/dsh-codegraph', version: '0.1.0' },
            },
            undefined,
            'initialize',
          ),
          HANDSHAKE_TIMEOUT_MS,
          project,
        )
      } catch (error) {
        // A session that never completed its handshake must not be reused, and
        // its child must not be left behind for the next call to find.
        drop(project, session)
        throw error
      }
      session.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    }

    session.inFlight += 1
    session.lastUsed = Date.now()
    try {
      const result = await session.request('tools/call', { name: toolName, arguments: args }, signal, toolName)
      const text = textOf(result)
      if (result?.isError === true) {
        throw new CodegraphRunError(text === '' ? `codegraph ${toolName} reported an error over MCP.` : text)
      }
      return text
    } finally {
      session.inFlight -= 1
    }
  }

  /**
   * Terminate every resident session and stop the reaper.
   *
   * The shared daemons outlive us by design: they are shared with every other
   * client of that project and reap themselves via their own client sweep and
   * idle timeout, so they are not ours to kill.
   */
  function dispose() {
    if (reaper !== undefined) {
      clearInterval(reaper)
      reaper = undefined
    }
    for (const session of live.values()) session.handle.terminate()
    live.clear()
  }

  return { call, dispose }
}

/**
 * Bound one promise with a wall-clock deadline.
 *
 * The losing side of the race keeps a handler: on a handshake timeout the caller
 * terminates the child, which rejects every request still in flight — and that
 * rejection arrives after this function returned, so without the attached handler
 * it would surface as an unhandled rejection.
 *
 * @param promise - the promise to bound.
 * @param budgetMs - the deadline in milliseconds.
 * @param project - the project directory, for the error text.
 * @returns the promise's value.
 * @throws {CodegraphRunError} when the deadline passes first.
 */
async function withTimeout(promise, budgetMs, project) {
  promise.catch(() => {})
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new CodegraphRunError(`the CodeGraph session for ${project} did not answer the initialize handshake within ${budgetMs} ms.`))
        }, budgetMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pull the model-facing text out of an MCP tool result.
 *
 * @param result - the `tools/call` result.
 * @returns the concatenated text blocks, or an empty string.
 */
function textOf(result) {
  const content = result?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}
