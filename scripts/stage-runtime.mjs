/**
 * Assemble the distributed runtime tree shared by release tarballs and Docker:
 *
 *   out/
 *   ├── VERSION               published version (X.Y.Z)
 *   ├── package.json          runtime dependencies only, exact versions from pnpm-lock.yaml
 *   ├── npm-shrinkwrap.json   the whole tree, frozen (deploy/runtime/npm-shrinkwrap.json)
 *   ├── server/               daemon bundle (main.js, cli/, migrations/)
 *   ├── web/                  built frontend
 *   ├── deploy/               service templates (systemd, launchd), example config
 *   └── install.sh            lets the archive reinstall itself
 *
 * tsup leaves all runtime dependencies external (especially native modules and
 * Claude SDK): the caller must then run `npm ci --omit=dev` in `out/` to
 * materialize node_modules on the target architecture, exactly as the shrinkwrap records.
 * Usage: node scripts/stage-runtime.mjs <outdir>
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SHRINKWRAP, runtimePackage } from './runtime-package.mjs'

const outDir = process.argv[2]
if (!outDir) {
  console.error('usage: node scripts/stage-runtime.mjs <outdir>')
  process.exit(1)
}

const root = resolve(import.meta.dirname, '..')
const out = resolve(outDir)

const serverDist = join(root, 'apps/server/dist')
const webDist = join(root, 'apps/web/dist')
for (const dir of [serverDist, webDist]) {
  if (!existsSync(join(dir, dir === serverDist ? 'main.js' : 'index.html'))) {
    console.error(`build manquant: ${dir} (lancer \`pnpm build\` d'abord)`)
    process.exit(1)
  }
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

cpSync(serverDist, join(out, 'server'), { recursive: true })
cpSync(webDist, join(out, 'web'), { recursive: true })
mkdirSync(join(out, 'deploy'), { recursive: true })
cpSync(join(root, 'deploy/sillage.service.tmpl'), join(out, 'deploy/sillage.service.tmpl'))
cpSync(join(root, 'deploy/sillage.plist.tmpl'), join(out, 'deploy/sillage.plist.tmpl'))
cpSync(join(root, 'deploy/config.example.toml'), join(out, 'deploy/config.example.toml'))
cpSync(join(root, 'install.sh'), join(out, 'install.sh'))

const version = (process.env.SILLAGE_VERSION ?? 'dev').replace(/^v/, '')
const pkg = runtimePackage(root, version)
writeFileSync(join(out, 'VERSION'), `${version}\n`)
writeFileSync(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

// npm ci refuses a shrinkwrap that disagrees with package.json: a stale one fails here, at build
// time, rather than shipping another tree. Name and version follow the package being staged.
const shrinkwrap = JSON.parse(readFileSync(join(root, SHRINKWRAP), 'utf8'))
shrinkwrap.name = pkg.name
shrinkwrap.version = version
if (shrinkwrap.packages?.['']) Object.assign(shrinkwrap.packages[''], { name: pkg.name, version })
writeFileSync(join(out, 'npm-shrinkwrap.json'), `${JSON.stringify(shrinkwrap, null, 2)}\n`)

console.log(`arbre d'exécution assemblé dans ${out} (version ${version})`)
