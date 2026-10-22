/**
 * Prepare `apps/desktop/stage/`, bundled by desktop app:
 *
 *   stage/
 *   ├── sillage/   release runtime (server/, web/, native node_modules/)
 *   └── node/      official Node running it, including npm
 *
 * Bundled Node matches the version running this script. In CI it is the Node under
 * which the runtime was just installed/checked: app ships this pair unchanged.
 * Download from nodejs.org, verify against accompanying SHASUMS256 like install.sh.
 * Windows archive is .zip, node.exe lives at root, npm launches through npm.cmd.
 *
 * Usage: node scripts/desktop-stage.mjs <runtime tree>
 * (the tree `.github/actions/runtime-archive` assembles in out/sillage)
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const runtimeArg = process.argv[2]
if (!runtimeArg) {
  console.error("usage: node scripts/desktop-stage.mjs <arbre d'exécution>")
  process.exit(1)
}
const runtime = resolve(runtimeArg)
if (!existsSync(join(runtime, 'server/main.js')) || !existsSync(join(runtime, 'node_modules'))) {
  console.error(`arbre d'exécution incomplet : ${runtime} (server/main.js et node_modules/ attendus)`)
  process.exit(1)
}
const windows = process.platform === 'win32'
if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
  console.error(`plateforme non prise en charge : ${process.platform}`)
  process.exit(1)
}

const root = resolve(import.meta.dirname, '..')
const stage = join(root, 'apps/desktop/stage')
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// `node_modules/.bin` links only serve npm scripts the app never runs, and
// packaging does not always preserve symlinks.
cpSync(runtime, join(stage, 'sillage'), { recursive: true, verbatimSymlinks: true })
const modules = join(stage, 'sillage/node_modules')
rmSync(join(modules, '.bin'), { recursive: true, force: true })

// Native modules ship all-platform binaries and C sources for recompilation the
// app never does: about 100 MB wasted. Keep only target binary (node-pty builds
// its own on Linux in build/).
const target = `${process.platform}-${process.arch}`
keepOnly(join(modules, 'node-pty/prebuilds'), (entry) => entry === target)
keepOnly(join(modules, 'better-sqlite3/prebuilds'), (entry) => entry === `${target}.node`)
for (const sources of ['node-pty/deps', 'node-pty/third_party', 'better-sqlite3/deps']) {
  rmSync(join(modules, sources), { recursive: true, force: true })
}
// Windows node-pty debug symbols weigh more than its binaries.
keepOnly(join(modules, 'node-pty/prebuilds', target), (entry) => !entry.endsWith('.pdb'))

const version = process.version
const name = `node-${version}-${windows ? 'win' : process.platform}-${process.arch}`
const format = windows ? 'zip' : 'tar.gz'
const base = `https://nodejs.org/dist/${version}`

const sums = await download(`${base}/SHASUMS256.txt`)
const expected = sums
  .toString('utf8')
  .split('\n')
  .map((line) => line.trim().split(/\s+/))
  .find(([, file]) => file === `${name}.${format}`)?.[0]
if (!expected) throw new Error(`${name}.${format} absent de ${base}/SHASUMS256.txt`)

const archive = await download(`${base}/${name}.${format}`)
const actual = createHash('sha256').update(archive).digest('hex')
if (actual !== expected) throw new Error(`${name}.${format} : somme ${actual}, attendue ${expected}`)

const scratch = mkdtempSync(join(tmpdir(), 'sillage-desktop-'))
try {
  const file = join(scratch, `${name}.${format}`)
  writeFileSync(file, archive)
  const node = join(stage, 'node')
  mkdirSync(node)
  // Windows tar (bsdtar in System32) reads .zip; Git for Windows tar, earlier
  // on bash PATH, does not.
  const tar = windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  execFileSync(tar, [windows ? '-xf' : '-xzf', file, '-C', node, '--strip-components=1'])

  // No C headers, manual pages, or corepack: app runs Node/npm only.
  const extras = windows
    ? ['corepack', 'corepack.cmd', 'node_modules/corepack', 'install_tools.bat', 'nodevars.bat', 'CHANGELOG.md', 'README.md']
    : ['include', 'share', 'lib/node_modules/corepack', 'bin/corepack', 'CHANGELOG.md', 'README.md']
  for (const entry of extras) {
    rmSync(join(node, entry), { recursive: true, force: true })
  }
  // npm/npx are symlinks in archive: replace with launchers surviving packaging.
  // On Windows they are already files (`npm.cmd`).
  for (const [command, script] of windows ? [] : [
    ['npm', 'npm-cli.js'],
    ['npx', 'npx-cli.js'],
  ]) {
    const launcher = join(node, 'bin', command)
    rmSync(launcher, { force: true })
    writeFileSync(
      launcher,
      `#!/bin/sh\ndir=$(dirname "$0")\nexec "$dir/node" "$dir/../lib/node_modules/npm/bin/${script}" "$@"\n`,
    )
    chmodSync(launcher, 0o755)
  }

  // Important check after trimming: under bundled Node, database opens and terminal
  // starts, as release archive verification does.
  const shell = windows ? '["cmd.exe", ["/d", "/c", "exit 3"]]' : '["/bin/sh", ["-c", "exit 3"]]'
  execFileSync(
    join(node, windows ? 'node.exe' : 'bin/node'),
    [
      '-e',
      `require("better-sqlite3")(":memory:").prepare("select 1").get()
       const [file, args] = ${shell}
       const shell = require("node-pty").spawn(file, args, {})
       shell.onExit(({ exitCode }) => process.exit(exitCode === 3 ? 0 : 1))
       setTimeout(() => process.exit(2), 10000).unref()`,
    ],
    { cwd: join(stage, 'sillage'), stdio: 'inherit' },
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`application de bureau préparée dans ${stage} (Node ${version}, ${process.platform}-${process.arch})`)

function keepOnly(dir, keep) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (!keep(entry)) rmSync(join(dir, entry), { recursive: true, force: true })
  }
}

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} : HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}
