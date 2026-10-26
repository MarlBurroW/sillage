import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MemoryFileDto, MemoryMode, ProjectMemoryDto, PersonalMemoryDto } from '@sillage/protocol'
import { api } from './api'

/** Reread on every opening: agents write without using the UI. */
const memoryKey = (projectId: string | null) => ['memory', projectId]

export function useProjectMemory(projectId: string | null) {
  return useQuery({
    queryKey: memoryKey(projectId),
    queryFn: () => api.get<ProjectMemoryDto & Partial<Pick<PersonalMemoryDto, 'changes'>>>(projectId ? `/api/projects/${projectId}/memory` : '/api/me/memory'),
  })
}

/** Project memory location, applied at the next runner launch. */
export function useSetMemoryMode(projectId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (memoryMode: MemoryMode) => api.patch<{ ok: true }>(`/api/projects/${projectId}`, { memoryMode }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: memoryKey(projectId) })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}

export function useWriteMemoryFile(projectId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ file, content }: { file: string; content: string }) =>
      api.put<void>(`${projectId ? `/api/projects/${projectId}` : '/api/me'}/memory/${encodeURIComponent(file)}`, { content }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: memoryKey(projectId) }),
  })
}

export function useDeleteMemoryFile(projectId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (file: string) =>
      api.delete<void>(`${projectId ? `/api/projects/${projectId}` : '/api/me'}/memory/${encodeURIComponent(file)}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: memoryKey(projectId) }),
  })
}

/** Note description read from its header, explaining its subject. */
export function memoryDescription(content: string): string | null {
  const head = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? ''
  const line = head.split('\n').find((candidate) => candidate.startsWith('description:'))
  return line ? line.slice('description:'.length).trim().replace(/^["']|["']$/g, '') : null
}


/** Bound list height without hiding search matches in notes outside the current page. */
export function useMemoryBrowser(files: MemoryFileDto[] = []) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const matches = useMemo(() => {
    const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    const needle = normalize(query.trim())
    return needle ? files.filter((file) => normalize(`${file.file}\n${file.content}`).includes(needle)) : files
  }, [files, query])
  const pages = Math.max(1, Math.ceil(matches.length / 12))
  const current = Math.min(page, pages - 1)
  return {
    query,
    search: (value: string) => { setQuery(value); setPage(0) },
    page: current,
    pages,
    setPage,
    count: matches.length,
    files: matches.slice(current * 12, (current + 1) * 12),
  }
}
