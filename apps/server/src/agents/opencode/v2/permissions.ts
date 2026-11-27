/**
 * "Allow for the session" on opencode 2.x.
 *
 * 2.x has no session scope: replying `always` saves a rule in opencode's database, per
 * project and under a widened pattern (`echo *` for `echo one`), which then applies to every
 * later Sillage conversation and to the user's own TUI (probed on 2.4.2). Sillage therefore
 * always replies `once` and keeps the session scope itself: it remembers the `save` patterns
 * opencode proposed and answers matching requests of the same conversation on its own.
 */

/**
 * opencode's own wildcard (copied from the 2.4.2 binary): `*` and `?` globs over the whole
 * string, a trailing ` *` also matching the bare command, backslashes read as slashes, and
 * case-insensitive on Windows.
 */
export function matchesPattern(value: string, pattern: string, platform: NodeJS.Platform = process.platform): boolean {
  let source = pattern.replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  if (source.endsWith(' .*')) source = `${source.slice(0, -3)}( .*)?`
  return new RegExp(`^${source}$`, platform === 'win32' ? 'si' : 's').test(value.replaceAll('\\', '/'))
}

/** Patterns approved for the session, by opencode action (`shell`, `edit`, `webfetch`…). */
export class SessionGrants {
  private readonly patterns = new Map<string, Set<string>>()

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  /** Remembers what opencode would have saved; without `save`, the exact resources. */
  grant(action: string, resources: string[], save: string[] | undefined): void {
    const patterns = this.patterns.get(action) ?? new Set<string>()
    for (const pattern of save?.length ? save : resources) patterns.add(pattern)
    this.patterns.set(action, patterns)
  }

  /** A request is covered only when every resource matches a pattern of the same action. */
  covers(action: string, resources: string[]): boolean {
    const patterns = this.patterns.get(action)
    if (!patterns || !resources.length) return false
    return resources.every((resource) => [...patterns].some((pattern) => matchesPattern(resource, pattern, this.platform)))
  }
}
