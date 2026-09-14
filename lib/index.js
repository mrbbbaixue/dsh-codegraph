/**
 * CodeGraph for DeepSeek Harness — the host half.
 *
 * The plugin gives dsh the codegraph capability over a **CLI subprocess** rather
 * than MCP, which is what lets it deliver the two things the MCP path drops: the
 * guide text, and a self-bootstrap tool. Three surfaces ride on that:
 *
 * - **Tools** — `core` exposes `codegraph_explore` + `codegraph_index`; `full`
 *   adds the eight narrow commands. Re-registered as a set, so `surface` is a
 *   live setting rather than a restart.
 * - **B1** — one static system-prompt section (~1.5 KB), so the model reaches
 *   for the graph before grep. Global scope, so subagents get it too.
 * - **B2** — a dynamic pre-step injection driven by `codegraph prompt-hook`,
 *   bounded by a hard budget and a per-process circuit breaker.
 *
 * Plus two bounds on index writes: a workspace with no index is indexed
 * automatically on the first query (unless `autoIndex` is off or the project is
 * past `autoIndexMaxFiles`), and `init`/`index` called as tools still ask the
 * user first, because an explicit whole-index rebuild is their call.
 *
 * @module @mrbbbaixue/dsh-codegraph
 */

import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, parse } from 'node:path'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

import { CODEGRAPH_GUIDE } from './guide.js'
import { CodegraphRunError, findIndexRoot, isIndexed, resolveRoot, runCodegraph } from './runner.js'

/** Loader-facing plugin name. */
export const name = 'codegraph'

/**
 * `tools` and `systemPrompt` carry the two registries the plugin writes to;
 * `subprocess` is the only seam that can start the CLI.
 */
export const inject = ['tools', 'systemPrompt', 'subprocess']

/** Settings namespace owned by this plugin. The host and browser halves join on it, so it is declared once. */
export const SETTINGS_NAMESPACE = 'dsh-codegraph'

/** The prompt section's unique name, also its diagnostics label. */
const SECTION_NAME = 'tool:codegraph'

/** `TOOL_BASH` is 1000 and `TOOL_READ` is 1100 in dsh 0.1.5-rc.1; 10 below bash lands the guide just before the tool sections. */
const SECTION_ORDER_OFFSET = 10
/** Used only when the placement name cannot be resolved — a constant, never a silent 0. */
const FALLBACK_SECTION_ORDER = 990

/** B2 runs on the user's prompt path, so its whole subprocess budget is 3 s. */
const FRONTLOAD_BUDGET_MS = 3_000
/** The `prompt-hook` contract caps a block at 9000 characters; this guards against a misbehaving build. */
const FRONTLOAD_MAX_CHARS = 12_000
/** Two consecutive failures retire the feature for this process. */
const FRONTLOAD_MAX_FAILURES = 2
/** Re-sent prompts (GUI retry, turn re-entry) must not inject the same context twice. */
const FRONTLOAD_DEDUPE_TTL_MS = 600_000
const FRONTLOAD_DEDUPE_MAX = 20

const EXPLORE_TOOL = 'codegraph_explore'
const INDEX_TOOL = 'codegraph_index'

/** Dependencies never counted towards the automatic-index ceiling: neither holds source the model would query. Dot-directories are skipped for the same reason. */
const UNCOUNTED_DIRS = new Set(['node_modules'])

/** The two tool surfaces, declared as plain literals: `z.union([...values])` is the first-party idiom for an enum setting, and it serializes to a shape the settings surface already renders. */
const SURFACES = ['core', 'full']

/**
 * Plugin configuration. The first three are the settings card; the rest stay in
 * `cordis.patch.yml` for advanced deployments — and remain overridable through
 * the settings namespace, which is why the whole object is the registered schema.
 */
