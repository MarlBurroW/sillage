/** Minimal GitHub API for board issue/comment reads and writes. Injectable `fetch` lets tests simulate GitHub. */

/** Replaceable for UI checks using local fake GitHub servers: demonstrations must never reach real GitHub. */
const API = process.env.SILLAGE_GITHUB_API_URL?.replace(/\/+$/, '') || 'https://api.github.com'
const PER_PAGE = 100
/** Initial reads stop here for large repositories: boards are not mirrors. */
const MAX_PAGES = 10

export interface GitHubIssue {
  number: number
  html_url: string
  title: string
  body: string | null
  state: 'open' | 'closed'
  state_reason: string | null
  labels: Array<{ name: string } | string>
  user: { login: string } | null
  comments: number
  created_at: string
  updated_at: string
  closed_at: string | null
  /** Present on pull requests, also returned by the issues API. */
  pull_request?: unknown
}

export interface GitHubComment {
  id: number
  html_url: string
  body: string | null
  user: { login: string } | null
  created_at: string
  updated_at: string
  issue_url: string
}

export interface GitHubRepoInfo {
  full_name: string
  has_issues: boolean
  permissions?: { push?: boolean; triage?: boolean }
}

/** Codes are translated by the interface; `transient` determines whether retries help. */
export class BoardGitHubError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transient = false,
  ) {
    super(message)
    this.name = 'BoardGitHubError'
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export class GitHubIssues {
  constructor(
    private readonly token: string,
    private readonly repo: string,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  repoInfo(): Promise<GitHubRepoInfo> {
    return this.call<GitHubRepoInfo>('GET', `/repos/${this.repo}`)
  }

  /** Issues excluding pull requests, oldest modification first. */
  async listIssues(query: { state: 'open' | 'closed' | 'all'; labels?: string; since?: string }): Promise<GitHubIssue[]> {
    const params: Record<string, string> = { state: query.state, sort: 'updated', direction: 'asc' }
    if (query.labels) params.labels = query.labels
    if (query.since) params.since = query.since
    const all = await this.paginate<GitHubIssue>(`/repos/${this.repo}/issues`, params)
    return all.filter((issue) => issue.pull_request === undefined)
  }

  getIssue(number: number): Promise<GitHubIssue> {
    return this.call<GitHubIssue>('GET', `/repos/${this.repo}/issues/${number}`)
  }

  createIssue(body: { title: string; body: string; labels?: string[] }): Promise<GitHubIssue> {
    return this.call<GitHubIssue>('POST', `/repos/${this.repo}/issues`, body)
  }

  updateIssue(
    number: number,
    body: { title?: string; body?: string; state?: 'open' | 'closed'; state_reason?: string; labels?: string[] },
  ): Promise<GitHubIssue> {
    return this.call<GitHubIssue>('PATCH', `/repos/${this.repo}/issues/${number}`, body)
  }

  /** Repository comments modified since `since`, one request for the entire board. */
  listRepoComments(since: string): Promise<GitHubComment[]> {
    return this.paginate<GitHubComment>(`/repos/${this.repo}/issues/comments`, { since, sort: 'updated', direction: 'asc' })
  }

  listIssueComments(number: number): Promise<GitHubComment[]> {
    return this.paginate<GitHubComment>(`/repos/${this.repo}/issues/${number}/comments`, {})
  }

  createComment(number: number, body: string): Promise<GitHubComment> {
    return this.call<GitHubComment>('POST', `/repos/${this.repo}/issues/${number}/comments`, { body })
  }

  private async paginate<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const all: T[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const query = new URLSearchParams({ ...params, per_page: String(PER_PAGE), page: String(page) })
      const batch = await this.call<T[]>('GET', `${path}?${query}`)
      all.push(...batch)
      if (batch.length < PER_PAGE) break
    }
    return all
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await this.fetcher(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'sillage',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
    } catch {
      throw new BoardGitHubError('board_github_unreachable', 'GitHub could not be reached.', true)
    }
    if (response.ok) return (await response.json()) as T

    if (response.status === 401) throw new BoardGitHubError('board_github_token_rejected', 'GitHub rejected the token.')
    if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
      throw new BoardGitHubError('board_github_rate_limited', 'GitHub rate limit reached.', true)
    }
    if (response.status === 403) throw new BoardGitHubError('board_github_forbidden', 'GitHub refused the request.')
    if (response.status === 404) throw new BoardGitHubError('board_github_not_found', 'Repository or issue not found.')
    if (response.status === 410) throw new BoardGitHubError('board_github_issues_disabled', 'Issues are disabled on this repository.')
    if (response.status === 422) throw new BoardGitHubError('board_github_invalid', 'GitHub refused the content.')
    throw new BoardGitHubError('board_github_unreachable', `GitHub answered ${response.status}.`, response.status >= 500)
  }
}

export function labelNames(issue: GitHubIssue): string[] {
  return issue.labels.map((label) => (typeof label === 'string' ? label : label.name))
}

/** Issue number parsed from a comment's `issue_url`. */
export function commentIssueNumber(comment: GitHubComment): number | null {
  const match = /\/issues\/(\d+)$/.exec(comment.issue_url)
  return match ? Number(match[1]) : null
}
