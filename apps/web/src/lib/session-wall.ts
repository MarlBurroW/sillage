import { useQueries } from '@tanstack/react-query'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ConversationDto, ConversationStatus, ProjectDto, SessionFacts, SessionState, WorktreeStatusDto, WorktreeStatusListDto } from '@sillage/protocol'
import { useAllConversations } from './conversations'
import { liveActivityAt, liveBackground, liveSeq, liveStatus, subscribeStatus } from './conversation-status'
import { useProjects } from './projects'
import { isUnread } from './reads'
import { conversationWorktree, worktreeStatusQuery } from './worktrees'

/**
 * Most tiles the wall opens at once. Each tile loads a thread page and follows its journal live:
 * an empty query over hundreds of sessions must not open hundreds of streams.
 */
export const MAX_WALL_TILES = 16

/** The three states the query knows, from the pushed status and running background work. */
export function sessionState(status: ConversationStatus, background: boolean): SessionState {
  if (status === 'awaiting_input' || status === 'error') return 'attention'
  if (status === 'running' || background) return 'running'
  return 'idle'
}

/** Current time, refreshed often enough for sliding windows such as `active:30m`. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

export interface WallSources {
  facts: SessionFacts[]
  conversations: Map<string, ConversationDto>
  projects: Map<string, ProjectDto>
  /** Each session's tree, as the sidebar picks it; absent while its project's trees load. */
  trees: Map<string, WorktreeStatusDto | null>
  loading: boolean
}

/**
 * Everything the query can test, per session: the REST list overlaid with pushed statuses, read
 * cursors and worktree states. Archived sessions only count while they still work, as in the
 * activity overview.
 */
export function useWallSources(now: number): WallSources {
  const { data: list, isLoading } = useAllConversations()
  const { data: projectList } = useProjects()
  const conversations = list ?? EMPTY

  // One primitive snapshot rather than one subscription per row, as in the activity overview:
  // rendering follows status changes, not every token.
  const snapshot = () => conversations.map((entry) => [
    liveStatus(entry.id) ?? entry.status,
    liveBackground(entry.id) > 0 ? 1 : 0,
    isUnread(entry, liveSeq(entry.id)) ? 1 : 0,
    liveActivityAt(entry.id),
  ].join(':')).join('|')
  const live = useSyncExternalStore(subscribeStatus, snapshot, snapshot)

  const projectIds = useMemo(() => [...new Set(conversations.flatMap((entry) => entry.projectId ? [entry.projectId] : []))], [conversations])
  // The same query as the sidebar rows, so both share one cache per project.
  const trees = useQueries({ queries: projectIds.map((id) => worktreeStatusQuery(id)) })
  // Query results are new arrays each render: key the map on when each one last changed.
  const treesVersion = trees.map((query) => query.dataUpdatedAt).join(',')
  const treesByProject = useMemo(() => {
    const map = new Map<string, WorktreeStatusListDto>()
    trees.forEach((query, index) => { if (query.data) map.set(projectIds[index]!, query.data) })
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIds, treesVersion])

  return useMemo(() => {
    const projects = new Map((projectList ?? []).map((project) => [project.id, project]))
    const states = live ? live.split('|') : []
    const facts: SessionFacts[] = []
    const trees = new Map<string, WorktreeStatusDto | null>()
    conversations.forEach((conversation, index) => {
      const [status, background, unread, pushedAt] = (states[index] ?? '').split(':')
      const state = sessionState((status ?? conversation.status) as ConversationStatus, background === '1')
      if (conversation.archivedAt && state === 'idle') return
      const projectName = conversation.projectId ? projects.get(conversation.projectId)?.name ?? null : null
      const data = conversation.projectId ? treesByProject.get(conversation.projectId) : null
      const tree = data ? conversationWorktree(data, conversation.id) : null
      if (data !== undefined) trees.set(conversation.id, tree)
      facts.push({
        id: conversation.id,
        title: conversation.title,
        projectName,
        agent: conversation.agent,
        state,
        unread: unread === '1',
        favorite: conversation.favorite,
        worktree: data === undefined ? undefined : tree?.state ?? null,
        // A session working right now is active now, even inside a long silent tool call.
        activityAt: state === 'idle' ? Math.max(conversation.updatedAt, Number(pushedAt) || 0) : now,
        createdAt: conversation.createdAt,
      })
    })
    return { facts, conversations: new Map(conversations.map((entry) => [entry.id, entry])), projects, trees, loading: isLoading }
  }, [conversations, projectList, live, treesByProject, now, isLoading])
}
const EMPTY: ConversationDto[] = []