export const Config = z.object({
  guide: z.boolean().default(true),
  frontload: z.boolean().default(true),
  surface: z.union([...SURFACES]).default('core'),
  autoSync: z.boolean().default(true),
  autoIndex: z.boolean().default(true),
  autoIndexMaxFiles: z.natural().min(1).default(10_000),
  executable: z.string().default('codegraph'),
  exploreTimeoutSec: z.natural().min(1).default(120),
  indexTimeoutSec: z.natural().min(1).default(900),
})

const EXPLORE_DESCRIPTION = `Explore an area of the codebase and get its source plus its call paths in one call.

Pass a natural-language question, or a bag of symbol/file names. The result contains the verbatim, line-numbered, current on-disk source of the relevant symbols grouped by file — treat every block it returns as a Read you have already performed — together with the call paths between them (including dynamic-dispatch hops grep cannot follow) and a blast-radius summary of what depends on them.

Prefer this over grep/glob/read to locate or understand code whenever the workspace has a \`.codegraph/\` index at its root. A symbol added since the last index sync stays invisible until the next sync, which this plugin runs automatically before each query. A workspace that is not indexed yet is no obstacle either: this plugin builds the index for you on the first call.

If the call still reports that CodeGraph is not available here, the automatic build was switched off, failed, or the project is larger than the configured file ceiling. Use \`codegraph_index\` with \`operation: init\` — it asks the user first — or say so and let the user decide.`

const INDEX_DESCRIPTION = `Build or refresh the CodeGraph index for a project.

- \`init\` — first-time index for a project that has none.
- \`sync\` — incremental: apply only what changed since the last index. Cheap, and already run automatically before queries while the autoSync setting is on.
- \`index\` — rebuild the whole index from scratch (same result as a fresh init).

\`init\` and \`index\` ask the user for approval before they run; \`sync\` does not.`

/**
 * Accept a truncated payload, saying so at the cut.
 *
 * Fine for the human-readable commands, whose head carries the useful part. A
 * truncated JSON payload must not come back this way — an unparseable result
 * misleads more than a refusal — which is what {@link strictText} is for.
 *
 * @param result - the captured run.
 * @returns the model-facing text.
 */
function tolerantText(result) {
  if (!result.truncated) return result.stdout
  return `${result.stdout}\n\n[codegraph: output truncated by the plugin at the capture limit — the listing above is incomplete. Narrow the query to see the rest.]`
}

/**
 * Refuse a payload that was cut, rather than hand the model something it cannot
 * parse.
 *
 * @param result - the captured run.
 * @param toolName - the tool to name in the refusal.
 * @returns the model-facing text.
 * @throws {CodegraphRunError} when the payload exceeded the capture limit.
 */
function strictText(result, toolName) {
  if (!result.truncated) return result.stdout
  throw new CodegraphRunError(
    `${toolName}: the command produced more output than the plugin retains. Narrow the query (or the file list) and retry; a truncated payload is not returned because it would not parse.`,
  )
}

/**
 * Refresh the index before a query, and never let that refresh fail the query.
 *
 * The CLI has no file watcher, so a symbol added since the last sync is silently
 * invisible — exactly the edit the model most often makes. Syncing first is what
 * makes "trust these results" a safe instruction; degrading to an
 * annotated-but-successful answer is what keeps a read-only project usable.
 *
 * @param deps - the plugin context and the live configuration thunk.
 * @param root - the directory the query targets.
 * @param exec - the tool-execution context, supplying cancellation.
 * @returns a note to prepend to the result, empty on a clean or skipped sync.
 */
async function autoSync(deps, root, exec) {
  const config = deps.readConfig()
  if (config.autoSync !== true) return ''
  const indexRoot = findIndexRoot(root)
  // Unindexed: nothing to sync, and `sync` would only add a subprocess and a
  // "CodeGraph not initialized" failure. The query's own message is better.
  if (indexRoot === undefined) return ''

  try {
    await runCodegraph({
      ctx: deps.ctx,
      config,
      cwd: indexRoot,
      args: ['sync', '-q', indexRoot],
      signal: exec.signal,
      label: 'codegraph sync',
    })
    return ''
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    const detail = error instanceof Error ? error.message : String(error)
    return `[codegraph: could not refresh the index before this query (${detail}). Results may be stale — a symbol added since the last successful sync may be missing.]\n\n`
  }
}

