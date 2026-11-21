/**
 * Freezes the whole runtime dependency tree in deploy/runtime/npm-shrinkwrap.json, which
 * stage-runtime.mjs copies next to the runtime package.json so `npm ci` installs exactly it.
 *
 *   node scripts/runtime-lock.mjs           regenerate after changing server dependencies
 *   node scripts/runtime-lock.mjs --check   fail when the shrinkwrap no longer matches (CI)
 *
 * The shrinkwrap is resolved by npm, from direct dependencies pinned to pnpm-lock.yaml. It is
 * reviewed and committed like any lockfile: two jobs, or a rebuild months later, install the same
 * tree.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SHRINKWRAP, runtimePackage } from './runtime-package.mjs'

const root = resolve(import.meta.dirname, '..')
const pkg = runtimePackage(root, '0.0.0')
const target = join(root, SHRINKWRAP)

if (process.argv.includes('--check')) {
  let locked
  try {
    locked = JSON.parse(readFileSync(target, 'utf8')).packages?.['']?.dependencies ?? {}
  } catch {
    locked = null
  }
  const wanted = JSON.stringify(Object.entries(pkg.dependencies).sort())
  if (!locked || JSON.stringify(Object.entries(locked).sort()) !== wanted) {
    console.error(`${SHRINKWRAP} does not match the server dependencies in pnpm-lock.yaml: run \`pnpm runtime:lock\` and commit the result.`)
    process.exit(1)
  }
  console.log(`${SHRINKWRAP} matches pnpm-lock.yaml (${Object.keys(pkg.dependencies).length} direct dependencies).`)
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'sillage-runtime-lock-'))
try {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  // Resolution only: no download of tarballs, no install scripts. --legacy-peer-deps as in the
  // install itself: the Claude SDK declares a zod@^4 peer that pnpm tolerates and npm rejects.
  execFileSync('npm', ['install', '--package-lock-only', '--omit=dev', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' })
  writeFileSync(target, readFileSync(join(dir, 'package-lock.json')))
  console.log(`${SHRINKWRAP} written.`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
