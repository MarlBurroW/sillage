import type { GitRepoDto } from '@sillage/protocol'
import { subsequenceGaps } from '../subsequence.js'

/**
 * Les dépôts auxquels un jeton donne accès, pour la combobox de création de projet.
 *
 * La liste est rapatriée en une fois puis filtrée en mémoire, plutôt que d'interroger
 * l'API de recherche de GitHub à chaque frappe. Trois raisons : cette API est limitée à
 * trente requêtes par minute, son qualificatif `user:` rate les dépôts d'organisation
 * auxquels le compte a accès, et un filtrage local répond sans latence.
 */

export const GITHUB_HOST = 'github.com'

/** Cent est le maximum accepté par l'API ; en demander moins multiplierait les pages. */
const PER_PAGE = 100

/** Dix pages, soit mille dépôts. Au-delà, la combobox n'est plus le bon outil. */
const MAX_PAGES = 10

/**
 * Durée de vie du cache.
 *
 * Assez long pour qu'une session de création de projet ne rappelle pas l'API à chaque
 * ouverture du formulaire, assez court pour qu'un dépôt créé à l'instant apparaisse
 * sans qu'il faille redémarrer Sillage.
 */
const CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  repos: GitRepoDto[]
  truncated: boolean
  fetchedAt: number
}

interface GitHubRepo {
  full_name: string
  name: string
  clone_url: string
  private: boolean
  description: string | null
  pushed_at: string | null
}

export class GitHubRepoCatalog {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Les dépôts du compte, filtrés par `query`.
   *
   * Le cache est indexé par utilisateur : deux comptes de la même instance ont deux
   * jetons et ne voient pas les mêmes dépôts.
   */
  async search(
    ownerId: string,
    token: string,
    query: string,
  ): Promise<{ repos: GitRepoDto[]; truncated: boolean }> {
    const cached = this.cache.get(ownerId)
    const entry =
      cached && this.now() - cached.fetchedAt < CACHE_TTL_MS ? cached : await this.load(ownerId, token)

    return { repos: filter(entry.repos, query), truncated: entry.truncated }
  }

  /** Après l'écriture ou la suppression d'un jeton, ce qui est en cache ne vaut plus. */
  forget(ownerId: string): void {
    this.cache.delete(ownerId)
  }

  private async load(ownerId: string, token: string): Promise<CacheEntry> {
    const repos: GitRepoDto[] = []
    let truncated = false

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await fetchPage(token, page)
      repos.push(...batch.map(toDto))

      if (batch.length < PER_PAGE) break
      if (page === MAX_PAGES) truncated = true
    }

    const entry: CacheEntry = { repos, truncated, fetchedAt: this.now() }
    this.cache.set(ownerId, entry)
    return entry
  }
}

/** Le code est ce que l'interface traduit ; le message anglais n'est qu'un repli. */
export class GitHubError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

async function fetchPage(token: string, page: number): Promise<GitHubRepo[]> {
  const url = new URL('https://api.github.com/user/repos')
  url.searchParams.set('per_page', String(PER_PAGE))
  url.searchParams.set('page', String(page))
  // Le tri par date de push met en tête ceux sur lesquels on travaille, ce qui est
  // exactement l'ordre voulu quand la combobox s'ouvre sans qu'on ait rien tapé.
  url.searchParams.set('sort', 'pushed')
  // Sans ce paramètre, l'API ne rend que les dépôts dont le compte est propriétaire, et
  // ceux de ses organisations manqueraient à l'appel.
  url.searchParams.set('affiliation', 'owner,collaborator,organization_member')

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'sillage',
    },
  })

  if (response.status === 401) {
    throw new GitHubError('git_forge_token_rejected', 'The forge rejected the token.')
  }
  if (response.status === 403) {
    throw new GitHubError('git_forge_forbidden', 'The forge refused the request.')
  }
  if (!response.ok) {
    throw new GitHubError(
      'git_forge_unreachable',
      'The forge answered {status}.',
      { status: `${response.status} ${response.statusText}` },
    )
  }

  return (await response.json()) as GitHubRepo[]
}

function toDto(repo: GitHubRepo): GitRepoDto {
  return {
    fullName: repo.full_name,
    name: repo.name,
    cloneUrl: repo.clone_url,
    isPrivate: repo.private,
    description: repo.description,
    pushedAt: repo.pushed_at ? Date.parse(repo.pushed_at) : null,
  }
}

/** Sans requête, l'ordre de GitHub est déjà le bon : le plus récemment poussé d'abord. */
function filter(repos: GitRepoDto[], query: string): GitRepoDto[] {
  const trimmed = query.trim()
  if (!trimmed) return repos.slice(0, 50)

  return repos
    .map((repo) => ({ repo, rank: rank(repo, trimmed) }))
    .filter((entry): entry is { repo: GitRepoDto; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 50)
    .map(({ repo }) => repo)
}

function rank(repo: GitRepoDto, query: string): number | null {
  // Le nom seul d'abord : qui tape « sillage » cherche `moi/sillage`, pas un dépôt dont
  // le propriétaire contient ces lettres. Le nom complet ne sert qu'ensuite, pour que
  // « marl/sil » reste possible.
  const onName = subsequenceGaps(repo.name, query)
  if (onName !== null) return onName * 4 + repo.name.length

  const onFullName = subsequenceGaps(repo.fullName, query)
  if (onFullName === null) return null
  return onFullName * 4 + repo.fullName.length + 100
}