/**
 * Count a project's files, stopping the moment the ceiling is passed.
 *
 * The count only has to answer "small enough to index unasked", so this is a
 * directory walk rather than an inventory: dot-directories and `node_modules`
 * hold no source the model would query, and crossing the ceiling ends the walk.
 *
 * @param root - the project directory.
 * @param ceiling - the largest count that still allows an automatic index.
 * @returns the file count, capped one past the ceiling.
 */
async function countFiles(root, ceiling) {
  let count = 0
  const queue = [root]
  while (queue.length > 0) {
    const dir = queue.pop()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !UNCOUNTED_DIRS.has(entry.name)) queue.push(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      count += 1
      if (count > ceiling) return count
    }
  }
  return count
}

/**
 * Run the CLI's first-time index for one workspace.
 *
 * @param deps - the plugin context and the live configuration thunk.
 * @param root - the project directory to index.
 * @param exec - the tool-execution context, supplying cancellation.
 */
async function buildIndex(deps, root, exec) {
  assertIndexableTarget(root)
  const config = deps.readConfig()
  await runCodegraph({
    ctx: deps.ctx,
    config,
    cwd: root,
    args: ['init', '-y', root],
    signal: exec.signal,
    // A full first index is an `index`-class write, so it gets that budget rather
    // than the query's: the two ceilings stay independent.
    budgetMs: config.indexTimeoutSec * 1_000,
    label: 'codegraph init',
  })
}

/**
 * Build the index for a workspace that has none, when the deployment allows it
 * and the project is small enough.
 *
 * The guide tells the model to reach for `explore` first and to trust what comes
 * back, and a "not indexed" answer stops that dead — so the bootstrap belongs
 * here, not in a tool call the model has to remember. Two bounds keep it from
 * turning a query into a surprise: `autoIndex`, and `autoIndexMaxFiles`, past
 * which the decision is the model's or the user's again.
 *
 * @param deps - the plugin context and the live configuration thunk.
 * @returns the bootstrap, taking a root and the execution context.
 */
function createAutoIndex(deps) {
  /** Builds already crossing the wire, keyed by root: parallel queries must not race on one index. */
  const inFlight = new Map()

  return async function autoIndex(root, exec) {
    const config = deps.readConfig()
    if (config.autoIndex !== true) return undefined
    // An index at or above this directory governs it already.
    if (findIndexRoot(root) !== undefined) return undefined

    const ceiling = config.autoIndexMaxFiles
    const files = await countFiles(root, ceiling)
    if (files > ceiling) {
      return `[codegraph: this workspace has no index and the plugin did not build one, because it holds more than the ${ceiling}-file ceiling this deployment set for automatic indexing (autoIndexMaxFiles). Call codegraph_index with operation=init — it asks the user first — or raise that setting.]\n\n`
    }

    let build = inFlight.get(root)
    if (build === undefined) {
      build = buildIndex(deps, root, exec).finally(() => inFlight.delete(root))
      inFlight.set(root, build)
    }
    try {
      await build
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      const detail = error instanceof Error ? error.message : String(error)
      throw new CodegraphRunError(
        `this workspace has no CodeGraph index and building one automatically failed: ${detail} Run codegraph_index with operation=init to do it deliberately, or turn the autoIndex setting off.`,
        { cause: error },
      )
    }
    return `[codegraph: this workspace had no index. The plugin built one automatically before this query (init over ${files} files), so what follows comes from a fresh index.]\n\n`
  }
}

/**
 * Everything the plugin does to a workspace before an `explore` runs.
 *
 * @param deps - the plugin context, the live configuration thunk, and the bootstrap.
 * @param root - the directory the query targets.
 * @param exec - the tool-execution context, supplying cancellation.
 * @returns a note to prepend to the result, empty on an already-current index.
 */
