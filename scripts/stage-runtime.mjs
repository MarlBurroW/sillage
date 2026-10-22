/**
 * Assemble the distributed runtime tree shared by release tarballs and Docker:
 *
 *   out/
 *   ├── VERSION               published version (X.Y.Z)
 *   ├── package.json          runtime dependencies only, without workspace
 *   ├── server/               daemon bundle (main.js, cli/, migrations/)
 *   ├── web/                  built frontend
 *   ├── deploy/               service templates (systemd, launchd), example config
 *   └── install.sh            lets the archive reinstall itself
 *
 * tsup leaves all runtime dependencies external (especially native modules and
 * Claude SDK): the caller must then run `npm install --omit=dev` in `out/` to
 * materialize node_modules on the target architecture.
 * Usage: node scripts/stage-runtime.mjs <outdir>
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

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

const serverPkg = JSON.parse(readFileSync(join(root, 'apps/server/package.json'), 'utf8'))
const dependencies = Object.fromEntries(
  Object.entries(serverPkg.dependencies).filter(([, spec]) => !spec.startsWith('workspace:')),
)

const version = (process.env.SILLAGE_VERSION ?? 'dev').replace(/^v/, '')
writeFileSync(join(out, 'VERSION'), `${version}\n`)
writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'sillage-runtime',
      version,
      private: true,
      type: 'module',
      // Carry the root requirement into the distributed tree: `npm rebuild` or
      // `npm install` under an old Node should report it rather than revealing
      // incompatibility through the first crash.
      engines: { node: '>=22.14' },
      dependencies,
    },
    null,
    2,
  )}\n`,
)

console.log(`arbre d'exécution assemblé dans ${out} (version ${version})`)
