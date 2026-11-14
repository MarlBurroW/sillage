import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import { boardLinks, type Db, type ProjectRow } from '@sillage/db'
import type { WorktreePullRequest } from '@sillage/protocol'
import { GitHubIssues, type FetchLike, type GitHubPullRequest } from '../board/github-issues.js'
import type { Paths } from '../config.js'
import { credentialEnv } from '../git-credential/helper.js'
import { githubRepoFromRemote } from '../git-credentials/github.js'
import type { GitCredentialStore } from '../git-credentials/store.js'

const exec = promisify(execFile)
const REFRESH_MS = 2 * 60_000
type Snapshot = Map<string, WorktreePullRequest>
interface Entry { key: string; at: number; pending: boolean; pulls: Snapshot }

/** Read-only forge metadata and fetched refs. Never block the sidebar on the network. */
export class WorktreeRemoteStatus {
  private readonly cache = new Map<string, Entry>()
  onRefreshed: (projectId: string) => void = () => {}

  constructor(
    private readonly db: Db,
    private readonly credentials: Pick<GitCredentialStore, 'resolve'>,
    private readonly paths: Pick<Paths, 'data' | 'database'>,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  get(project: ProjectRow, branches: string[]): Snapshot {
    if (branches.length === 0) return new Map()
    const link = this.db.select().from(boardLinks).where(eq(boardLinks.projectId, project.id)).get()
    const key = JSON.stringify([project.workspacePath, project.ownerId, link?.repo, link?.userId])
    let entry = this.cache.get(project.id)
    if (!entry || entry.key !== key) {
      entry = { key, at: 0, pending: false, pulls: new Map() }
      this.cache.set(project.id, entry)
    }
    if (!entry.pending && Date.now() - entry.at > REFRESH_MS) {
      entry.pending = true
      const current = entry
      void this.refresh(project, branches, link).then((pulls) => {
        current.pulls = pulls
      }).catch(() => {
        // Missing credentials or an offline forge must not turn unknown into merged.
        current.pulls = new Map()
      }).finally(() => {
        current.at = Date.now()
        current.pending = false
        if (this.cache.get(project.id) === current) this.onRefreshed(project.id)
      })
    }
    return entry.pulls
  }

  private async refresh(project: ProjectRow, branches: string[], link: typeof boardLinks.$inferSelect | undefined): Promise<Snapshot> {
    const repo = project.workspacePath
    const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd: repo, timeout: 5_000 })
    const origin = githubRepoFromRemote(stdout.trim())
    // Ignore custom fetch mappings: automatic refresh must never move local branches.
    const fetched = exec('git', ['fetch', '--no-tags', '--refmap=', 'origin', '+refs/heads/*:refs/remotes/origin/*'], {
      cwd: repo, timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, ...credentialEnv(this.paths, project.ownerId), GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
    }).catch(() => undefined)
    const pulls: Snapshot = new Map()
    if (link && origin) {
      const credential = this.credentials.resolve(link.userId, 'github.com')
      if (credential) {
        const client = new GitHubIssues(credential.token, link.repo, this.fetcher)
        const owner = origin.split('/')[0]!
        // Bound concurrency and requests even when a project has many old worktrees.
        const unique = [...new Set(branches)]
        let next = 0
        await Promise.all(Array.from({ length: Math.min(3, unique.length) }, async () => {
          while (next < unique.length) {
            const branch = unique[next++]!
            try {
              const candidates = await client.listPullRequests(`${owner}:${branch}`)
              const pull = selectPullRequest(candidates, origin, link.repo, branch)
              if (!pull) continue
              const checks = pull.state === 'open' ? await client.checks(pull.head.sha).catch(() => null) : null
              pulls.set(branch, {
                number: pull.number, url: pull.html_url, head: pull.head.sha, base: pull.base.ref, checks,
                state: pull.merged_at ? 'merged' : pull.state === 'closed' ? 'closed' : pull.draft ? 'draft' : 'open',
              })
            } catch {
              // A failed lookup leaves the normal Git assessment authoritative.
            }
          }
        }))
      }
    }
    await fetched
    return pulls
  }
}

/** The API sorts by last update: a newly opened PR supersedes an old merge of a reused branch. */
export function selectPullRequest(pulls: GitHubPullRequest[], origin: string, baseRepo: string, branch: string): GitHubPullRequest | undefined {
  const matching = pulls.filter((pull) => pull.head.ref === branch &&
    pull.head.repo?.full_name.toLowerCase() === origin.toLowerCase() &&
    pull.base.repo.full_name.toLowerCase() === baseRepo.toLowerCase())
  return matching.find((pull) => pull.state === 'open') ?? matching[0]
}
