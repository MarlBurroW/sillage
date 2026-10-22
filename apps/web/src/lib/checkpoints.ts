import { useQuery } from '@tanstack/react-query'
import type { CheckpointRestoreDto, GitFileDiffDto } from '@sillage/protocol'
import { api } from './api'
import type { TurnCheckpoint } from './chat-fold'

/**
 * Client-side turn checkpoints. File lists come from the log (`checkpoint.completed`, folded into
 * `ChatState.checkpoints`); only per-file diffs and restoration use the API, one on demand and the
 * other because it acts.
 */

/** File diff between snapshots. Immutable after turn completion. */
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

/** Show checkpoints only when they have something to display. */
export function hasChanges(checkpoint: TurnCheckpoint): boolean {
  return checkpoint.status === 'ready' && checkpoint.files.length > 0
}

/** Added and removed lines across the turn, excluding binaries. */
export function sumLines(checkpoint: TurnCheckpoint): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const file of checkpoint.files) {
    added += file.added ?? 0
    removed += file.removed ?? 0
  }
  return { added, removed }
}
