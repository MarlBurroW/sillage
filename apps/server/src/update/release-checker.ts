import type { ReleaseNote, VersionInfo } from '@sillage/protocol'
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

  async getVersionInfo(forceRefresh = false): Promise<VersionInfo> {
    const stale =
      this.fetchedAt === null || Date.now() - this.fetchedAt > CACHE_TTL_MS
    if (forceRefresh || stale) await this.refresh()

    const installed = CURRENT_VERSION
    const installedParsable = parseVersion(installed) !== null
    const published = (this.releases ?? [])
      .filter((r) => !r.draft && !r.prerelease)
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name))

    const latest = published[0]?.tag_name.replace(/^v/, '') ?? null
    const newer = installedParsable
      ? published.filter((r) => compareVersions(r.tag_name, installed) > 0)
      : []

    return {
      version: installed,
      channel: detectChannel(),
      latest,
      // Unparseable development versions must never trigger update suggestions.
      updateAvailable: installedParsable && newer.length > 0,
      releases: newer.map(toNote),
      checkedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
      checkError: this.checkError,
    }
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
