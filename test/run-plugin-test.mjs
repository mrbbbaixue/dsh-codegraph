/**
 * Runtime harness for `@mrbbbaixue/dsh-codegraph`.
 *
 * Deliberately dependency-free — no test framework, no `which`, no `/bin/bash` —
 * so the same command runs on Windows and POSIX. It exercises the real plugin
 * module, the real runner, and (when a `codegraph` runtime is present) the real
 * CLI against a fixture this file creates and removes itself.
 *
 * Run: `node test/run-plugin-test.mjs` (or `npm test`).
 *
 * @module @mrbbbaixue/dsh-codegraph/test
 */

import assert from 'node:assert/strict'
import { spawn as nodeSpawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const runnerUrl = pathToFileURL(join(here, '..', 'lib', 'runner.js')).href
const plugin = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const runner = await import(runnerUrl)

const TOOL_READ_ORDER = 1100

const results = []
let currentSection = ''

/** @param label - the section header to print before the next group of tests. */
function section(label) {
  currentSection = label
  process.stdout.write(`\n${label}\n`)
}

/**
 * Run one test, recording pass/fail instead of aborting the run.
 * @param label - what the test proves.
 * @param body - the test body; may be async.
 */
async function test(label, body) {
  try {
    await body()
    results.push({ section: currentSection, label, ok: true })
    process.stdout.write(`  ok   ${label}\n`)
  } catch (error) {
    results.push({ section: currentSection, label, ok: false, error })
    process.stdout.write(`  FAIL ${label}\n       ${error?.message ?? error}\n`)
  }
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * A subprocess service backed by `node:child_process`, standing in for
 * `@deepseek-ai/dsh-subprocess-local` outside a dsh process.
 *
 * Real processes, not mocks: the fixture section asserts on what the CLI
 * actually printed.
 *
 * @returns a minimal `ctx.subprocess` implementation.
 */
function createLocalSubprocess() {
  return {
    /** @param command - bare name or absolute path. @returns the resolved absolute path. */
    async resolveExecutable(command) {
      return resolveOnPath(command)
    },
    /**
     * @param spec - the spawn request.
     * @returns a handle shaped like the seam's.
     */
    spawn(spec) {
      const stdinMode = spec.stdio.stdin
      const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        stdio: [stdinMode === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...spec.env },
        windowsHide: true,
      })
      if (stdinMode !== 'ignore' && typeof stdinMode === 'object') {
        child.stdin.end(stdinMode.data)
      }
      /** @type {Buffer[]} */
      const errChunks = []
      let errBytes = 0
      child.stderr.on('data', (chunk) => {
        if (errBytes >= 16_000) return
        errChunks.push(chunk)
        errBytes += chunk.length
      })
      const done = new Promise((settle, fail) => {
        child.on('error', fail)
        child.on('close', (exitCode, signal) => settle({ exitCode, signal }))
      })
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        collected: {
          stderr: {
            readFrom: () => ({ text: Buffer.concat(errChunks, errBytes).toString('utf8'), nextOffset: errBytes, lossy: false }),
          },
        },
        done,
        terminate: () => child.kill(),
        waitForExit: () => done.then(() => true, () => true),
      }
    },
  }
}

/**
 * A subprocess service that answers every spawn from a scripted plan.
 * @param plan - maps a spawn spec to `{ stdout, stderr, exitCode, delayMs }`.
 * @returns the service plus a mutable call log.
 */
function createScriptedSubprocess(plan) {
  const calls = []
  return {
    calls,
    async resolveExecutable() {
      throw new Error('scripted subprocess: no PATH resolution')
    },
    spawn(spec) {
      calls.push(spec)
      const answer = plan(spec)
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      stdout.end(answer.stdout ?? '')
      stderr.end(answer.stderr ?? '')
      stderr.resume()
      const outcome = once(stdout, 'end').then(() => ({ exitCode: answer.exitCode ?? 0, signal: null }))
      return {
        stdin: undefined,
        stdout,
        stderr,
        collected: {
          stderr: { readFrom: () => ({ text: answer.stderr ?? '', nextOffset: 0, lossy: false }) },
        },
        done: outcome,
        terminate: () => {},
        waitForExit: async () => true,
      }
    },
  }
}

/**
 * Resolve an executable name against `PATH`, honouring `PATHEXT` on Windows.
 * @param command - bare name or absolute path.
 * @returns the resolved path.
 * @throws when nothing matches.
 */
