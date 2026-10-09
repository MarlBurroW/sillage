import type { GitChangeKind } from '@sillage/protocol'
import type { MessageKey } from '../../../lib/i18n'

/**
 * Lettre et teinte par nature de changement, les mêmes que l'explorateur de fichiers :
 * un fichier marqué `M` en orange dans l'arborescence doit l'être aussi ici. La lettre
 * double la couleur, parce que distinguer cinq teintes proches est difficile, et
 * impossible pour qui perçoit mal les couleurs.
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

/** Dossier et nom séparés : le nom porte le regard, le dossier reste lisible en retrait. */
export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf('/')
  return at === -1 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
}
