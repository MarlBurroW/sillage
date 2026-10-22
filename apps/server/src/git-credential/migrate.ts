import { readLocalCredentialHelpers, writeLocalCredentialHelpers } from '../git.js'
import type { Paths } from '../config.js'
import { credentialHelperCommand, credentialLauncherPath } from './helper.js'

/** Upgrades credential helpers in existing clones. Previously `.git/config` recorded release-specific Node and `.mjs` paths, which disappear when old releases or Node versions are removed, breaking `git push` with Node traces. Rewrite these entries to the stable launcher at startup. */

/** Parses commands emitted by `shellQuote`: single-quoted words with apostrophes encoded as `'\''`. This is deliberately not a full shell parser; it only recognizes Sillage's own output. Unknown forms return null and remain untouched. */
export function splitQuotedWords(command: string): string[] | null {
  const words: string[] = []
  let index = 0
  while (index < command.length) {
    if (command[index] === ' ') {
      index++
      continue
    }
    let word = ''
    while (index < command.length && command[index] !== ' ') {
      if (command[index] === "'") {
        const close = command.indexOf("'", index + 1)
        if (close === -1) return null
        word += command.slice(index + 1, close)
        index = close + 1
      } else if (command[index] === '\\' && index + 1 < command.length) {
        word += command[index + 1]
        index += 2
      } else {
        word += command[index]
        index++
      }
    }
    words.push(word)
  }
  return words
}

function argAfter(words: string[], name: string): string | undefined {
  const index = words.indexOf(name)
  return index === -1 ? undefined : words[index + 1]
}

type Entry = { kind: 'current' } | { kind: 'legacy'; ownerId: string } | { kind: 'other' }

/** Classifies entries for this instance. Upgrade legacy entries only when they target this database: test servers with separate data directories may register production repositories and must not hijack their helpers. */
function classify(value: string, paths: Pick<Paths, 'data' | 'database'>): Entry {
  if (!value.startsWith('!')) return { kind: 'other' }
  const words = splitQuotedWords(value.slice(1))
  if (!words || words.length < 2) return { kind: 'other' }
  if (words[0] === credentialLauncherPath(paths)) return { kind: 'current' }

  const ownerId = argAfter(words, '--owner')
  if (words[1]?.endsWith('/sillage-git-credential.mjs') && argAfter(words, '--db') === paths.database && ownerId) {
    return { kind: 'legacy', ownerId }
  }
  return { kind: 'other' }
}

/** Upgraded helper list or null when unchanged. Preserve user helpers and replace legacy Sillage entries in place. Add an empty value before the first Sillage entry when nothing precedes it, matching clone behavior since 0fd5b4e; otherwise macOS Keychain answers first. Collapse entries becoming identical. */
export function upgradeHelperList(values: string[], paths: Pick<Paths, 'data' | 'database'>): string[] | null {
  const entries = values.map((value) => classify(value, paths))
  if (!entries.some((entry) => entry.kind === 'legacy')) return null

  const result: string[] = []
  let sawEmpty = false
  for (const [index, value] of values.entries()) {
    const entry = entries[index]!
    if (entry.kind === 'other') {
      if (value === '') sawEmpty = true
      result.push(value)
      continue
    }
    const next = entry.kind === 'legacy' ? credentialHelperCommand(paths, entry.ownerId) : value
    if (result.includes(next)) continue
    if (!sawEmpty) {
      result.push('')
      sawEmpty = true
    }
    result.push(next)
  }
  return result
}

/** Visits project repositories, skipping missing or nongit directories so cleanup cannot block startup. Idempotent: already-current repositories are not rewritten. */
export async function upgradeCredentialHelpers(
  workspaces: Iterable<string>,
  paths: Pick<Paths, 'data' | 'database'>,
): Promise<string[]> {
  const upgraded: string[] = []
  for (const cwd of new Set(workspaces)) {
    const values = await readLocalCredentialHelpers(cwd)
    if (!values) continue
    const next = upgradeHelperList(values, paths)
    if (!next) continue
    try {
      await writeLocalCredentialHelpers(cwd, next)
      upgraded.push(cwd)
    } catch {
      // Read-only or locked configuration: retry on next startup.
    }
  }
  return upgraded
}