async function prepareExplore(deps, root, exec) {
  const built = await deps.autoIndex(root, exec)
  // A fresh build already reflects the disk; syncing on top of it buys nothing.
  return built ?? (await autoSync(deps, root, exec))
}

/**
 * Build one tool whose canonical value is a **string**: what the model reads is
 * the CLI's own output, returned verbatim.
 *
 * Parameter convention: `required: true` marks a mandatory argument, and an
 * optional one simply **omits** `required` — the schema compiler rejects
 * `required: false` outright.
 *
 * @param deps - the plugin context and the live configuration thunk.
 * @param spec - name, description, parameters, timeout, argument mapping, and strictness.
 * @returns a registry-ready definition.
 */
function textTool(deps, spec) {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    timeoutMs: spec.timeoutMs,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const root = resolveRoot(exec, args.path)
      const prefix = spec.name === EXPLORE_TOOL ? await prepareExplore(deps, root, exec) : ''
      const result = await runCodegraph({
        ctx: deps.ctx,
        config: deps.readConfig(),
        cwd: root,
        args: spec.buildArgs(args, root),
        signal: exec.signal,
        label: `codegraph ${spec.name.replace(/^codegraph_/u, '')}`,
      })
      return prefix + (spec.strict === true ? strictText(result, spec.name) : tolerantText(result))
    },
  })
}

/**
 * Refuse to build an index at a filesystem root or the user's home directory.
 *
 * The CLI gates those behind `--force`, which this plugin never passes to
 * `init`: an accidental whole-home index is a multi-gigabyte write nobody asked for.
 *
 * @param root - the resolved project root.
 * @throws {CodegraphRunError} when the target is a home or root directory.
 */
function assertIndexableTarget(root) {
  const normalise = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  if (normalise(root) === normalise(parse(root).root)) {
    throw new CodegraphRunError(`refusing to index the filesystem root (${root}). Pass the project directory instead.`)
  }
  if (normalise(root) === normalise(homedir())) {
    throw new CodegraphRunError(`refusing to index the home directory (${root}). Pass the project directory instead.`)
  }
}

/**
 * The `core` surface: the one strong tool the vendor's own measurements favour,
 * plus the bootstrap tool MCP deliberately withholds.
 *
 * @param deps - the plugin context and the live configuration thunk.
 * @returns the `core` tool definitions.
 */
function coreTools(deps) {
  const config = deps.readConfig()
  return [
    textTool(deps, {
      name: EXPLORE_TOOL,
      description: EXPLORE_DESCRIPTION,
      // One call may carry a first index, whose budget is the wider `index` one;
      // the tool's own timeout has to admit both, or the harness kills the call
      // while `init` is still legitimately running.
      timeoutMs:
        (config.autoIndex === true ? config.exploreTimeoutSec + config.indexTimeoutSec : config.exploreTimeoutSec) * 1_000,
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'A natural-language question, or the symbol/file names to explore.',
        },
        path: {
          type: 'string',
          description: 'Project directory. Defaults to the session workspace.',
        },
        maxFiles: {
          type: 'integer',
          description: 'Cap on how many files contribute source to the answer.',
        },
      },
      buildArgs: (args, root) => [
        'explore',
        args.query,
        '-p',
        root,
        ...(args.maxFiles === undefined ? [] : ['--max-files', String(args.maxFiles)]),
      ],
    }),
    textTool(deps, {
      name: INDEX_TOOL,
      description: INDEX_DESCRIPTION,
      timeoutMs: config.indexTimeoutSec * 1_000,
      strict: true,
      parameters: {
        operation: {
          type: 'string',
          required: true,
          enum: ['init', 'sync', 'index'],
          description: 'init = first index, sync = incremental, index = full rebuild.',
        },
        path: {
          type: 'string',
          description: 'Project directory. Defaults to the session workspace.',
        },
        force: {
          type: 'boolean',
          description: 'Only for operation=index: permit a rebuild at a home or root directory. init never forces.',
        },
      },
      buildArgs: (args, root) => {
        if (args.operation === 'init') {
          assertIndexableTarget(root)
          // `-y` is required: without it `codegraph init` blocks on an interactive
          // prompt that a piped stdio can never answer.
          return ['init', '-y', root]
        }
        if (args.operation === 'sync') return ['sync', '-q', root]
        return ['index', ...(args.force === true ? ['--force'] : []), '-q', root]
      },
    }),
  ]
}

