import type { FileContentDto } from '@sillage/protocol'
import { api } from './api'
import { workspaceApiBase, type WorkspaceScope } from './workspace-scope'

/**
 * Lecture et écriture d'un fichier du workspace.
 *
 * Hors react-query volontairement : le contenu d'un onglet est édité en place, et un
 * cache qui le remplacerait derrière l'utilisateur écraserait sa saisie. C'est
 * l'onglet qui décide quand relire.
 */

export function readFile(scope: WorkspaceScope, path: string): Promise<FileContentDto> {
  return api.get<FileContentDto>(
    `${workspaceApiBase(scope)}/file?path=${encodeURIComponent(path)}`,
  )
}

/** Renvoie la nouvelle empreinte. `fingerprint: null` écrase sciemment. */
export function writeFile(
  scope: WorkspaceScope,
  path: string,
  content: string,
  fingerprint: string | null,
): Promise<{ fingerprint: string }> {
  return api.put<{ fingerprint: string }>(`${workspaceApiBase(scope)}/file`, {
    path,
    content,
    fingerprint,
  })
}

export function rawFileUrl(scope: WorkspaceScope, path: string): string {
  return `${workspaceApiBase(scope)}/file/raw?path=${encodeURIComponent(path)}`
}

/** Le navigateur reçoit le flux directement, même pour les fichiers trop gros pour l'éditeur. */
export function downloadFile(scope: WorkspaceScope, path: string): void {
  const anchor = document.createElement('a')
  anchor.href = `${workspaceApiBase(scope)}/file/download?path=${encodeURIComponent(path)}`
  anchor.download = path.split('/').pop() ?? path
  // Une erreur HTTP éventuelle ne doit pas remplacer l'IDE et ses brouillons.
  anchor.target = '_blank'
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}
