import { createContext, useContext } from 'react'
import { ApiRequestError } from '../../../lib/api'
import type { WorkspaceScope } from '../../../lib/workspace-scope'

/**
 * Git action feedback: failures or useful native messages such as Already up to date. Notices may
 * offer remedies like force-pushing or deleting unmerged branches, unlike raw errors requiring
 * users to rediscover actions and options.
 */
export interface GitNotice {
  tone: 'critical' | 'info' | 'positive'
  text: string
  /** Server error code for UI case recognition. */
  code?: string
  actions?: { label: string; run: () => void }[]
}

export interface GitPaneContext {
  scope: WorkspaceScope
  notify: (notice: GitNotice | null) => void
  /** Absent when no editor is accessible. */
  openFile?: (path: string) => void
}

export const GitContext = createContext<GitPaneContext>({
  scope: '',
  notify: () => {},
})

export function useGitPane(): GitPaneContext {
  return useContext(GitContext)
}

/** Critical notice produced by an action failure, including its code. */
export function failureNotice(error: unknown, fallback: string): GitNotice {
  if (error instanceof ApiRequestError) {
    return { tone: 'critical', text: error.message, code: error.code }
  }
  return { tone: 'critical', text: error instanceof Error ? error.message : fallback }
}
