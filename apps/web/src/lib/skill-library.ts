import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { zipSync, type Zippable } from 'fflate'
import type {
  AdoptLibrarySkillBody,
  ApiError,
  CreateLibrarySkillBody,
  DuplicateLibrarySkillBody,
  LibrarySkillDetailDto,
  LibrarySkillDto,
  LibrarySkillFileDto,
  LibrarySkillListDto,
  LibrarySkillScope,
  LocalSkillListDto,
  UpdateLibrarySkillBody,
} from '@sillage/protocol'
import { api, ApiRequestError } from './api'
import { translate, translateError } from './i18n'

/**
 * Sillage skill library delivered to CLIs as native skills. All queries share the `skill-library`
 * root: every write invalidates everything. Lists are short, and renaming or moving skills affects
 * global and project lists plus details together.
 */

const ROOT = ['skill-library']

/** Global skills plus project skills when a project is supplied. */
export function useSkillLibrary(projectId: string | null) {
  return useQuery({
    queryKey: [...ROOT, 'list', projectId],
    queryFn: () =>
      api.get<LibrarySkillListDto>(
        projectId ? `/api/skill-library?projectId=${encodeURIComponent(projectId)}` : '/api/skill-library',
      ),
    staleTime: 30_000,
  })
}

export function useLibrarySkill(id: string) {
  return useQuery({
    queryKey: [...ROOT, 'skill', id],
    queryFn: () => api.get<LibrarySkillDetailDto>(`/api/skill-library/${id}`),
  })
}

/**
 * Supporting file contents. Avoid durable caching: files edit in place and a background cache
 * replacement would overwrite user input.
 */
export function useSkillFile(id: string, path: string | null) {
  return useQuery({
    queryKey: [...ROOT, 'file', id, path],
    queryFn: () => api.get<LibrarySkillFileDto>(`/api/skill-library/${id}/files/${encodePath(path ?? '')}`),
    enabled: path !== null,
    staleTime: Infinity,
    gcTime: 0,
  })
}

/** Existing machine content: user directories (admin) and project repository. */
export function useLocalSkills(projectId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...ROOT, 'local', projectId],
    queryFn: () =>
      api.get<LocalSkillListDto>(
        projectId
          ? `/api/skill-library/local?projectId=${encodeURIComponent(projectId)}`
          : '/api/skill-library/local',
      ),
    enabled,
  })
}

function useLibraryMutation<Input, Output>(run: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ROOT }),
  })
}

export const useCreateLibrarySkill = () =>
  useLibraryMutation((input: CreateLibrarySkillBody) => api.post<LibrarySkillDto>('/api/skill-library', input))

export const useUpdateLibrarySkill = () =>
  useLibraryMutation(({ id, ...patch }: { id: string } & UpdateLibrarySkillBody) =>
    api.patch<LibrarySkillDto>(`/api/skill-library/${id}`, patch),
  )

export const useDeleteLibrarySkill = () =>
  useLibraryMutation((id: string) => api.delete<void>(`/api/skill-library/${id}`))

export const useDuplicateLibrarySkill = () =>
  useLibraryMutation(({ id, ...target }: { id: string } & DuplicateLibrarySkillBody) =>
    api.post<LibrarySkillDto>(`/api/skill-library/${id}/duplicate`, target),
  )

export const useAdoptLocalSkill = () =>
  useLibraryMutation((input: AdoptLibrarySkillBody) => api.post<LibrarySkillDto>('/api/skill-library/adopt', input))

export const useWriteSkillFile = () =>
  useLibraryMutation(({ id, path, content }: { id: string; path: string; content: string }) =>
    api.put<void>(`/api/skill-library/${id}/files/${encodePath(path)}`, { content }),
  )

export const useDeleteSkillFile = () =>
  useLibraryMutation(({ id, path }: { id: string; path: string }) =>
    api.delete<void>(`/api/skill-library/${id}/files/${encodePath(path)}`),
  )

export const useUploadSkillFile = () =>
  useLibraryMutation(({ id, path, file }: { id: string; path: string; file: Blob }) =>
    postFile<void>(`/api/skill-library/${id}/upload?path=${encodeURIComponent(path)}`, file, path),
  )

export interface ImportTarget {
  scope: LibrarySkillScope
  projectId: string | null
  /** Replace the frontmatter name when importing a skill whose name is taken. */
  name?: string
}

/**
 * Import a `.zip`, `.skill`, or browser-selected directory zipped here: the server has only one
 * import path, archives.
 */
export const useImportLibrarySkill = () =>
  useLibraryMutation(({ target, files }: { target: ImportTarget; files: File[] }) => {
    const query = new URLSearchParams({ scope: target.scope })
    if (target.projectId) query.set('projectId', target.projectId)
    if (target.name) query.set('name', target.name)
    const [first] = files
    const archive = files.length === 1 && first && !first.webkitRelativePath ? Promise.resolve(first) : zipFolder(files)
    return archive.then((blob) =>
      postFile<LibrarySkillDto>(`/api/skill-library/import?${query.toString()}`, blob, 'skill.zip'),
    )
  })

export function exportUrl(id: string): string {
  return `/api/skill-library/${id}/export`
}

/** Encode segments individually: slashes separate them and everything else must stay safe. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * Archive files from a `webkitdirectory` selection. Retain the selected directory as the first
 * level, recognized by the server as the skill directory.
 */
async function zipFolder(files: File[]): Promise<Blob> {
  const entries: Zippable = {}
  for (const file of files) {
    entries[file.webkitRelativePath || file.name] = new Uint8Array(await file.arrayBuffer())
  }
  return new Blob([zipSync(entries)], { type: 'application/zip' })
}

/** Multipart upload with translated errors, like `api` for JSON. */
async function postFile<T>(endpoint: string, file: Blob, filename: string): Promise<T> {
  const body = new FormData()
  body.append('file', file, filename)
  const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', body })
  if (response.status === 204) return undefined as T
  const text = await response.text()
  const parsed: unknown = text ? JSON.parse(text) : null
  if (!response.ok) {
    const error = (parsed as ApiError | null)?.error
    throw new ApiRequestError(
      response.status,
      error?.code ?? 'unknown',
      error
        ? translateError(error.code, error.message, error.params)
        : translate('error.http', { status: response.status }),
    )
  }
  return parsed as T
}
