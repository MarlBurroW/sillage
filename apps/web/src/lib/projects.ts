import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CloneJobDto, ProjectDto } from '@sillage/protocol'
import { api } from './api'

const PROJECTS_KEY = ['projects']

export function useProjects() {
  return useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: () => api.get<ProjectDto[]>('/api/projects'),
    staleTime: 30_000,
  })
}

export interface CreateProjectInput {
  name: string
  workspacePath: string
  visibility: 'private' | 'shared'
}

export function useCreateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateProjectInput) => api.post<ProjectDto>('/api/projects', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROJECTS_KEY }),
  })
}

export interface StartCloneInput {
  url: string
  name: string
  parentDir: string
  directory: string
  visibility: 'private' | 'shared'
}

export function useStartClone() {
  return useMutation({
    mutationFn: (input: StartCloneInput) => api.post<CloneJobDto>('/api/projects/clone', input),
  })
}

/**
 * Avancement d'un clone.
 *
 * Interrogé à la seconde plutôt que reçu par le WebSocket : le hub est indexé par
 * conversation, et un flux qui dure une minute à la création d'un projet ne justifie pas
 * d'y ouvrir une famille d'événements.
 */
export function useCloneJob(id: string | null) {
  const queryClient = useQueryClient()

  return useQuery({
    queryKey: ['clone', id],
    queryFn: async () => {
      const job = await api.get<CloneJobDto>(`/api/projects/clone/${id}`)
      // Le projet n'existe qu'à la fin du clone : c'est le moment, et le seul, où la
      // liste affichée est périmée.
      if (job.status === 'done') void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY })
      return job
    },
    enabled: id !== null,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1000 : false),
  })
}

/**
 * Ordre manuel des projets.
 *
 * Appliqué localement avant la réponse du serveur : un glisser-déposer qui attend un
 * aller-retour réseau se voit, et se voit mal.
 */
export function useReorderProjects() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (ids: string[]) => api.post<{ ok: true }>('/api/projects/order', { ids }),

    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: PROJECTS_KEY })
      const previous = queryClient.getQueryData<ProjectDto[]>(PROJECTS_KEY)
      if (!previous) return { previous }

      const byId = new Map(previous.map((entry) => [entry.id, entry]))
      const next = ids.map((id) => byId.get(id)).filter((entry) => entry !== undefined)
      queryClient.setQueryData(PROJECTS_KEY, next)

      return { previous }
    },

    onError: (_error, _ids, context) => {
      // Le serveur a refusé : l'ordre affiché doit redevenir celui qu'il connaît.
      if (context?.previous) queryClient.setQueryData(PROJECTS_KEY, context.previous)
    },

    onSettled: () => queryClient.invalidateQueries({ queryKey: PROJECTS_KEY }),
  })
}

export function useUpdateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Record<string, unknown>) =>
      api.patch<{ ok: true }>(`/api/projects/${id}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROJECTS_KEY }),
  })
}

export function useDeleteProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/projects/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROJECTS_KEY }),
  })
}