function resolveOnPath(command) {
  if (existsSync(command)) return command
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : ['']
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (entry === '') continue
    for (const extension of extensions) {
      const candidate = join(entry, `${command}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error(`not found on PATH: ${command}`)
}

/**
 * A stand-in for the plugin-host context: only the members the plugin actually
 * touches, with registrations recorded for assertions.
 *
 * @param options - `settings` supplies a resolved settings section; `subprocess` overrides the process runner.
 * @returns the stub context and its recorded state.
 */
function createStubContext(options = {}) {
  const record = {
    tools: new Map(),
    sections: [],
    listeners: new Map(),
    registeredSettings: undefined,
    settingsSource: undefined,
    settingsHooks: undefined,
  }

  const ctx = {
    subprocess: options.subprocess ?? {
      resolveExecutable: async () => {
        throw new Error('no executable')
      },
    },
    systemPrompt: {
      /** @param promptSection - the section to register. @returns its disposer. */
      section(promptSection) {
        record.sections.push(promptSection)
        if (new Set(record.sections.map((entry) => entry.name)).size !== record.sections.length) {
          throw new Error(`dup section ${promptSection.name}`)
        }
        return () => {
          const index = record.sections.indexOf(promptSection)
          if (index >= 0) record.sections.splice(index, 1)
        }
      },
      /** @param _name - the placement name; this stub only knows the real layout. */
      getSectionOrder(_name) {
        if (options.sectionOrder === 'missing') throw new Error('unknown placement name')
        return options.sectionOrder ?? 1000
      },
    },
    tools: {
      /** @param definition - the tool to register. */
      register(definition) {
        if (record.tools.has(definition.name)) throw new Error(`dup tool ${definition.name}`)
        record.tools.set(definition.name, definition)
        return () => record.tools.delete(definition.name)
      },
      /** @param toolName - the tool name. */
      get(toolName) {
        return record.tools.get(toolName)
      },
    },
    /** @param event - the event name. @param listener - the listener. */
    on(event, listener) {
      record.listeners.set(event, listener)
      return () => record.listeners.delete(event)
    },
    /** @param deps - requested services. @param callback - the consumer. */
    inject(deps, callback) {
      if (!deps.includes('settings') || options.settings === undefined) return
      callback({
        settings: {
          /** @param _owner - consumer context. @param ns - namespace. @param schema - namespace schema. @param _entry - composition entry. @param hooks - owner hooks. */
          installSection(_owner, ns, schema, _entry, hooks) {
            record.registeredSettings = { ns, schema }
            record.settingsHooks = hooks
            let value = options.settings
            hooks.setSource(() => value)
            hooks.onChange()
            record.applySettings = (next) => {
              value = next
              hooks.setSource(() => value)
              hooks.onChange()
            }
          },
        },
      })
    },
    get(member) {
      return this[member]
    },
  }

  return { ctx, record }
}

/**
 * The `exec` argument a tool receives.
 * @param cwd - the session workspace.
 * @returns a tool-run context.
 */
function executionFor(cwd) {
  return {
    callId: 'call-1',
    name: 'stub',
    arguments: {},
    signal: new AbortController().signal,
    agent: { session: { header: { cwd } } },
  }
}

// ---------------------------------------------------------------------------
// Structural contracts
// ---------------------------------------------------------------------------

section('Structural contracts')

await test('core surface registers exactly explore + index', async () => {
  const { ctx, record } = createStubContext()
  plugin.apply(ctx, plugin.Config({}))
  assert.deepEqual([...record.tools.keys()].sort(), ['codegraph_explore', 'codegraph_index'])
})

await test('full surface registers all ten tools', async () => {
  const { ctx, record } = createStubContext()
  plugin.apply(ctx, plugin.Config({ surface: 'full' }))
  assert.equal(record.tools.size, 10)
  assert.deepEqual([...record.tools.keys()].sort(), [
    'codegraph_affected',
    'codegraph_callees',
    'codegraph_callers',
    'codegraph_explore',
    'codegraph_files',
    'codegraph_impact',
    'codegraph_index',
    'codegraph_node',
    'codegraph_query',
    'codegraph_status',
  ])
})

await test('full is a superset of core, not a replacement', async () => {
  const core = createStubContext()
  plugin.apply(core.ctx, plugin.Config({}))
  const full = createStubContext()
  plugin.apply(full.ctx, plugin.Config({ surface: 'full' }))
  for (const toolName of core.record.tools.keys()) {
    assert.ok(full.record.tools.has(toolName), `${toolName} missing from the full surface`)
  }
})

await test('every tool declares a positive finite timeoutMs', async () => {
  const { ctx, record } = createStubContext()
  plugin.apply(ctx, plugin.Config({ surface: 'full' }))
  for (const [toolName, definition] of record.tools) {
    assert.ok(Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0, `${toolName} has no usable timeoutMs`)
  }
})

await test('every tool renders a text block from its string value', async () => {
  const { ctx, record } = createStubContext()
  plugin.apply(ctx, plugin.Config({ surface: 'full' }))
  for (const [toolName, definition] of record.tools) {
    const blocks = definition.output.render({}, 'sample')
    assert.equal(blocks.length, 1, `${toolName} render`)
    assert.equal(blocks[0].type, 'text', `${toolName} render block type`)
    assert.equal(blocks[0].text, 'sample', `${toolName} render text`)
  }
})

await test('the guide section lands before TOOL_READ', async () => {
  const { ctx, record } = createStubContext()
  plugin.apply(ctx, plugin.Config({}))
  assert.equal(record.sections.length, 1)
  assert.equal(record.sections[0].name, 'tool:codegraph')
  assert.ok(record.sections[0].order < TOOL_READ_ORDER, `order ${record.sections[0].order} is not before TOOL_READ`)
  assert.ok(record.sections[0].text.length > 500, 'the guide text looks empty')
})

await test('an unresolvable placement name falls back to a constant order', async () => {
  const { ctx, record } = createStubContext({ sectionOrder: 'missing' })
  plugin.apply(ctx, plugin.Config({}))
  assert.equal(record.sections[0].order, 990)
})

await test('guide:false registers no section', async () => {
  const { ctx, record } = createStubContext()
  plugin.apply(ctx, plugin.Config({ guide: false }))
  assert.equal(record.sections.length, 0)
  assert.equal(record.tools.size, 2, 'turning the guide off must not touch the tool surface')
})

await test('frontload:false registers no pre-step listener', async () => {
  const { ctx, record } = createStubContext()
  plugin.apply(ctx, plugin.Config({ frontload: false }))
  assert.equal(record.listeners.has('agent/pre-step'), false)
})

await test('frontload:true registers a pre-step listener', async () => {
  const { ctx, record } = createStubContext()
  plugin.apply(ctx, plugin.Config({}))
  assert.ok(record.listeners.has('agent/pre-step'))
})

await test('the index approval gate is registered regardless of config', async () => {
  const { ctx, record } = createStubContext()
  plugin.apply(ctx, plugin.Config({ guide: false, frontload: false }))
  assert.ok(record.listeners.has('tools/pre-execute'))
})

await test('the gate asks for init and index, and lets sync through', async () => {
  const { ctx, record } = createStubContext()
  plugin.apply(ctx, plugin.Config({}))
  const gate = record.listeners.get('tools/pre-execute')
  const next = async () => ({ kind: 'allow' })

  for (const operation of ['init', 'index']) {
    const decision = await gate({ name: 'codegraph_index', arguments: { operation } }, next)
    assert.equal(decision.kind, 'ask', `${operation} should ask`)
  }
  assert.equal((await gate({ name: 'codegraph_index', arguments: { operation: 'sync' } }, next)).kind, 'allow')
  assert.equal((await gate({ name: 'codegraph_explore', arguments: {} }, next)).kind, 'allow')
  assert.equal((await gate({ name: 'bash', arguments: { operation: 'init' } }, next)).kind, 'allow', 'other tools must pass')
})

await test('the settings namespace is registered with a schema', async () => {
  const { ctx, record } = createStubContext({ settings: plugin.Config({}) })
  plugin.apply(ctx, plugin.Config({}))
  assert.equal(record.registeredSettings.ns, plugin.SETTINGS_NAMESPACE)
  assert.equal(plugin.SETTINGS_NAMESPACE, 'dsh-codegraph')
  assert.ok(record.registeredSettings.schema !== undefined)
})

await test('a settings change re-derives the whole surface without duplicate errors', async () => {
  const { ctx, record } = createStubContext({ settings: plugin.Config({}) })
  plugin.apply(ctx, plugin.Config({}))
  assert.equal(record.tools.size, 2)

  record.applySettings(plugin.Config({ surface: 'full', guide: false }))
  assert.equal(record.tools.size, 10, 'surface should follow the settings value')
  assert.equal(record.sections.length, 0, 'guide should follow the settings value')

  record.applySettings(plugin.Config({ surface: 'core', guide: true }))
  assert.equal(record.tools.size, 2)
  assert.equal(record.sections.length, 1)
})

await test('an unusable timeout is refused at the write, not at registration', async () => {
  const { ctx, record } = createStubContext({ settings: plugin.Config({}) })
  plugin.apply(ctx, plugin.Config({}))
  assert.throws(() => record.settingsHooks.validate({ exploreTimeoutMs: 0, indexTimeoutMs: 1 }), /positive/)
  assert.throws(() => record.settingsHooks.validate({ exploreTimeoutMs: 1, indexTimeoutMs: -5 }), /positive/)
  assert.doesNotThrow(() => record.settingsHooks.validate({ exploreTimeoutMs: 1, indexTimeoutMs: 1 }))
})

// ---------------------------------------------------------------------------
// Runner: resolution and the Windows branch
// ---------------------------------------------------------------------------

section('Runner')

await test('a configured absolute path that does not exist fails loudly', async () => {
  const { ctx } = createStubContext()
  await assert.rejects(
    runner.runCodegraph({ ctx, config: plugin.Config({ executable: join(tmpdir(), 'no-such-codegraph') }), cwd: process.cwd(), args: ['--version'], label: 'codegraph test' }),
    /does not exist/u,
  )
})

await test('a .cmd launcher is never handed to spawn as argv[0]', async () => {
  const launcher = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? 'C:\\Users\\none\\AppData\\Local', 'codegraph', 'current', 'bin', 'codegraph.cmd')
    : '/usr/local/bin/codegraph.cmd'
  const scripted = createScriptedSubprocess(() => ({ stdout: 'ok' }))
  const { ctx } = createStubContext({ subprocess: scripted })

  try {
    const result = await runner.runCodegraph({
      ctx,
      config: plugin.Config({ executable: launcher }),
      cwd: process.cwd(),
      args: ['--version'],
      label: 'codegraph test',
    })
    assert.equal(result.stdout.trim(), 'ok')
    assert.equal(scripted.calls.length, 1)
    assert.equal(/\.cmd$/iu.test(scripted.calls[0].argv[0]), false, `spawned a .cmd directly: ${scripted.calls[0].argv[0]}`)
    assert.equal(scripted.calls[0].argv[0].endsWith('node.exe'), true, 'expected the bundled node executable')
    assert.ok(scripted.calls[0].argv.includes('--liftoff-only'), 'expected the launcher V8 flag')
  } catch (error) {
    // A machine with no self-contained install must fail loudly, never by
    // handing the .cmd to spawn.
    assert.match(String(error.message), /EINVAL|refuses to spawn|no node\.exe/u)
  }
})

await test('an unresolvable executable fails with a readable message', async () => {
  // Deterministic regardless of what this machine has installed: the probe runs
  // in a child process whose home and LOCALAPPDATA point at an empty directory,
  // so no self-contained install can be discovered.
  const scratch = mkdtempSync(join(tmpdir(), 'cg-noenv-'))
  try {
    const script = [
      `import { resolveCommand } from ${JSON.stringify(runnerUrl)}`,
      `const ctx = { subprocess: { resolveExecutable: async () => { throw new Error('absent') } } }`,
      `try {`,
      `  const command = await resolveCommand({ ctx, config: { executable: 'codegraph' }, cwd: process.cwd() })`,
      `  console.log('RESOLVED ' + command.display)`,
      `} catch (error) { console.log('ERROR ' + error.message) }`,
    ].join('\n')
    const child = nodeSpawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, LOCALAPPDATA: scratch, USERPROFILE: scratch, HOME: scratch, PATH: '' },
      windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    await once(child, 'close')
    assert.match(output, /^ERROR .*codegraph could not be found/su, `unexpected probe output: ${output}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

// `executable` is absolute and authoritative, so point it at a real file; the
// scripted service answers the spawn either way.
const ANY_EXECUTABLE = { executable: process.execPath }

await test('a non-zero exit surfaces the CLI own words', async () => {
  const scripted = createScriptedSubprocess(() => ({ stdout: '', stderr: 'CodeGraph not initialized in /tmp/x', exitCode: 1 }))
  const { ctx } = createStubContext({ subprocess: scripted })
  await assert.rejects(
    runner.runCodegraph({ ctx, config: plugin.Config(ANY_EXECUTABLE), cwd: process.cwd(), args: ['sync'], label: 'codegraph sync' }),
    /CodeGraph not initialized/u,
  )
})

await test('a budget expiry terminates the process and does not wait for the grace period', async () => {
  let terminated = false
  const ctx = {
    subprocess: {
      resolveExecutable: async () => {
        throw new Error('no executable')
      },
      spawn: () => ({
        stdin: undefined,
        // Never ends: only the budget can settle this run.
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        collected: { stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
        done: new Promise(() => {}),
        terminate: () => {
          terminated = true
        },
        waitForExit: async () => true,
      }),
    },
  }
  const started = Date.now()
  await assert.rejects(
    runner.runCodegraph({ ctx, config: plugin.Config(ANY_EXECUTABLE), cwd: process.cwd(), args: ['prompt-hook'], budgetMs: 60, label: 'codegraph prompt-hook' }),
    /did not finish within 60 ms/u,
  )
  assert.equal(terminated, true, 'the managed range was left running')
  assert.ok(Date.now() - started < 2_000, 'the budget did not bound the wait')
})

await test('resolveRoot refuses to guess when the session has no cwd', () => {
  assert.throws(() => runner.resolveRoot({ agent: { session: { header: {} } } }, undefined), /no workspace directory/u)
  assert.throws(() => runner.resolveRoot({}, undefined), /no workspace directory/u)
  assert.throws(() => runner.resolveRoot({ agent: { session: { header: { cwd: tmpdir() } } } }, '/definitely/not/here'), /not an existing directory/u)
})

await test('resolveRoot prefers the explicit path over the session cwd', () => {
  const root = runner.resolveRoot({ agent: { session: { header: { cwd: process.cwd() } } } }, tmpdir())
  assert.equal(root, resolve(tmpdir()))
})

await test('an unindexed directory reports no index root', () => {
  const bare = mkdtempSync(join(tmpdir(), 'cg-unindexed-'))
  try {
    assert.equal(runner.isIndexed(bare), false)
    assert.equal(runner.findIndexRoot(bare), undefined)
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// B2: dynamic pre-step injection
// ---------------------------------------------------------------------------

section('B2 frontload')

/**
 * Drive the registered pre-step listener with a scripted hook answer.
 * @param options - `plan` scripts the hook, `steps` are the listener invocations to make.
 * @returns the decisions and the spawn log.
 */
async function driveFrontload(options) {
  const scripted = createScriptedSubprocess(options.plan)
  const { ctx, record } = createStubContext({ subprocess: scripted })
  plugin.apply(ctx, plugin.Config(options.config))

  const indexRoot = mkdtempSync(join(tmpdir(), 'cg-indexed-'))
  mkdirSync(join(indexRoot, '.codegraph'), { recursive: true })
  writeFileSync(join(indexRoot, '.codegraph', 'codegraph.db'), '')

  const listener = record.listeners.get('agent/pre-step')
  const decisions = []
  const runtimeContext = { role: 'user', content: [{ type: 'text', text: 'runtime snapshot' }], source: { kind: 'plugin', plugin: 'agent-loop' } }
  const next = async () => ({ kind: 'enter', messages: [runtimeContext] })

  for (const prompt of options.prompts ?? []) {
    decisions.push(
      await listener(
        {
          agent: { session: { header: { cwd: indexRoot } } },
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: prompt }],
              source: { kind: 'user' },
            },
          ],
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        next,
      ),
    )
  }
  rmSync(indexRoot, { recursive: true, force: true })
  return { decisions, scripted, runtimeContext }
}

await test('a structural prompt gets the hook context appended', async () => {
  const { decisions, runtimeContext } = await driveFrontload({
    plan: () => ({ stdout: '<codegraph_context>relevant source here</codegraph_context>' }),
    prompts: ['dsh-codegraph 插件的 runner 是怎么解析可执行文件的'],
  })
  const decision = decisions[0]
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0], runtimeContext, 'the loop runtime-context snapshot was dropped')
  assert.equal(decision.messages[1].content[0].text, 'relevant source here')
  assert.equal(decision.messages[1].source.kind, 'plugin')
  assert.equal(decision.messages[1].source.plugin, 'codegraph')
  assert.equal(typeof decision.messages[1].id, 'string')
})

await test('the injected message never claims to come from the user', async () => {
  const { decisions } = await driveFrontload({
    plan: () => ({ stdout: '<codegraph_context>x</codegraph_context>' }),
    prompts: ['how does the index lifecycle work'],
  })
  assert.notEqual(decisions[0].messages[1].source.kind, 'user')
})

await test('a silent hook injects nothing', async () => {
  const { decisions } = await driveFrontload({ plan: () => ({ stdout: '' }), prompts: ['just chatting, nothing to look up'] })
  assert.equal(decisions[0].messages.length, 1)
  assert.equal(decisions[0].messages[0].source.kind, 'plugin')
})

await test('the same prompt re-sent is injected only once', async () => {
  const { decisions, scripted } = await driveFrontload({
    plan: () => ({ stdout: '<codegraph_context>x</codegraph_context>' }),
    prompts: ['dsh-codegraph 的解析链', 'dsh-codegraph 的解析链', 'dsh-codegraph 的解析链'],
  })
  assert.equal(scripted.calls.length, 1, 'the hook ran more than once for one prompt')
  assert.equal(decisions[0].messages.length, 2)
  assert.equal(decisions[1].messages.length, 1)
  assert.equal(decisions[2].messages.length, 1)
})

await test('an unindexed workspace stays silent', async () => {
  const scripted = createScriptedSubprocess(() => ({ stdout: '<codegraph_context>x</codegraph_context>' }))
  const { ctx, record } = createStubContext({ subprocess: scripted })
  plugin.apply(ctx, plugin.Config({}))
  const bare = mkdtempSync(join(tmpdir(), 'cg-bare-'))
  try {
    const decision = await record.listeners.get('agent/pre-step')(
      {
        agent: { session: { header: { cwd: bare } } },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'anything' }], source: { kind: 'user' } }],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ kind: 'enter', messages: [] }),
    )
    assert.equal(decision.messages.length, 0)
    assert.equal(scripted.calls.length, 0, 'the hook ran against an unindexed workspace')
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
})

