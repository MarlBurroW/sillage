import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
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

/**
 * A project created here joins a rail its account composed: otherwise it would show while open
 * and vanish on leaving. Without pins the rail follows recent visits, which already shows it.
 * Best effort: the project exists either way, and the rail's own entry adds it later.
 */
async function keepCreatedInRail(queryClient: QueryClient, id: string): Promise<void> {
  if (!queryClient.getQueryData<ProjectDto[]>(PROJECTS_KEY)?.some((entry) => entry.pinned)) return
  await api.put(`/api/projects/${id}/pin`, {}).catch(() => undefined)
}

/** An existing directory (`workspacePath`) or one to create within `parentDir`. */
export type CreateProjectInput = (
  | { name: string; workspacePath: string; visibility: 'private' | 'shared' }
  | { name: string; parentDir: string; directory: string; visibility: 'private' | 'shared' }
) & { instructionsMode?: InstructionsMode }

export function useCreateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateProjectInput) => {
      const project = await api.post<ProjectDto>('/api/projects', input)
      await keepCreatedInRail(queryClient, project.id)
      return project
    },
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
      if (job.status === 'done') {
        // Once, when the clone lands: a later refetch must not bring back a project taken off the rail.
        const landed = queryClient.getQueryData<CloneJobDto>(['clone', id])?.status !== 'done'
        if (landed && job.projectId) await keepCreatedInRail(queryClient, job.projectId)
        void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY })
      }
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
 * Rail pins, several at once: an account without pins sees an implicit rail, and its first choice
 * turns that whole rail into pins (see `rail-projects.ts`). Apply locally before the replies and
 * refresh once, so marks appear on click and never flicker through a half-written set. The server
 * stores pins per account so they follow users across devices.
 */
export function useSetPins() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (pins: { id: string; pinned: boolean }[]) =>
      Promise.all(pins.map(({ id, pinned }) =>
        pinned
          ? api.put<{ pinned: boolean }>(`/api/projects/${id}/pin`, {})
          : api.delete<{ pinned: boolean }>(`/api/projects/${id}/pin`))),

    onMutate: async (pins) => {
      await queryClient.cancelQueries({ queryKey: PROJECTS_KEY })
      const previous = queryClient.getQueryData<ProjectDto[]>(PROJECTS_KEY)
      const next = new Map(pins.map((pin) => [pin.id, pin.pinned]))
      queryClient.setQueryData<ProjectDto[]>(PROJECTS_KEY, (current) =>
        current?.map((entry) => (next.has(entry.id) ? { ...entry, pinned: next.get(entry.id)! } : entry)),
      )
      return { previous }
    },

    onError: (_error, pins, context) => {
      // Roll back only the pins: Git status or counters may have changed meanwhile.
      const before = new Map(context?.previous?.map((entry) => [entry.id, entry.pinned]))
      queryClient.setQueryData<ProjectDto[]>(PROJECTS_KEY, (current) =>
        current?.map((entry) => (pins.some((pin) => pin.id === entry.id) && before.has(entry.id) ? { ...entry, pinned: before.get(entry.id)! } : entry)),
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
