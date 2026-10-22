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

/** An existing directory (`workspacePath`) or one to create within `parentDir`. */
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
      // The server remembers the parent directory for newly created projects: the next form should
      // offer it without requiring reload.
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
 * Clone progress. Poll once per second rather than using WebSocket: the hub is
 * conversation-indexed, and a minute-long project-creation stream does not warrant a new event
 * family.
 */
export function useCloneJob(id: string | null) {
  const queryClient = useQueryClient()

  return useQuery({
    queryKey: ['clone', id],
    queryFn: async () => {
      const job = await api.get<CloneJobDto>(`/api/projects/clone/${id}`)
      // The project exists only after cloning completes: only then does the displayed list become stale.
      if (job.status === 'done') void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY })
      return job
    },
    enabled: id !== null,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1000 : false),
  })
}

/**
 * Manual project order. Apply locally before the server reply so drag-and-drop does not visibly
 * wait for a network round trip.
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
      // Server rejection: restore the server-known order.
      if (context?.previous) queryClient.setQueryData(PROJECTS_KEY, context.previous)
    },

    onSettled: () => queryClient.invalidateQueries({ queryKey: PROJECTS_KEY }),
  })
}

/**
 * Project-switcher pin. Apply locally before the reply like conversation bookmarks: fill the star
 * on click. The server stores pins per account so they follow users across devices.
 */
export function useTogglePin() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      pinned
        ? api.put<{ pinned: boolean }>(`/api/projects/${id}/pin`, {})
        : api.delete<{ pinned: boolean }>(`/api/projects/${id}/pin`),

    onMutate: async ({ id, pinned }) => {
      await queryClient.cancelQueries({ queryKey: PROJECTS_KEY })
      const previous = queryClient.getQueryData<ProjectDto[]>(PROJECTS_KEY)
      queryClient.setQueryData<ProjectDto[]>(PROJECTS_KEY, (current) =>
        current?.map((entry) => (entry.id === id ? { ...entry, pinned } : entry)),
      )
      return { previous }
    },

    onError: (_error, { id }, context) => {
      // Roll back only the pin: Git status or counters may have changed meanwhile.
      const before = context?.previous?.find((entry) => entry.id === id)
      if (!before) return
      queryClient.setQueryData<ProjectDto[]>(PROJECTS_KEY, (current) =>
        current?.map((entry) => (entry.id === id ? { ...entry, pinned: before.pinned } : entry)),
      )
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

/** Square side length used to resize raster images before upload. */
const IMAGE_SIDE = 256

/**
 * Resize a photo or screenshot to a small PNG square. Display size is only a few dozen pixels, so
 * phone-photo megabytes would needlessly hit server limits. Pad transparently rather than crop to
 * preserve wide logos. Send SVGs and browser-undecodable files unchanged and let the server
 * validate them.
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

      // Use `fetch` directly, like attachments: let the browser build the multipart header including its boundary.
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
