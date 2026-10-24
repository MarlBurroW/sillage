import type { AgentKind } from './events.js'

/**
 * Each CLI's distribution and the version targeted by this Sillage release.
 *
 * Sillage no longer bundles binaries: they come from the system, so versions are not fixed by
 * the release and behavior differences become user-visible. This table provides a comparison
 * point so differences can be explained rather than silently endured.
 *
 * “Preferred”, not “tested”: we do not verify every version of every CLI, and claiming
 * otherwise would imply guarantees we cannot provide. This is the development baseline, the
 * version installed by Sillage, and the version users depart from at their own risk.
 *
 * Bump deliberately. Updating a number without checking is no better than having no number.
 *
 * One table rather than two: the package and expected version describe the same fact, and
 * separating them would invite drift at the first bump.
 */
export interface PreferredCliRelease {
  /** npm package, or the official ACP registry ID for native Antigravity archives. */
  readonly package: string
  readonly version: string
}

export const PREFERRED_CLI_RELEASES: Record<AgentKind, PreferredCliRelease> = {
  claude: { package: '@anthropic-ai/claude-code', version: '2.1.301' },
  codex: { package: '@openai/codex', version: '0.163.0' },
  opencode: { package: 'opencode-ai', version: '1.19.3' },
  antigravity: { package: 'antigravity-acp', version: '1.4.3' },
  grok: { package: '@xai-official/grok', version: '1.0.62' },
}

interface Parsed {
  major: number
  minor: number
  patch: number
}

/** Null when the string has no leading version: a CLI can return anything. */
function parse(version: string): Parsed | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) }
}

function compare(a: Parsed, b: Parsed): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/**
 * Is the installed version compatible with Sillage's target?
 *
 * Uses npm caret semantics rather than inventing a rule: the ecosystem already applies it, and
 * it fits both versioning styles we encounter. Claude publishes hundreds of patches under one
 * minor (189 for 2.1 alone), so minor-only comparison would never flag anything; Codex uses 0.x
 * and changes minor versions every few weeks, so the same comparison would constantly warn.
 * Caret handles both because for 0.y.z, the minor *is* the breaking segment.
 *
 * Two bounds: no older than the target and below the next breaking boundary.
 *
 * Null if either version is unreadable: without a valid comparison, make no claim.
 */
export function isCompatibleVersion(installed: string, preferred: string): boolean | null {
  const a = parse(installed)
  const b = parse(preferred)
  if (!a || !b) return null
  if (compare(a, b) < 0) return false
  // Upper bound: same major, and for 0.x also the same minor. Check the major
  // in both cases, otherwise 1.145 would appear compatible with
  // 0.145 solely because the minor matches.
  return a.major === b.major && (b.major > 0 || a.minor === b.minor)
}
