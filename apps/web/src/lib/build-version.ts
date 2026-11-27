/*
 * Kept free of browser-only imports so the unit tests can load it.
 */

export interface BuildVersion {
  /** What a reader recognises: `v0.45.0`, or the bare commit outside any tag. */
  label: string
  /** For a build past its tag (a hot deploy): `+12 · abc1234`. Null for a release. */
  detail: string | null
  /** A published release, whose notes exist. */
  release: boolean
}

/**
 * Release builds carry `0.45.0`; local and hot-deployed ones carry `git describe` output such as
 * `v0.45.0-12-gabc1234-dirty`, which reads as noise. Split it into the tag and what follows.
 */
export function parseBuildVersion(raw: string): BuildVersion {
  const value = raw.trim()
  const release = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(value)
  if (release && !value.endsWith('-dirty')) {
    return { label: `v${release[1]}`, detail: null, release: true }
  }
  const described = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(\d+)-g([0-9a-f]+)(-dirty)?$/.exec(value)
  if (described) {
    return { label: `v${described[1]}`, detail: `+${described[2]} · ${described[3]}`, release: false }
  }
  return { label: value.replace(/-dirty$/, ''), detail: null, release: false }
}

export function formatBuildVersion(version: BuildVersion): string {
  return version.detail ? `${version.label} ${version.detail}` : version.label
}

/**
 * Version of the build the server now serves, from the `version.json` every web build emits.
 * Null when the file is missing (a build older than it) or unreadable: the prompt then simply
 * names no version.
 */
export async function fetchDeployedVersion(): Promise<string | null> {
  try {
    const response = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (body && typeof body === 'object' && 'version' in body && typeof body.version === 'string') {
      return body.version
    }
    return null
  } catch {
    return null
  }
}