/**
 * The eight narrow commands `full` adds. Everything they return already arrives
 * inline on `explore`; they exist for deployments that want narrower, more
 * precise tools.
 *
 * @param deps - the plugin context and the live configuration thunk.
 * @returns the additional tool definitions.
 */
function fullTools(deps) {
  const config = deps.readConfig()
  const budget = config.exploreTimeoutSec * 1_000
  const pathArg = {
    type: 'string',
    description: 'Project directory. Defaults to the session workspace.',
  }
  const jsonParam = {
    type: 'boolean',
    description: 'Return the CLI JSON payload instead of prose.',
  }
  /** @param fallback - the CLI's own default, restated so the model knows the trade. */
  const limitArg = (fallback) => ({
    type: 'integer',
    description: `Maximum results (the CLI defaults to ${fallback}).`,
  })

  /** @param args - validated arguments; @param root - the resolved project directory. @returns the shared `-p`/`-j` tail. */
  const shared = (args, root) => ['-p', root, ...(args.json === true ? ['-j'] : [])]

  return [
    textTool(deps, {
      name: 'codegraph_node',
      description:
        "One symbol's source plus its caller/callee trail, or one file's line-numbered contents plus its dependents. `file` switches to file mode.",
      timeoutMs: budget,
      parameters: {
        name: { type: 'string', description: 'The symbol to inspect.' },
        file: { type: 'string', description: 'File mode: show this file instead of a symbol.' },
        offset: { type: 'integer', description: 'File mode: 1-based first line.' },
        limit: { type: 'integer', description: 'File mode: maximum lines.' },
        path: pathArg,
      },
      buildArgs: (args, root) => [
        'node',
        ...(args.name === undefined ? [] : [args.name]),
        '-p',
        root,
        ...(args.file === undefined ? [] : ['-f', args.file]),
        ...(args.offset === undefined ? [] : ['--offset', String(args.offset)]),
        ...(args.limit === undefined ? [] : ['--limit', String(args.limit)]),
      ],
    }),
    textTool(deps, {
      name: 'codegraph_query',
      description: 'Search the index for symbols by name.',
      timeoutMs: budget,
      strict: true,
      parameters: {
        search: { type: 'string', required: true, description: 'The name or fragment to search for.' },
        kind: { type: 'string', description: 'Restrict to a node kind (function, class, …).' },
        limit: limitArg(10),
        path: pathArg,
        json: jsonParam,
      },
      buildArgs: (args, root) => [
        'query',
        args.search,
        ...(args.kind === undefined ? [] : ['-k', args.kind]),
        ...(args.limit === undefined ? [] : ['-l', String(args.limit)]),
        ...shared(args, root),
      ],
    }),
    textTool(deps, {
      name: 'codegraph_callers',
      description: 'Find every function or method that calls a symbol.',
      timeoutMs: budget,
      strict: true,
      parameters: {
        symbol: { type: 'string', required: true, description: 'The called symbol.' },
        limit: limitArg(20),
        path: pathArg,
        json: jsonParam,
      },
      buildArgs: (args, root) => [
        'callers',
        args.symbol,
        ...(args.limit === undefined ? [] : ['-l', String(args.limit)]),
        ...shared(args, root),
      ],
    }),
    textTool(deps, {
      name: 'codegraph_callees',
      description: 'Find every function or method a symbol calls.',
      timeoutMs: budget,
      strict: true,
      parameters: {
        symbol: { type: 'string', required: true, description: 'The calling symbol.' },
        limit: limitArg(20),
        path: pathArg,
        json: jsonParam,
      },
      buildArgs: (args, root) => [
        'callees',
        args.symbol,
        ...(args.limit === undefined ? [] : ['-l', String(args.limit)]),
        ...shared(args, root),
      ],
    }),
    textTool(deps, {
      name: 'codegraph_impact',
      description: 'Analyse what code is affected by changing a symbol, to a traversal depth.',
      timeoutMs: budget,
      strict: true,
      parameters: {
        symbol: { type: 'string', required: true, description: 'The symbol being changed.' },
        depth: { type: 'integer', description: 'Traversal depth (the CLI defaults to 2).' },
        path: pathArg,
        json: jsonParam,
      },
      buildArgs: (args, root) => [
        'impact',
        args.symbol,
        ...(args.depth === undefined ? [] : ['-d', String(args.depth)]),
        ...shared(args, root),
      ],
    }),
    textTool(deps, {
      name: 'codegraph_affected',
      description: 'Find the test files affected by a set of changed source files.',
      timeoutMs: budget,
      strict: true,
      parameters: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Changed source files, relative to the project root.',
        },
        depth: { type: 'integer', description: 'Maximum dependency depth (the CLI defaults to 5).' },
        filter: { type: 'string', description: 'Glob selecting which files count as tests.' },
        path: pathArg,
        json: jsonParam,
      },
      buildArgs: (args, root) => [
        'affected',
        ...(args.files ?? []),
        ...(args.depth === undefined ? [] : ['-d', String(args.depth)]),
        ...(args.filter === undefined ? [] : ['-f', args.filter]),
        ...shared(args, root),
      ],
    }),
    textTool(deps, {
      name: 'codegraph_files',
      description: 'Show the project file structure recorded in the index.',
      timeoutMs: budget,
      strict: true,
      parameters: {
        filter: { type: 'string', description: 'Restrict to files under this directory.' },
        pattern: { type: 'string', description: 'Restrict to files matching this glob.' },
        format: {
          type: 'string',
          enum: ['tree', 'flat', 'grouped'],
          description: 'Rendering (the CLI defaults to tree).',
        },
        maxDepth: { type: 'integer', description: 'Maximum directory depth, for tree format.' },
        path: pathArg,
        json: jsonParam,
      },
      buildArgs: (args, root) => [
        'files',
        ...(args.filter === undefined ? [] : ['--filter', args.filter]),
        ...(args.pattern === undefined ? [] : ['--pattern', args.pattern]),
        ...(args.format === undefined ? [] : ['--format', args.format]),
        ...(args.maxDepth === undefined ? [] : ['--max-depth', String(args.maxDepth)]),
        ...shared(args, root),
      ],
    }),
    textTool(deps, {
      name: 'codegraph_status',
      description: 'Report index health and statistics for a project.',
      timeoutMs: budget,
      strict: true,
      parameters: { path: pathArg, json: jsonParam },
      buildArgs: (args, root) => ['status', root, ...(args.json === true ? ['-j'] : [])],
    }),
  ]
}

