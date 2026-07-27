import type { EditDiffDto } from '@sillage/protocol'
import type { FileUpdateChange, ThreadItem } from '@sillage/protocol/codex/v2'
import { additionDiff, deletionDiff } from '../../diff-lines.js'
import { toWorkspacePath } from '../claude/file-edits.js'

/**
 * Ce qu'un `fileChange` a fait d'un fichier.
 *
 * Rien à calculer ici, contrairement à Claude : l'item porte un diff unifié par
 * fichier touché, produit par le CLI au moment où il a appliqué le patch.
 */
export function describeEdit(completedRaw: unknown, cwd: string, path: string): EditDiffDto {
  const item = (completedRaw as { item?: ThreadItem } | null)?.item
  const changes: FileUpdateChange[] = item?.type === 'fileChange' ? item.changes : []

  const change = changes.find((entry) => toWorkspacePath(cwd, entry.path) === path)
  if (!change) {
    return {
      path,
      kind: 'unavailable',
      patch: '',
      content: '',
      partial: false,
      reason: "Le détail de cet appel n'a pas été conservé.",
    }
  }

  return { path, kind: 'patch', patch: toPatch(path, change), content: '', partial: false, reason: null }
}

/**
 * Un `update` porte un vrai diff unifié, auquel il ne manque que l'en-tête
 * `diff --git` qui dit de quel fichier il parle. Une création ou une suppression, en
 * revanche, porte le contenu brut : sans cette distinction, la création s'affichait
 * comme un diff sans aucune section, donc comme rien du tout.
 */
function toPatch(path: string, change: FileUpdateChange): string {
  if (change.kind.type === 'add') return additionDiff(path, change.diff)
  if (change.kind.type === 'delete') return deletionDiff(path, change.diff)
  return `diff --git a/${path} b/${path}\n${change.diff}`
}
