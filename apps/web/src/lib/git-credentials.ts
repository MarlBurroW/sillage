import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { GitCredentialListDto, GitRepoListDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Accès aux forges git du compte courant.
 *
 * Comme pour les secrets, aucun hook ne lit un jeton : l'API n'en rend aucun. Ce qui
 * change ici, c'est que le jeton sert à quelque chose de visible, la liste des dépôts,
 * et que cette liste est la seule preuve à l'écran qu'il fonctionne.
 */

const CREDENTIALS_KEY = ['git-credentials']

export const GITHUB_HOST = 'github.com'

export function useGitCredentials() {
  return useQuery({
    queryKey: CREDENTIALS_KEY,
    queryFn: () => api.get<GitCredentialListDto>('/api/git-credentials'),
  })
}

export function usePutGitCredential() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { host: string; username: string; token: string }) =>
      api.put<void>('/api/git-credentials', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY })
      // Le catalogue affiché a été constitué avec le jeton précédent.
      void queryClient.invalidateQueries({ queryKey: ['git-repos'] })
    },
  })
}

export function useDeleteGitCredential() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (host: string) =>
      api.delete<void>(`/api/git-credentials/${encodeURIComponent(host)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['git-repos'] })
    },
  })
}

/**
 * Dépôts accessibles avec le jeton GitHub, filtrés par la saisie.
 *
 * Le filtrage se fait sur le serveur, sur une liste qu'il garde en cache : c'est ce qui
 * permet d'interroger à chaque frappe sans épuiser le quota de l'API GitHub. Le résultat
 * est donc gardé par requête, chaque frappe étant une clé distincte.
 */
export function useGitRepos(query: string, enabled: boolean) {
  return useQuery({
    queryKey: ['git-repos', query],
    queryFn: () =>
      api.get<GitRepoListDto>(
        `/api/git-credentials/${GITHUB_HOST}/repos?q=${encodeURIComponent(query)}`,
      ),
    enabled,
    // Le cache du serveur est de cinq minutes ; en tenir un plus long ici ne montrerait
    // qu'une liste plus vieille que celle qu'une nouvelle requête aurait rendue.
    staleTime: 60_000,
    // Le résultat précédent reste affiché pendant la frappe suivante : sans ça, la liste
    // clignote à vide entre deux lettres.
    placeholderData: (previous) => previous,
  })
}
