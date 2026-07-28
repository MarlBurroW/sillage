/**
 * Assemble l'arbre d'exécution distribué, commun au tarball de release et à
 * l'image Docker :
 *
 *   out/
 *   ├── VERSION               version publiée (X.Y.Z)
 *   ├── package.json          dépendances d'exécution seules, sans le workspace
 *   ├── server/               bundle du daemon (main.js, cli/, migrations/)
 *   ├── web/                  frontend buildé
 *   ├── deploy/               unité systemd template et config d'exemple
 *   └── install.sh            pour que l'archive sache se réinstaller
 *
 * Le bundle tsup laisse toutes les dépendances runtime externes (modules natifs
 * et SDK Claude en tête) : l'appelant doit ensuite lancer `npm install
 * --omit=dev` dans `out/` pour matérialiser node_modules sur l'architecture
 * cible. Usage : node scripts/stage-runtime.mjs <outdir>
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
  `${JSON.stringify({ name: 'sillage-runtime', version, private: true, type: 'module', dependencies }, null, 2)}\n`,
)

console.log(`arbre d'exécution assemblé dans ${out} (version ${version})`)
