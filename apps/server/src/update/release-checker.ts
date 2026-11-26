import type { ReleaseHistory, ReleaseNote, VersionInfo } from '@sillage/protocol'
import { detectChannel } from './channel.js'
import { CURRENT_VERSION, compareVersions, parseVersion } from './version.js'

const GITHUB_REPO = 'MarlBurroW/sillage'

const CACHE_TTL_MS = 60 * 60 * 1000

interface GithubRelease {
  tag_name: string
  name: string | null
  body: string | null
  published_at: string
  html_url: string
  draft: boolean
  prerelease: boolean
  assets: Array<{ name: string; browser_download_url: string }>
}

/** Queries GitHub for the latest release. Unauthenticated requests are limited to 60/hour/IP: cache for an hour, and retain the latest known response on failure instead of breaking About screens. */
export class ReleaseChecker {
  private releases: GithubRelease[] | null = null
  private fetchedAt: number | null = null
  private checkError: VersionInfo['checkError'] = null
  private inflight: Promise<void> | null = null

  /** `installed` is fixed at build time; tests pass their own. */
  constructor(private readonly installed: string = CURRENT_VERSION) {}

  async getVersionInfo(forceRefresh = false): Promise<VersionInfo> {
    await this.ensureFresh(forceRefresh)
    const published = this.published()
    const newer = this.newer(published)
    return {
      version: this.installed,
      channel: detectChannel(),
      latest: published[0]?.tag_name.replace(/^v/, '') ?? null,
      updateAvailable: newer.length > 0,
      releases: newer.map(toNote),
      checkedAt: this.checkedAt(),
      checkError: this.checkError,
    }
  }

  /** Every release from the same cached reply, placed against the installed version. */
  async getReleaseHistory(): Promise<ReleaseHistory> {
    await this.ensureFresh(false)
    const published = this.published()
    const comparable = parseVersion(this.installed) !== null
    return {
      version: this.installed,
      updateAvailable: this.newer(published).length > 0,
      releases: published.map((release) => {
        const order = compareVersions(release.tag_name, this.installed)
        return {
          ...toNote(release),
          relation: !comparable ? null : order > 0 ? 'newer' : order === 0 ? 'installed' : 'older',
        }
      }),
      checkedAt: this.checkedAt(),
      checkError: this.checkError,
    }
  }

  private async ensureFresh(forceRefresh: boolean): Promise<void> {
    const stale =
      this.fetchedAt === null || Date.now() - this.fetchedAt > CACHE_TTL_MS
    if (forceRefresh || stale) await this.refresh()
  }

  private published(): GithubRelease[] {
    return (this.releases ?? [])
      .filter((r) => !r.draft && !r.prerelease)
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name))
  }

  private newer(published: GithubRelease[]): GithubRelease[] {
    // Unparseable development versions must never trigger update suggestions.
    if (parseVersion(this.installed) === null) return []
    return published.filter((r) => compareVersions(r.tag_name, this.installed) > 0)
  }

  private checkedAt(): string | null {
    return this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null
  }

  /** Release `tag` tarball URL for the current platform, if known. */
  findAsset(tag: string): string | null {
    const release = (this.releases ?? []).find(
      (r) => r.tag_name.replace(/^v/, '') === tag.replace(/^v/, ''),
    )
    if (!release) return null
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const asset = release.assets.find((a) => a.name.endsWith(`${platform}-${arch}.tar.gz`))
    return asset?.browser_download_url ?? null
  }

  private refresh(): Promise<void> {
    // Only one GitHub request at a time despite concurrent refreshes.
    this.inflight ??= this.doRefresh().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doRefresh(): Promise<void> {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`,
        {
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'sillage-update-checker',
          },
          signal: AbortSignal.timeout(10_000),
        },
      )
      if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
        this.checkError = 'rate_limited'
        return
      }
      if (!res.ok) {
        this.checkError = 'network'
        return
      }
      this.releases = (await res.json()) as GithubRelease[]
      this.fetchedAt = Date.now()
      this.checkError = null
    } catch {
      // Network failures/timeouts preserve caches and report the failure.
      this.checkError = 'network'
    }
  }
}

function toNote(release: GithubRelease): ReleaseNote {
  return {
    tag: release.tag_name,
    name: release.name ?? release.tag_name,
    publishedAt: release.published_at,
    body: release.body ?? '',
    htmlUrl: release.html_url,
  }
}
