import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { subsequenceGaps } from './subsequence.js'

const exec = promisify(execFile)

/**
 * Recherche de fichiers dans le répertoire de travail, pour l'autocomplétion des
 * mentions.
 *
 * Faite ici plutôt qu'en interrogeant chaque CLI : Claude et Codex savent tous deux
 * chercher des fichiers, mais il faudrait alors un process lancé rien que pour
 * compléter une saisie, et rien du tout ne serait proposé sur une conversation qui
 * n'a pas encore démarré. Lister un dossier n'est pas une valeur de protocole.
 */

/** Au-delà, la liste ne tient plus à l'écran et le tri n'apporte plus rien. */
const MAX_RESULTS = 30

/** Garde-fou du parcours de repli, pour ne pas arpenter un dossier démesuré. */
const MAX_SCANNED_ENTRIES = 20_000

/**
 * Dossiers ignorés par le parcours de repli. Hors dépôt git il n'existe aucune règle
 * déclarée à respecter, et ces quatre-là noieraient toute recherche.
 */
const SKIPPED = new Set(['.git', 'node_modules', 'dist', '.venv'])

export interface FileMatch {
  /** Chemin relatif au répertoire de travail, tel qu'il s'écrit dans un message. */
  path: string
  name: string
}

/**
 * Fichiers suivis par git, dossiers ignorés exclus.
 *
 * `--others --exclude-standard` ajoute les fichiers non encore suivis tout en
 * respectant .gitignore : un fichier tout juste créé doit être proposable.
 */
async function gitFiles(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await exec(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd, maxBuffer: 32 * 1024 * 1024 },
    )
    return stdout.split('\0').filter((entry) => entry.length > 0)
  } catch {
    // Pas un dépôt, ou git absent : le parcours de repli prend le relais.
    return null
  }
}

async function walk(cwd: string): Promise<string[]> {
  const found: string[] = []
  const queue: string[] = [cwd]
  let scanned = 0

  while (queue.length > 0 && scanned < MAX_SCANNED_ENTRIES) {
    const dir = queue.shift()
    if (dir === undefined) break

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Dossier illisible : il est sauté, pas la recherche entière.
      continue
    }

    for (const entry of entries) {
      scanned += 1
      if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue

      const full = join(dir, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.isFile()) found.push(relative(cwd, full))
    }
  }

  return found
}

/** Plus le score est bas, meilleure est la correspondance. */
function score(path: string, query: string): number | null {
  const gaps = subsequenceGaps(path, query)
  if (gaps === null) return null

  const haystack = path.toLowerCase()
  // À correspondance égale, le chemin le plus court et le nom de fichier atteint le
  // plus tôt passent devant.
  const inName = haystack.lastIndexOf(sep) < haystack.indexOf(query[0]?.toLowerCase() ?? '') ? 0 : 40
  return gaps * 4 + path.length + inName
}

export async function searchFiles(cwd: string, query: string): Promise<FileMatch[]> {
  const paths = (await gitFiles(cwd)) ?? (await walk(cwd))
  const trimmed = query.trim()

  const scored = trimmed
    ? paths
        .map((path) => ({ path, rank: score(path, trimmed) }))
        .filter((entry): entry is { path: string; rank: number } => entry.rank !== null)
        .sort((a, b) => a.rank - b.rank)
    : // Sans requête, les chemins les plus courts sont les plus proches de la racine,
      // donc les plus probables.
      paths.map((path) => ({ path, rank: path.length })).sort((a, b) => a.rank - b.rank)

  return scored.slice(0, MAX_RESULTS).map(({ path }) => ({
    path,
    name: path.slice(path.lastIndexOf(sep) + 1),
  }))
}