/**
 * Extract the human prompt text a step carries, or undefined when the step has
 * none of its own.
 *
 * Only messages whose source is `user` count: the loop's runtime-context
 * snapshot and this plugin's own earlier injections arrive on the same channel,
 * and re-triggering on those would let the feature feed itself.
 *
 * @param messages - the messages claimed for this step.
 * @returns the joined prompt text, or undefined.
 */
function newUserPromptText(messages) {
  const parts = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user') continue
    if (message.source?.kind !== 'user') continue
    for (const block of message.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  const text = parts.join('\n').trim()
  return text === '' ? undefined : text
}

/**
 * Extract the `<codegraph_context>` block from the hook's stdout.
 * @param stdout - the hook's captured stdout.
 * @returns the block's inner text, or undefined when the hook stayed silent.
 */
function extractContextBlock(stdout) {
  const match = /<codegraph_context>([\s\S]*?)<\/codegraph_context>/u.exec(stdout)
  const text = match?.[1]?.trim()
  return text === undefined || text === '' ? undefined : text
}

/**
 * B2: dynamic pre-step injection.
 *
 * Owns the state that must outlive a settings change — the dedupe table and the
 * circuit breaker — and attaches a listener whose lifetime follows `frontload`.
 *
 * The hook's own contract is "any failure exits 0 with no output", so silence is
 * the designed normal path and never worth surfacing. A *real* failure means the
 * runtime is gone; after two of those the feature retires for this process
 * instead of paying its budget on every prompt.
 *
 * @param ctx - the plugin context.
 * @param readConfig - thunk returning the currently authoritative configuration.
 * @returns an attach function taking the disposer list to append to.
 */
function createFrontload(ctx, readConfig) {
  /** prompt text → expiry, bounding re-injection on GUI resend and turn re-entry. */
  const seen = new Map()
  let failures = 0
  let tripped = false

  /** @param prompt - the prompt text to test. @returns true when it was already handled. */
  function isDuplicate(prompt) {
    const now = Date.now()
    for (const [key, expiry] of seen) {
      if (expiry <= now) seen.delete(key)
    }
    if (seen.has(prompt)) return true
    if (seen.size >= FRONTLOAD_DEDUPE_MAX) seen.delete(seen.keys().next().value)
    seen.set(prompt, now + FRONTLOAD_DEDUPE_TTL_MS)
    return false
  }

  return (owned) => {
    owned.push(
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (tripped || decision.kind !== 'enter') return decision
        if (payload.messages.length === 0) return decision

        const prompt = newUserPromptText(payload.messages)
        if (prompt === undefined || isDuplicate(prompt)) return decision

        const cwd = payload.agent?.session?.header?.cwd
        if (typeof cwd !== 'string' || cwd === '' || !isIndexed(cwd)) return decision

        let stdout
        try {
          const result = await runCodegraph({
            ctx,
            config: readConfig(),
            cwd,
            args: ['prompt-hook'],
            stdinData: JSON.stringify({ prompt, cwd }),
            budgetMs: FRONTLOAD_BUDGET_MS,
            label: 'codegraph prompt-hook',
          })
          stdout = result.stdout
        } catch {
          failures += 1
          if (failures >= FRONTLOAD_MAX_FAILURES) tripped = true
          return decision
        }

        const text = extractContextBlock(stdout)
        if (text === undefined) return decision
        failures = 0
        return {
          ...decision,
          // Appended, never substituted: the default decision already carries the
          // loop's runtime-context snapshot, and replacing the list would drop it.
          messages: [
            ...decision.messages,
            createUserMessage({
              content: [{ type: 'text', text: text.slice(0, FRONTLOAD_MAX_CHARS) }],
              source: { kind: 'plugin', plugin: 'codegraph' },
            }),
          ],
        }
      }),
    )
  }
}

