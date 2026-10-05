#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Régénère les bindings de l'API d'opencode depuis le binaire installé.
 *
 *   node scripts/opencode-types.mjs          écrit packages/opencode-bindings/src/openapi.d.ts
 *   node scripts/opencode-types.mjs --check  échoue si le commité a dérivé
 *
 * opencode n'a pas de commande de génération : son OpenAPI se lit sur `GET /doc` d'un
 * `opencode serve`. Le script en lance un jetable, lit le document et le referme.
 */

const root = join(fileURLToPath(import.meta.url), '../..')
const target = join(root, 'packages/opencode-bindings/src/openapi.d.ts')
const readme = join(root, 'packages/opencode-bindings/README.md')
const check = process.argv.includes('--check')

/** L'installeur d'opencode pose le binaire hors du PATH des shells non interactifs. */
function resolveBinary() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN
  const installed = join(homedir(), '.opencode/bin/opencode')
  return existsSync(installed) ? installed : 'opencode'
}

const binary = resolveBinary()

async function fetchOpenApi(dir) {
  const child = spawn(binary, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
    cwd: dir,
    // Aucune configuration du poste ne doit colorer le document : il décrit l'API.
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: '{}' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const url = await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error(`opencode serve muet : ${output}`)), 30_000)
      const read = (chunk) => {
        output += chunk.toString()
        const match = /listening on (http:\/\/\S+)/.exec(output)
        if (!match) return
        clearTimeout(timer)
        resolve(match[1])
      }
      child.stdout.on('data', read)
      child.stderr.on('data', read)
      child.on('error', reject)
      child.on('exit', (code) => reject(new Error(`opencode serve arrêté (code ${code}) : ${output}`)))
    })
    const response = await fetch(`${url}/doc`)
    if (!response.ok) throw new Error(`GET /doc a répondu ${response.status}`)
    return await response.text()
  } finally {
    child.kill()
  }
}

function generate(openapi, dir) {
  const input = join(dir, 'openapi.json')
  const output = join(dir, 'openapi.d.ts')
  writeFileSync(input, openapi)
  // `--empty-objects-unknown` : les objets libres de l'API (entrée d'un outil,
  // métadonnées) sortiraient sinon en `Record<string, never>`, illisibles sans cast.
  execFileSync(
    join(root, 'node_modules/.bin/openapi-typescript'),
    [input, '-o', output, '--empty-objects-unknown'],
    { stdio: 'pipe' },
  )
  return readFileSync(output, 'utf8')
}

const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
const staging = mkdtempSync(join(tmpdir(), 'sillage-opencode-'))
try {
  const fresh = generate(await fetchOpenApi(staging), staging)

  if (!check) {
    writeFileSync(target, fresh)
    writeFileSync(
      readme,
      readFileSync(readme, 'utf8').replace(
        /Généré avec \*\*opencode [^*]+\*\*/,
        `Généré avec **opencode ${version}**`,
      ),
    )
    console.log(`Bindings régénérés depuis opencode ${version} dans ${relative(root, target)}`)
  } else if (fresh === readFileSync(target, 'utf8')) {
    console.log(`Bindings opencode à jour (${version}).`)
  } else {
    console.error(`Les bindings opencode ont dérivé (binaire ${version}).`)
    console.error('\nLancer `pnpm opencode:types` puis relire le diff avant de commiter.')
    process.exitCode = 1
  }
} finally {
  rmSync(staging, { recursive: true, force: true })
}
