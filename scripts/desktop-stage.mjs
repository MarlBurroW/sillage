/**
 * Prépare `apps/desktop/stage/`, ce que l'application de bureau embarque :
 *
 *   stage/
 *   ├── sillage/   l'arbre d'exécution de la release (server/, web/, node_modules/ natifs)
 *   └── node/      le Node officiel qui le fait tourner, npm compris
 *
 * Le Node embarqué est celui qui exécute ce script, à la version près. En CI, c'est
 * celui sous lequel l'arbre d'exécution vient d'être installé et vérifié : l'app livre
 * ce couple tel quel. Il est téléchargé depuis nodejs.org et vérifié contre le
 * SHASUMS256 publié à côté, comme le fait install.sh.
 *
 * Usage : node scripts/desktop-stage.mjs <arbre d'exécution>
 * (l'arbre que `.github/actions/runtime-archive` assemble dans out/sillage)
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
if (process.platform !== 'darwin' && process.platform !== 'linux') {
  console.error(`plateforme non prise en charge : ${process.platform}`)
  process.exit(1)
}

const root = resolve(import.meta.dirname, '..')
const stage = join(root, 'apps/desktop/stage')
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// Les liens de `node_modules/.bin` ne servent qu'aux scripts npm, que l'app ne lance pas,
// et l'empaquetage ne garde pas toujours les liens symboliques.
cpSync(runtime, join(stage, 'sillage'), { recursive: true, verbatimSymlinks: true })
const modules = join(stage, 'sillage/node_modules')
rmSync(join(modules, '.bin'), { recursive: true, force: true })

// Les modules natifs livrent les binaires de toutes les plateformes, et leurs sources C
// pour une recompilation que l'app ne fait jamais : une centaine de Mo pour rien. Seul
// reste le binaire de la cible (node-pty compile le sien sous Linux, dans build/).
const target = `${process.platform}-${process.arch}`
keepOnly(join(modules, 'node-pty/prebuilds'), (entry) => entry === target)
keepOnly(join(modules, 'better-sqlite3/prebuilds'), (entry) => entry === `${target}.node`)
for (const sources of ['node-pty/deps', 'node-pty/third_party', 'better-sqlite3/deps']) {
  rmSync(join(modules, sources), { recursive: true, force: true })
}

const version = process.version
const name = `node-${version}-${process.platform}-${process.arch}`
const base = `https://nodejs.org/dist/${version}`

const sums = await download(`${base}/SHASUMS256.txt`)
const expected = sums
  .toString('utf8')
  .split('\n')
  .map((line) => line.trim().split(/\s+/))
  .find(([, file]) => file === `${name}.tar.gz`)?.[0]
if (!expected) throw new Error(`${name}.tar.gz absent de ${base}/SHASUMS256.txt`)

const archive = await download(`${base}/${name}.tar.gz`)
const actual = createHash('sha256').update(archive).digest('hex')
if (actual !== expected) throw new Error(`${name}.tar.gz : somme ${actual}, attendue ${expected}`)

const scratch = mkdtempSync(join(tmpdir(), 'sillage-desktop-'))
try {
  const file = join(scratch, `${name}.tar.gz`)
  writeFileSync(file, archive)
  const node = join(stage, 'node')
  mkdirSync(node)
  execFileSync('tar', ['-xzf', file, '-C', node, '--strip-components=1'])

  // Ni en-têtes C, ni pages de manuel, ni corepack : l'app lance Node et npm, rien d'autre.
  for (const entry of ['include', 'share', 'lib/node_modules/corepack', 'bin/corepack', 'CHANGELOG.md', 'README.md']) {
    rmSync(join(node, entry), { recursive: true, force: true })
  }
  // npm et npx sont des liens symboliques dans l'archive : des lanceurs à la place, qui
  // survivent à l'empaquetage.
  for (const [command, script] of [
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

  // Le contrôle qui compte, après l'élagage : sous le Node embarqué, la base s'ouvre et un
  // terminal démarre, comme le vérifie l'archive de la release.
  execFileSync(
    join(node, 'bin/node'),
    [
      '-e',
      `require("better-sqlite3")(":memory:").prepare("select 1").get()
       const shell = require("node-pty").spawn("/bin/sh", ["-c", "exit 3"], {})
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
