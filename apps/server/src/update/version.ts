/** Installed version. Release tsup builds replace `process.env.SILLAGE_VERSION` with git-tag literals, fixing values in bundles. Development tsx without bundling lacks the variable and falls back to `dev`. */
export const CURRENT_VERSION: string = process.env.SILLAGE_VERSION ?? 'dev'

/** Local version comparison rather than semver dependencies because only our `vX.Y.Z` tags matter. Treat unparseable versions (`dev`, suffixed git describe) as older than parsable ones; checkers must never offer updates when installed versions are unparseable. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1
  if (pa[0] !== pb[0]) return pa[0] - pb[0]
  if (pa[1] !== pb[1]) return pa[1] - pb[1]
  return pa[2] - pb[2]
}

export function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}
