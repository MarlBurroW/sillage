import { useQuery } from '@tanstack/react-query'
import type { CheckpointRestoreDto, GitFileDiffDto } from '@sillage/protocol'
import { api } from './api'
import type { TurnCheckpoint } from './chat-fold'

/**
 * Points de reprise d'un tour, côté client.
 *
 * La liste des fichiers vient du journal (`checkpoint.completed`, replié dans
 * `ChatState.checkpoints`) ; seuls le diff d'un fichier et la restauration passent par
 * l'API, le premier parce qu'il se lit à la demande, la seconde parce qu'elle agit.
 */

/** Le diff d'un fichier entre les deux captures. Immuable une fois le tour passé. */
export function useCheckpointFileDiff(
  conversationId: string,
  key: string,
  path: string,
  oldPath: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['checkpoint-diff', conversationId, key, path],
    queryFn: () =>
      api.get<GitFileDiffDto>(
        `/api/conversations/${conversationId}/checkpoints/${key}/file-diff?path=${encodeURIComponent(path)}${
          oldPath ? `&oldPath=${encodeURIComponent(oldPath)}` : ''
        }`,
      ),
    staleTime: Infinity,
    enabled,
  })
}

export function restoreCheckpoint(conversationId: string, key: string): Promise<CheckpointRestoreDto> {
  return api.post<CheckpointRestoreDto>(`/api/conversations/${conversationId}/checkpoints/${key}/restore`)
}

/** Un point de reprise vaut d'être montré quand il a quelque chose à montrer. */
export function hasChanges(checkpoint: TurnCheckpoint): boolean {
  return checkpoint.status === 'ready' && checkpoint.files.length > 0
}

/** Lignes ajoutées et retirées sur l'ensemble du tour, binaires exclus. */
export function sumLines(checkpoint: TurnCheckpoint): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const file of checkpoint.files) {
    added += file.added ?? 0
    removed += file.removed ?? 0
  }
  return { added, removed }
}
