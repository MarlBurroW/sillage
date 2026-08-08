import { useQuery } from '@tanstack/react-query'
import type { CommitDiffDto, CommitListDto } from '@sillage/protocol'
import { api } from './api'

/** Commits chargés d'un coup, et pas à pas ensuite. */
export const COMMIT_PAGE = 30

/**
 * Les derniers commits de la branche de la conversation.
 *
 * `limit` grandit au lieu de paginer par décalage : la liste entière est relue, ce qui
 * évite de recoller des pages qui ont pu bouger entre deux lectures. Un commit vient
 * s'ajouter en tête à chaque `git commit` de l'agent, et un rebase peut réécrire tout
 * ce qu'on avait déjà. Relire cent lignes de `git log` ne coûte rien.
 */
export function useCommits(conversationId: string, limit: number) {
  return useQuery({
    queryKey: ['commits', conversationId, limit],
    queryFn: () =>
      api.get<CommitListDto>(`/api/conversations/${conversationId}/commits?limit=${limit}`),
    // Comme le diff : relu à l'ouverture de l'onglet et à la fin d'un tour, jamais en
    // boucle. Chaque lecture lance un process git.
    staleTime: Infinity,
    refetchOnMount: 'always',
  })
}

/** Le diff d'un commit, demandé seulement quand on le déplie. */
export function useCommitDiff(conversationId: string, hash: string, enabled: boolean) {
  return useQuery({
    queryKey: ['commit-diff', conversationId, hash],
    queryFn: () =>
      api.get<CommitDiffDto>(`/api/conversations/${conversationId}/commits/${hash}/diff`),
    // Un commit est immuable : une fois lu, il n'y a plus de raison d'y revenir.
    staleTime: Infinity,
    enabled,
  })
}