await test('the listener never reacts to its own injections or to loop context', async () => {
  const scripted = createScriptedSubprocess(() => ({ stdout: '<codegraph_context>x</codegraph_context>' }))
  const { ctx, record } = createStubContext({ subprocess: scripted })
  plugin.apply(ctx, plugin.Config({}))
  const indexRoot = mkdtempSync(join(tmpdir(), 'cg-self-'))
  mkdirSync(join(indexRoot, '.codegraph'), { recursive: true })
  writeFileSync(join(indexRoot, '.codegraph', 'codegraph.db'), '')
  try {
    const decision = await record.listeners.get('agent/pre-step')(
      {
        agent: { session: { header: { cwd: indexRoot } } },
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'runtime snapshot' }], source: { kind: 'plugin', plugin: 'agent-loop' } },
          { role: 'user', content: [{ type: 'text', text: 'earlier injection' }], source: { kind: 'plugin', plugin: 'codegraph' } },
        ],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ kind: 'enter', messages: [] }),
    )
    assert.equal(decision.messages.length, 0)
    assert.equal(scripted.calls.length, 0, 'a plugin-sourced message triggered the feature')
  } finally {
    rmSync(indexRoot, { recursive: true, force: true })
  }
})

await test('the circuit breaker retires the feature after consecutive failures', async () => {
  const indexed = mkdtempSync(join(tmpdir(), 'cg-breaker-'))
  mkdirSync(join(indexed, '.codegraph'), { recursive: true })
  writeFileSync(join(indexed, '.codegraph', 'codegraph.db'), '')
  try {
    const scripted = createScriptedSubprocess(() => ({ stdout: '', stderr: 'boom', exitCode: 1 }))
    const { ctx, record } = createStubContext({ subprocess: scripted })
    plugin.apply(ctx, plugin.Config({}))
    const listener = record.listeners.get('agent/pre-step')
    const next = async () => ({ kind: 'enter', messages: [] })
    const call = (prompt) =>
      listener(
        {
          agent: { session: { header: { cwd: indexed } } },
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }],
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        next,
      )

    await call('first distinct prompt')
    await call('second distinct prompt')
    assert.equal(scripted.calls.length, 2)
    await call('third distinct prompt')
    assert.equal(scripted.calls.length, 2, 'the breaker did not stop a third attempt')
  } finally {
    rmSync(indexed, { recursive: true, force: true })
  }
})

