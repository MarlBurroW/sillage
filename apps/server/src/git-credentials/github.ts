import type { GitRepoDto } from '@sillage/protocol'
import { subsequenceGaps } from '../subsequence.js'

/** Token-accessible repositories for project creation comboboxes. Fetch once then filter locally instead of GitHub search per keystroke: search is limited to thirty requests per minute, `user:` misses accessible organization repositories, and local filtering avoids latency. */

export const GITHUB_HOST = 'github.com'

/** One hundred is the API maximum; smaller pages multiply requests. */
const PER_PAGE = 100

/** Ten pages, one thousand repositories; beyond this comboboxes are unsuitable. */
const MAX_PAGES = 10

/** Cache lifetime long enough to avoid refetching every form opening, short enough for new repositories to appear without restarting Sillage. */
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

  /** Account repositories filtered by `query`. Cache per user because accounts have different tokens and repository access. */
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

  /** Token writes or deletion invalidate cached access. */
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

/** The UI translates codes; English messages are only fallback. */
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
  // Push-date sorting puts active repositories first,
  // the desired empty-query order.
  url.searchParams.set('sort', 'pushed')
  // Without this parameter, the API returns only owned repositories
  // and omits organization repositories.
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

/** Without queries, GitHub already sorts correctly: latest push first. */
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
  // Match basenames first: 'sillage' seeks `moi/sillage`, not repositories whose
  // owners contain those letters. Full names are a fallback,
  // still allowing 'marl/sil'.
  const onName = subsequenceGaps(repo.name, query)
  if (onName !== null) return onName * 4 + repo.name.length

  const onFullName = subsequenceGaps(repo.fullName, query)
  if (onFullName === null) return null
  return onFullName * 4 + repo.fullName.length + 100
}