/**
 * Resolve the guide's placement before the tool sections.
 *
 * Resolved, never hard-coded: the first-party layout is versioned by the package
 * that owns it, and a bare number would silently drift out from under the guide.
 *
 * @param ctx - the plugin context.
 * @returns the section order.
 */
function sectionOrder(ctx) {
  try {
    const bashOrder = ctx.systemPrompt.getSectionOrder('TOOL_BASH')
    if (Number.isFinite(bashOrder)) return bashOrder - SECTION_ORDER_OFFSET
  } catch {
    // The placement name moved; the fallback keeps the guide in a sensible band.
  }
  return FALLBACK_SECTION_ORDER
}

/**
 * Reject a configuration the rest of the plugin cannot honour, at the write that
 * produced it.
 *
 * `defineTool` throws on a non-positive `timeoutMs`, and settings are hot — a
 * stored `0` would otherwise turn a live edit into a registration crash.
 *
 * @param value - the schema-valid resolved configuration.
 * @throws {Error} when a bound is unusable.
 */
function assertUsableConfig(value) {
  for (const field of ['exploreTimeoutSec', 'indexTimeoutSec']) {
    if (!Number.isInteger(value[field]) || value[field] <= 0) {
      throw new Error(`${SETTINGS_NAMESPACE}: ${field} must be a positive whole number of seconds`)
    }
  }
  if (!Number.isInteger(value.autoIndexMaxFiles) || value.autoIndexMaxFiles < 1) {
    throw new Error(`${SETTINGS_NAMESPACE}: autoIndexMaxFiles must be a positive whole number of files`)
  }
}