await test('frontload:false never runs the hook', async () => {
  const scripted = createScriptedSubprocess(() => ({ stdout: '<codegraph_context>x</codegraph_context>' }))
  const { ctx, record } = createStubContext({ subprocess: scripted })
  plugin.apply(ctx, plugin.Config({ frontload: false }))
  assert.equal(record.listeners.has('agent/pre-step'), false)
  assert.equal(scripted.calls.length, 0)
})

// ---------------------------------------------------------------------------
// Integration: the real CLI against a fixture this file owns
// ---------------------------------------------------------------------------

section('Integration (real codegraph CLI)')

let cliAvailable = false
try {
  const probe = createStubContext({ subprocess: createLocalSubprocess() })
  await runner.runCodegraph({ ctx: probe.ctx, config: plugin.Config({}), cwd: process.cwd(), args: ['--version'], label: 'codegraph --version' })
  cliAvailable = true
} catch (error) {
  process.stdout.write(`  skip  no usable codegraph runtime (${error?.message ?? error})\n`)
}

if (cliAvailable) {
  const fixture = mkdtempSync(join(tmpdir(), 'cg-fixture-'))
  mkdirSync(join(fixture, 'src'), { recursive: true })
  writeFileSync(
    join(fixture, 'src', 'alpha.ts'),
    'export function alphaCompute(input: number): number {\n  return betaHelper(input) * 2;\n}\n\nexport function betaHelper(value: number): number {\n  return value + 1;\n}\n',
  )
  writeFileSync(
    join(fixture, 'src', 'gamma.ts'),
    "import { alphaCompute } from './alpha';\n\nexport function gammaEntry(): number {\n  return alphaCompute(3) + 7;\n}\n",
  )

  const { ctx, record } = createStubContext({ subprocess: createLocalSubprocess() })
  plugin.apply(ctx, plugin.Config({}))
  const exec = executionFor(fixture)
  const indexTool = record.tools.get('codegraph_index')
  const exploreTool = record.tools.get('codegraph_explore')

  await test('init builds an index in the fixture', async () => {
    const output = await indexTool.execute({ operation: 'init' }, exec)
    assert.ok(existsSync(join(fixture, '.codegraph', 'codegraph.db')), `no index was written: ${output.slice(0, 400)}`)
  })

  await test('explore returns the fixture symbol source', async () => {
    const output = await exploreTool.execute({ query: 'gammaEntry' }, exec)
    assert.match(output, /gammaEntry/u, `explore did not mention the symbol: ${output.slice(0, 400)}`)
    assert.match(output, /alphaCompute/u, `explore did not surface the call target: ${output.slice(0, 400)}`)
  })

  await test('a symbol added after the index is found on the next query', async () => {
    writeFileSync(
      join(fixture, 'src', 'delta.ts'),
      'export function deltaProbe(): number {\n  return 42;\n}\n',
    )
    const output = await exploreTool.execute({ query: 'deltaProbe' }, exec)
    assert.match(output, /deltaProbe/u, `the auto-sync did not pick up the new symbol: ${output.slice(0, 400)}`)
  })

  await test('a query in an unindexed directory reports rather than throws raw', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'cg-noindex-'))
    try {
      const bareExec = executionFor(bare)
      try {
        const output = await exploreTool.execute({ query: 'anything' }, bareExec)
        assert.match(output, /isn't available here|not available here/iu)
      } catch (error) {
        assert.match(String(error.message), /isn't available here|not available here|CodeGraph not initialized/iu)
      }
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  await test('init refuses the filesystem root outright', async () => {
    const { parse } = await import('node:path')
    const rootExec = executionFor(parse(fixture).root)
    await assert.rejects(indexTool.execute({ operation: 'init' }, rootExec), /refusing to index/u)
  })

  rmSync(fixture, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Browser half: the hand-written client bundle
// ---------------------------------------------------------------------------

section('Client bundle')

/**
 * Load `lib/client.js` the way the browser module system does, with stubs for
 * `window.__ModuleLoader__` and the two modules it requires.
 * @returns the loader entry and the factory's exports.
 */
function loadClientBundle() {
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  let entry
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (loaded) => {
          entry = loaded
        },
      },
    },
  }
  runInNewContext(source, sandbox)
  assert.ok(entry !== undefined, 'the bundle never called __ModuleLoader__.load')
  return entry
}

/**
 * A React stand-in supplying exactly the hooks the panel uses, plus the two
 * module-table primitives it renders.
 * @returns a `require` implementation.
 */
function stubRequire() {
  // Shape-for-shape stand-ins: components, not elements, so the walker resolves
  // them the way React would and the switch keeps the official role/aria contract.
  const IconChevronDownOutline14 = (props) => ({ type: 'svg', props, children: [] })
  const Switch = (props) => ({
    type: 'button',
    props: { type: 'button', role: 'switch', 'aria-checked': props.checked, disabled: props.disabled },
    children: [],
  })
  return (id) => {
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { IconChevronDownOutline14, Switch }
    assert.equal(id, 'react')
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
      useSyncExternalStore: (subscribe, getSnapshot) => {
        subscribe(() => {})
        return getSnapshot()
      },
    }
  }
}

