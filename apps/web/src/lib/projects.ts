import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MAX_PROJECT_IMAGE_BYTES,
  type CloneJobDto,
  type InstructionsMode,
  type ProjectDto,
} from '@sillage/protocol'
import { ApiRequestError, api } from './api'
import { translate, translateError } from './i18n'

const PROJECTS_KEY = ['projects']

export function useProjects() {
  return useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: () => api.get<ProjectDto[]>('/api/projects'),
    staleTime: 30_000,
  })
}

/** Un dossier déjà là (`workspacePath`), ou un dossier à créer dans `parentDir`. */
export type CreateProjectInput = (
  | { name: string; workspacePath: string; visibility: 'private' | 'shared' }
  | { name: string; parentDir: string; directory: string; visibility: 'private' | 'shared' }
) & { instructionsMode?: InstructionsMode }

export function useCreateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateProjectInput) => api.post<ProjectDto>('/api/projects', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY })
      // Le serveur mémorise le dossier parent d'un projet créé de zéro : le formulaire
      // suivant doit le proposer sans attendre un rechargement.
      void queryClient.invalidateQueries({ queryKey: ['user-settings'] })
    },
  })
}

export interface StartCloneInput {
  url: string
  name: string
  parentDir: string
  directory: string
  visibility: 'private' | 'shared'
  instructionsMode?: InstructionsMode
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

/** Côté du carré auquel une image matricielle est ramenée avant l'envoi. */
const IMAGE_SIDE = 256

/**
 * Ramène une photo ou une capture à un petit carré PNG.
 *
 * L'image s'affiche en quelques dizaines de pixels : envoyer les mégaoctets d'une photo
 * de téléphone ferait buter sur le plafond du serveur pour rien. Le carré est obtenu par
 * des marges transparentes et non par un rognage, qui couperait un logo allongé. Un SVG
 * part tel quel, et un fichier que le navigateur ne sait pas décoder aussi : le serveur
 * dira ce qu'il en pense.
 */
async function shrinkImage(file: File): Promise<Blob> {
  if (file.type === 'image/svg+xml') return file

  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return file

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = IMAGE_SIDE
  const scale = Math.min(IMAGE_SIDE / bitmap.width, IMAGE_SIDE / bitmap.height)
  const width = bitmap.width * scale
  const height = bitmap.height * scale
  canvas
    .getContext('2d')
    ?.drawImage(bitmap, (IMAGE_SIDE - width) / 2, (IMAGE_SIDE - height) / 2, width, height)
  bitmap.close()

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? file), 'image/png'))
}

export function useSetProjectImage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const image = await shrinkImage(file)
      if (image.size > MAX_PROJECT_IMAGE_BYTES) {
        throw new ApiRequestError(
          413,
          'project_image_too_large',
          translate('error.project_image_too_large', {
            maxKb: Math.round(MAX_PROJECT_IMAGE_BYTES / 1024),
          }),
        )
      }

      // `fetch` directement, comme pour les pièces jointes : le navigateur compose
      // lui-même l'en-tête multipart, frontière comprise.
      const body = new FormData()
      body.append('file', image, file.name)
      const response = await fetch(`/api/projects/${id}/image`, {
        method: 'PUT',
        credentials: 'same-origin',
        body,
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { code: string; message: string; params?: Record<string, string | number> }
        } | null
        const error = payload?.error
        throw new ApiRequestError(
          response.status,
          error?.code ?? 'unknown',
          error
            ? translateError(error.code, error.message, error.params)
            : translate('error.http', { status: response.status }),
        )
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROJECTS_KEY }),
  })
}

export function useRemoveProjectImage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/projects/${id}/image`),
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
