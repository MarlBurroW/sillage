import {
  PALETTE_FILES_PER_PROJECT,
  containsInOrder,
  foldForMatch,
  fuzzyTokens,
  matchFields,
  type FuzzyField,
  type PaletteFileGroupDto,
} from '@sillage/protocol'
import { listWorkspaceFiles } from '../files.js'

/**
 * Recherche de fichiers dans tous les projets à la fois, pour la palette.
 *
 * Les listes sont gardées un court moment : une saisie déclenche plusieurs recherches,
 * et relancer `git ls-files` dans chaque projet à chaque lettre referait le même travail.
 * Assez court pour qu'un fichier tout juste créé se trouve à la recherche suivante.
 */
const LISTING_TTL_MS = 15_000

/** Plafond par répertoire : un dépôt démesuré ne doit pas remplir la mémoire du daemon. */
const MAX_FILES = 50_000

/** Répertoires listés en même temps : quarante `git` lancés d'un coup se gêneraient. */
const CONCURRENCY = 6

/**
 * Poids des champs, les mêmes que ceux de la palette qui reclasse derrière : le nom du
 * fichier compte plus que son dossier, et le nom du projet ne fait que restreindre.
 */
const NAME_WEIGHT = 1
const DIR_WEIGHT = 0.6
const PROJECT_WEIGHT = 0.35

interface Listing {
  paths: string[]
  /** Les mêmes, repliés une fois pour toutes les frappes qui suivent. */
  folded: string[]
}

const listings = new Map<string, Promise<Listing>>()

function listing(cwd: string): Promise<Listing> {
  const cached = listings.get(cwd)
  if (cached) return cached

  const pending = listWorkspaceFiles(cwd)
    .then((all) => {
      const paths = all.slice(0, MAX_FILES)
      return { paths, folded: paths.map(foldForMatch) }
    })
    // Un répertoire disparu ou illisible ne prive pas les autres projets de résultats.
    .catch((): Listing => ({ paths: [], folded: [] }))
  listings.set(cwd, pending)
  // Retirée plutôt que marquée périmée : rien ne reste en mémoire une fois la saisie
  // finie, la palette pouvant ne pas resservir avant des heures.
  setTimeout(() => {
    if (listings.get(cwd) === pending) listings.delete(cwd)
  }, LISTING_TTL_MS).unref()
  return pending
}

export interface FileSearchTarget {
  projectId: string
  projectName: string
  cwd: string
}

async function inBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < items.length; start += size) {
    results.push(...(await Promise.all(items.slice(start, start + size).map(run))))
  }
  return results
}

/**
 * Chaque mot doit se trouver dans le chemin ou dans le nom du projet, et au moins un dans
 * le chemin : « nimbus forecast » cherche `forecast` dans Nimbus, mais « nimbus » seul ne
 * rend pas tous ses fichiers.
 */
async function searchOne(target: FileSearchTarget, tokens: string[]): Promise<PaletteFileGroupDto> {
  const { paths, folded } = await listing(target.cwd)
  const project = foldForMatch(target.projectName)
  // Les mots que le nom du projet ne porte pas doivent tous se trouver dans le chemin :
  // de quoi écarter d'un coup les milliers de chemins hors course.
  const required = tokens.filter((token) => !project.includes(token))
  const projectField: FuzzyField = { text: target.projectName, folded: project, weight: PROJECT_WEIGHT, mode: 'strict' }

  const scored: { path: string; score: number }[] = []
  for (const [index, path] of paths.entries()) {
    const lower = folded[index] as string
    if (!required.every((token) => containsInOrder(lower, token))) continue
    if (!tokens.some((token) => containsInOrder(lower, token))) continue

    // Le nom se cherche en lettres éparses, le dossier d'un seul tenant, comme dans
    // VS Code : chercher le chemin entier en lettres éparses trouvait toujours une lettre
    // par dossier, et « palette » ramenait `packages/…/RateLimitResetType.ts`.
    const slash = path.lastIndexOf('/')
    const dir = Math.max(slash, 0)
    const match = matchFields(
      [
        { text: path.slice(slash + 1), folded: lower.slice(slash + 1), weight: NAME_WEIGHT },
        { text: path.slice(0, dir), folded: lower.slice(0, dir), weight: DIR_WEIGHT, mode: 'strict' },
        projectField,
      ],
      tokens,
    )
    if (match && (match.matched[0] || match.matched[1])) scored.push({ path, score: match.score })
  }

  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return { projectId: target.projectId, paths: scored.slice(0, PALETTE_FILES_PER_PROJECT).map(({ path }) => path) }
}

export async function searchProjectFiles(
  targets: readonly FileSearchTarget[],
  query: string,
): Promise<PaletteFileGroupDto[]> {
  const tokens = fuzzyTokens(query)
  if (tokens.length === 0) return []
  const groups = await inBatches(targets, CONCURRENCY, (target) => searchOne(target, tokens))
  return groups.filter((group) => group.paths.length > 0)
}