/**
 * Walk a rendered element tree for the elements carrying one prop.
 * @param node - the rendered element or a child list.
 * @param prop - the prop name to match.
 * @returns the matching elements, in render order.
 */
function elementsWith(node, prop) {
  const found = []
  const queue = Array.isArray(node) ? [...node] : [node]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === null || typeof current !== 'object') continue
    if (typeof current.type === 'function') {
      queue.push(current.type(current.props ?? {}))
      continue
    }
    if (current.props !== undefined && current.props !== null && Object.hasOwn(current.props, prop)) found.push(current)
    if (Array.isArray(current.children)) queue.push(...current.children)
  }
  return found
}

/**
 * One rendered field: its name and the control it carries. A toggle's control is
 * the primitive `Switch`; a select or a text field is a DOM element. The label,
 * the hint, and the per-field reset are chrome, not controls.
 * @param field - the field row element.
 * @returns the field's name and control.
 */
function fieldControl(field) {
  const chrome = new Set(['codegraph-head-row', 'codegraph-label', 'codegraph-hint', 'codegraph-invalid', 'codegraph-reset'])
  const controls = []
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (typeof node.type === 'function') {
      visit(node.type(node.props ?? {}))
      return
    }
    if (node.type !== 'span' && !chrome.has(node.props.className)) controls.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(field.children)
  return { field: field.props['data-field'], control: controls[0] }
}

