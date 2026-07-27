#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Régénère les bindings du protocole Codex depuis le binaire installé.
 *
 *   node scripts/codex-types.mjs          écrit dans packages/protocol/src/codex
 *   node scripts/codex-types.mjs --check  échoue si le commité a dérivé
 *
 * Le mode --check est ce qui transforme une montée de version de Codex en échec
 * visible plutôt qu'en incompatibilité silencieuse à l'exécution.
 */

const root = join(fileURLToPath(import.meta.url), '../..')
const target = join(root, 'packages/protocol/src/codex')
const check = process.argv.includes('--check')

/** Fichiers écrits par Sillage, à préserver et à exclure de la comparaison. */
const HAND_WRITTEN = new Set(['README.md'])

function listFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir).sort()) {
    const rel = prefix ? `${prefix}/${entry}` : entry
    if (HAND_WRITTEN.has(rel)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel))
    else out.push(rel)
  }
  return out
}

function generateInto(dir) {
  try {
    execFileSync('codex', ['app-server', 'generate-ts', '-o', dir], { stdio: 'pipe' })
  } catch (err) {
    throw new Error(
      `La génération a échoué. Codex est-il installé et à jour ?\n${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

const version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()

if (!check) {
  const staging = mkdtempSync(join(tmpdir(), 'sillage-codex-'))
  try {
    generateInto(staging)
    // On repart d'un dossier propre : un type supprimé côté Codex doit disparaître ici
    // aussi, sinon on garde indéfiniment des définitions mortes.
    const readme = readFileSync(join(target, 'README.md'), 'utf8')
    rmSync(target, { recursive: true, force: true })
    cpSync(staging, target, { recursive: true })
    writeFileSync(join(target, 'README.md'), readme)
    console.log(`Bindings régénérés depuis ${version} dans ${relative(root, target)}`)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  process.exit(0)
}

const staging = mkdtempSync(join(tmpdir(), 'sillage-codex-check-'))
try {
  generateInto(staging)

  const fresh = listFiles(staging)
  const committed = listFiles(target)

  const added = fresh.filter((f) => !committed.includes(f))
  const removed = committed.filter((f) => !fresh.includes(f))
  const changed = fresh
    .filter((f) => committed.includes(f))
    .filter(
      (f) => readFileSync(join(staging, f), 'utf8') !== readFileSync(join(target, f), 'utf8'),
    )

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    console.log(`Bindings Codex à jour (${version}, ${committed.length} fichiers).`)
    process.exit(0)
  }

  console.error(`Les bindings Codex ont dérivé (binaire ${version}) :`)
  for (const [label, files] of [
    ['ajoutés', added],
    ['supprimés', removed],
    ['modifiés', changed],
  ]) {
    if (files.length > 0) {
      console.error(`  ${files.length} ${label} : ${files.slice(0, 8).join(', ')}${files.length > 8 ? ', ...' : ''}`)
    }
  }
  console.error('\nLancer `pnpm codex:types` puis relire le diff avant de commiter.')
  process.exit(1)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
