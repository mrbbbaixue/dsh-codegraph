/**
 * Link the first-party packages this package imports into a local
 * `node_modules/`, so the plugin can be exercised outside a dsh profile.
 *
 * Installed in a profile, bare `@deepseek-ai/*` specifiers already resolve: dsh
 * keeps a shared symlink farm at `$DSH_HOME/profiles/node_modules`. A bare
 * checkout has no such ancestor, which would make `node lib/index.js` and the
 * test harness fail on import for reasons that have nothing to do with the code.
 *
 * Junctions are used on Windows so this needs neither elevation nor a developer
 * mode. Idempotent: run it as often as you like.
 *
 * @module @mrbbbaixue/dsh-codegraph/scripts/dev-link
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Imported by `lib/index.js` at runtime, so they must resolve from a bare checkout. */
const NEEDED = ['dsh-tools', 'dsh-llm', 'schemastery']

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const linkRoot = join(repoRoot, 'node_modules', '@deepseek-ai')

/**
 * Candidate directories holding the first-party packages, in preference order.
 * @returns absolute directories to probe.
 */
function sourceRoots() {
  const home = homedir()
  const roots = []
  const dshHome = process.env.DSH_HOME
  if (typeof dshHome === 'string' && dshHome !== '') roots.push(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai'))
  roots.push(join(home, '.dsh', 'profiles', 'node_modules', '@deepseek-ai'))
  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData !== '') {
    roots.push(join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  }
  return roots
}

const sourceRoot = sourceRoots().find((candidate) => NEEDED.every((pkg) => existsSync(join(candidate, pkg))))

if (sourceRoot === undefined) {
  console.error(
    `dev-link: no directory holding ${NEEDED.join(', ')} was found. Looked in:\n  ${sourceRoots().join('\n  ')}\nInstall dsh, or set DSH_HOME.`,
  )
  process.exit(1)
}

mkdirSync(linkRoot, { recursive: true })

for (const pkg of NEEDED) {
  const target = join(linkRoot, pkg)
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  symlinkSync(join(sourceRoot, pkg), target, 'junction')
  console.log(`dev-link: ${pkg} -> ${join(sourceRoot, pkg)}`)
}

console.log(`dev-link: ${NEEDED.length} packages linked into ${linkRoot}`)