/**
 * Whether one field row renders its own reset affordance, which the section
 * shows only while the user layer carries that field.
 * @param field - the field row element.
 * @returns true when the row carries a reset.
 */
function fieldHasReset(field) {
  let found = false
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (node.props?.className === 'codegraph-reset') {
      found = true
      return
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(field.children)
  return found
}

/**
 * A client cordis context recording the card registration.
 * @returns the context and what it captured.
 */
function createClientContext() {
  const captured = []
  const mutations = []
  let boundNamespace
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: { ...fullConfig, exploreTimeoutMs: 60_000 },
      base: { ...fullConfig },
      user: { exploreTimeoutMs: 60_000 },
      revision: 7,
      writable: true,
      mode: 'host',
    }),
    subscribe: () => () => {},
    set: async () => {},
    unset: async () => {},
    mutate: async (ops, revision) => {
      mutations.push({ ops, revision })
    },
  }
  const slots = {
    /** @param _name - slot name. @param register - the registration thunk. */
    inject(_name, register) {
      register()
      return () => {}
    },
    /** @param meta - the slot entry. @param component - the card. */
    register(meta, component) {
      captured.push({ meta, component })
      return () => {}
    },
  }
  const ctx = {
    /** @param deps - requested services. @param callback - the consumer. */
    inject(deps, callback) {
      if (!deps.includes('settingsScope')) return
      callback({
        settingsScope: {
          /** @param spec - the namespace spec. */
          bind: (spec) => {
            boundNamespace = spec.namespace
            return scope
          },
        },
        slots,
      })
    },
  }
  return { ctx, captured, mutations, get boundNamespace() { return boundNamespace } }
}

