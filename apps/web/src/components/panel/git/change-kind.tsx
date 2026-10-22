import type { GitChangeKind } from '@sillage/protocol'
import type { MessageKey } from '../../../lib/i18n'

/**
 * Change-kind letters and colors match explorer status: orange M means the same here. Letters
 * supplement hues for users who cannot distinguish similar colors.
 */
export const CHANGE_KINDS: Record<GitChangeKind, { letter: string; tone: string; label: MessageKey }> = {
  modified: { letter: 'M', tone: 'text-caution', label: 'git.kind.modified' },
  added: { letter: 'A', tone: 'text-positive', label: 'git.kind.added' },
  deleted: { letter: 'D', tone: 'text-critical', label: 'git.kind.deleted' },
  renamed: { letter: 'R', tone: 'text-accent', label: 'git.kind.renamed' },
  copied: { letter: 'C', tone: 'text-accent', label: 'git.kind.copied' },
  typechange: { letter: 'T', tone: 'text-caution', label: 'git.kind.typechange' },
  untracked: { letter: '?', tone: 'text-positive', label: 'git.kind.untracked' },
  conflicted: { letter: '!', tone: 'text-critical', label: 'git.kind.conflicted' },
}

/** Separate directory and basename: emphasize the name while retaining subdued location. */
export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf('/')
  return at === -1 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
}
