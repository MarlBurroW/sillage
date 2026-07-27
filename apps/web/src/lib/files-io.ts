import type { FileContentDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Lecture et écriture d'un fichier du workspace.
 *
 * Hors react-query volontairement : le contenu d'un onglet est édité en place, et un
 * cache qui le remplacerait derrière l'utilisateur écraserait sa saisie. C'est
 * l'onglet qui décide quand relire.
 */

export function readFile(conversationId: string, path: string): Promise<FileContentDto> {
  return api.get<FileContentDto>(
    `/api/conversations/${conversationId}/file?path=${encodeURIComponent(path)}`,
  )
}

/** Renvoie la nouvelle empreinte. `fingerprint: null` écrase sciemment. */
export function writeFile(
  conversationId: string,
  path: string,
  content: string,
  fingerprint: string | null,
): Promise<{ fingerprint: string }> {
  return api.put<{ fingerprint: string }>(`/api/conversations/${conversationId}/file`, {
    path,
    content,
    fingerprint,
  })
}

export function rawFileUrl(conversationId: string, path: string): string {
  return `/api/conversations/${conversationId}/file/raw?path=${encodeURIComponent(path)}`
}