/** The whole settings schema at its defaults, as the Host resolves an empty composition entry. */
const fullConfig = plugin.Config({})

/** The package's own name — the key the client module system files the factory under. */
const PACKAGE_NAME = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).name

await test('the bundle registers itself under its package name and exports named members only', () => {
  const entry = loadClientBundle()
  // The boot graph row id is the package name, and the loader resolves the
  // factory by that same key: a shorter id throws at load ("cannot resolve ...
  // not a row in the boot graph"). Deriving both sides from package.json is what
  // makes a rename fail here instead of in the browser.
  assert.equal(entry.id, PACKAGE_NAME, 'the loader id must be the full package name')
  const exported = entry.factory(stubRequire())
  assert.equal(exported.name, PACKAGE_NAME, 'the exported plugin name must be the full package name')
  assert.ok(Array.isArray(exported.inject) && exported.inject.includes('slots'))
  assert.equal(typeof exported.apply, 'function')
  assert.equal('default' in exported, false, 'a default export breaks the loader contract')
})

await test('the card joins the Host on the same settings namespace', () => {
  const exported = loadClientBundle().factory(stubRequire())
  const client = createClientContext()
  exported.apply(client.ctx)
  assert.equal(client.boundNamespace, plugin.SETTINGS_NAMESPACE, 'the join key drifted between the halves')
  assert.equal(client.captured.length, 1)
  assert.equal(client.captured[0].meta.name, 'settings.plugin.item')
  assert.equal(client.captured[0].meta.key, plugin.SETTINGS_NAMESPACE)
  assert.equal(typeof client.captured[0].component, 'function')
})

