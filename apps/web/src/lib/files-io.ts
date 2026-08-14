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