/**
 * Gate index-building behind a one-shot user approval.
 *
 * `ask` routes through the approval service, which fails closed when no answerer
 * is composed — a deliberate refusal rather than a silent whole-repo index.
 *
 * @param ctx - the plugin context.
 */
function registerIndexApproval(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== INDEX_TOOL) return next()
    const operation = exec.arguments?.operation
    if (operation !== 'init' && operation !== 'index') return next()
    const target = typeof exec.arguments?.path === 'string' ? ` for ${exec.arguments.path}` : ' for the session workspace'
    const verb = operation === 'init' ? 'build a first CodeGraph index' : 'rebuild the whole CodeGraph index'
    return {
      kind: 'ask',
      reason: `CodeGraph: ${verb}${target}. This parses the project and writes \`.codegraph/\`, which can take a while on a large repository.`,
    }
  })
}

/**
 * Register everything the plugin owns, deriving what it registers from the
 * currently authoritative configuration.
 *
 * Re-derived as a unit on every settings change: the surface and the two
 * timeouts are baked into tool definitions, so those must be re-registered, while
 * the guide section and the pre-step listener are added or removed. Disposing
 * what this function owns before re-deriving is what keeps the duplicate-name and
 * duplicate-tool errors from firing.
 *
 * @param ctx - the plugin context.
 * @param readConfig - thunk returning the currently authoritative configuration.
 * @returns a function that rebuilds every derived registration.
 */
function createDerivedRegistrations(ctx, readConfig) {
  const owned = []
  const deps = { ctx, readConfig }
  // One bootstrap per registration set, so parallel queries share its in-flight table.
  deps.autoIndex = createAutoIndex(deps)
  const frontload = createFrontload(ctx, readConfig)
  /** Fingerprint of the configuration the current registrations were built from. */
  let appliedKey

  return () => {
    // A settings provider attaches asynchronously, so the entry config is used
    // once and the resolved value once more shortly after. Re-deriving is only
    // worth doing when the effective configuration actually differs.
    const key = JSON.stringify(readConfig())
    if (key === appliedKey) return
    appliedKey = key

    while (owned.length > 0) owned.pop()()

    const config = readConfig()
    if (config.guide === true) {
      owned.push(
        ctx.systemPrompt.section({
          name: SECTION_NAME,
          order: sectionOrder(ctx),
          text: CODEGRAPH_GUIDE,
        }),
      )
    }

    const definitions = config.surface === 'full' ? [...coreTools(deps), ...fullTools(deps)] : coreTools(deps)
    for (const definition of definitions) {
      owned.push(ctx.tools.register(definition))
    }

    if (config.frontload === true) frontload(owned)
  }
}

/**
 * Compose the plugin: settings wiring first, so the derived registrations are
 * built from the resolved value rather than the composition entry.
 *
 * @param ctx - the plugin context.
 * @param entry - the composition entry from `cordis.patch.yml`.
 */
export function apply(ctx, entry) {
  const state = { read: () => entry }
  const readConfig = () => state.read()
  const rebuild = createDerivedRegistrations(ctx, readConfig)

  // `setSource` and `onChange` both fire when a provider attaches, which happens
  // after `apply` returns; the fallback below covers deployments with no provider
  // at all, and the fingerprint inside `rebuild` keeps the two from double work.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, entry, {
      setSource: (current) => {
        state.read = current
      },
      onChange: () => {
        rebuild()
      },
      validate: assertUsableConfig,
    })
  })

  // Registered once: the gate reads the call, not the configuration.
  registerIndexApproval(ctx)

  // Without a settings provider nothing above ever runs, so the entry config stands alone.
  rebuild()
}