await test('the panel renders every setting the plugin exposes', () => {
  const exported = loadClientBundle().factory(stubRequire())
  const client = createClientContext()
  exported.apply(client.ctx)
  const wrapper = client.captured[0].component
  // The registered component is the slot's createElement wrapper; the panel is
  // what it wraps, and the panel is what renders controls.
  const panel = wrapper({}).type
  const rendered = panel({})

  // The section stacks cards in a <ul>, so the panel must be one <li>, closed
  // by default exactly as the section's own cards are.
  assert.equal(rendered.type, 'li')
  assert.equal(rendered.props.className, 'codegraph-panel')
  const head = rendered.children.flat().find((child) => child !== null && typeof child === 'object' && child.type === 'button')
  assert.equal(head.props['aria-expanded'], false)
  assert.equal(rendered.children.flat().includes(null), true, 'a closed panel renders no body')
  assert.equal(
    elementsWith(rendered, 'className').some((node) => node.props.className === 'codegraph-body'),
    false,
  )

  // Every field the Host's schema declares, and no field it does not.
  assert.deepEqual(
    Object.keys(fullConfig).sort(),
    ['autoSync', 'executable', 'exploreTimeoutMs', 'frontload', 'guide', 'indexTimeoutMs', 'surface'].sort(),
  )
})

await test('the open panel renders one official control per field', () => {
  const exported = loadClientBundle().factory(stubRequire())
  const client = createClientContext()
  exported.apply(client.ctx)
  const panel = client.captured[0].component({}).type
  // `defaultOpen` renders the panel opened, which is the only way a render-only
  // test can reach its body: every row carries its field name and its control,
  // and a toggle's control is the module-table `Switch`, never a native checkbox.
  const rows = elementsWith(panel({ defaultOpen: true }), 'data-field').map(fieldControl)
  assert.deepEqual(
    rows.map((row) => row.field),
    ['guide', 'frontload', 'surface', 'autoSync', 'executable', 'exploreTimeoutMs', 'indexTimeoutMs'],
  )
  for (const row of rows) {
    const isToggle = row.field === 'guide' || row.field === 'frontload' || row.field === 'autoSync'
    if (isToggle) {
      assert.equal(row.control.type, 'button', `${row.field} renders the primitive switch`)
      assert.equal(row.control.props.role, 'switch')
      continue
    }
    assert.equal(row.control.type, row.field === 'surface' ? 'select' : 'input')
    assert.equal(typeof row.control.props.onChange, 'function')
  }
})

await test('a control shows the composed value and stages through its writer', () => {
  const exported = loadClientBundle().factory(stubRequire())
  const client = createClientContext()
  exported.apply(client.ctx)
  const panel = client.captured[0].component({}).type
  const rendered = panel({ defaultOpen: true })

  // Read the controls the same way the field inventory does, so the tests cannot
  // disagree about which element is a field's control.
  const controls = new Map(elementsWith(rendered, 'data-field').map((field) => {
    const { field: name, control } = fieldControl(field)
    return [name, control]
  }))
  // The scope serves a user override for `exploreTimeoutMs`, so the number
  // control shows it over the composition base; the switch reports the base
  // through the primitive's own `aria-checked`.
  assert.equal(controls.get('exploreTimeoutMs').props.value, '60000')
  assert.equal(controls.get('autoSync').props['aria-checked'], true)
  // A user override also buys the field's own reset — the section's per-field
  // gesture — while an untouched field has none.
  const rowOf = (name) => elementsWith(rendered, 'data-field').find((f) => f.props['data-field'] === name)
  assert.equal(fieldHasReset(rowOf('exploreTimeoutMs')), true)
  assert.equal(fieldHasReset(rowOf('guide')), false)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = results.filter((entry) => !entry.ok)
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`)
if (failed.length > 0) {
  for (const entry of failed) process.stdout.write(`  ${entry.section}: ${entry.label}\n`)
  process.exit(1)
}
