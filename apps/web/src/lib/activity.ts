import { useMemo, useSyncExternalStore } from 'react'
import type { ConversationDto, ConversationStatus, DecisionDto } from '@sillage/protocol'
import { useAllConversations } from './conversations'
import { liveBackground, liveSeq, liveStatus, subscribeStatus } from './conversation-status'
import { useDecisions } from './decisions'
import { isUnread } from './reads'

export type ActivityEntry = {
  conversation: ConversationDto
  status: ConversationStatus
  /** Working, in a turn or in the background. */
  running: boolean
  /** Blocked on the user: permission, question, plan. */
  awaiting: boolean
  unread: boolean
}

export type ActivityCounts = { awaiting: number; running: number; unread: number }

const NONE: ActivityCounts = { awaiting: 0, running: 0, unread: 0 }

/**
 * Live state of followed sessions, for whoever shows it: the rail's badges and the Activity list.
 * Scheduled and benchmark runs are excluded by the caller: they are not followed sessions and
 * their own pages report state.
 */
export function useActivity(conversations: ConversationDto[], openId: string | undefined) {
  // Primitive snapshots avoid rendering on every received token or metric.
  const snapshot = () => JSON.stringify(conversations.map((entry) => ({
    status: liveStatus(entry.id) ?? entry.status,
    background: liveBackground(entry.id) > 0,
    unread: entry.id !== openId && isUnread(entry, liveSeq(entry.id)),
  })))
  const serialized = useSyncExternalStore(subscribeStatus, snapshot, snapshot)

  return useMemo(() => {
    const states = JSON.parse(serialized) as { status: ConversationStatus; background: boolean; unread: boolean }[]
    const entries = conversations.flatMap((conversation, index): ActivityEntry[] => {
      const state = states[index]
      if (!state) return []
      const awaiting = state.status === 'awaiting_input'
      const running = !awaiting && (state.status === 'running' || state.background)
      // Archived sessions count only while they still work or wait.
      if (conversation.archivedAt && !running && !awaiting) return []
      return [{ conversation, status: state.status, running, awaiting, unread: state.unread }]
    })
    const byProject = new Map<string, ActivityCounts>()
    for (const entry of entries) {
      // Personal discussions have no project: they share one bucket under the empty key.
      const key = entry.conversation.projectId ?? ''
      const counts = byProject.get(key) ?? { ...NONE }
      if (entry.awaiting) counts.awaiting += 1
      if (entry.running) counts.running += 1
      if (entry.unread) counts.unread += 1
      byProject.set(key, counts)
    }
    return {
      awaiting: entries.filter((entry) => entry.awaiting),
      running: entries.filter((entry) => entry.running),
      unread: entries.filter((entry) => entry.unread),
      /** Counts per project, for its mark in the rail. */
      ofProject: (projectId: string): ActivityCounts => byProject.get(projectId) ?? NONE,
      /** Counts of the discussions held outside any project. */
      personal: byProject.get('') ?? NONE,
    }
  }, [conversations, serialized])
}

/** The one mark a project or a group shows: waiting outranks working, which outranks unread. */
export function activityTone(counts: ActivityCounts): 'awaiting' | 'running' | 'unread' | null {
  return counts.awaiting > 0 ? 'awaiting' : counts.running > 0 ? 'running' : counts.unread > 0 ? 'unread' : null
}

/** The lists Activity shows, in order. Each one is also a way to fill the wall beside it. */
export const ACTIVITY_SECTIONS = ['awaiting', 'running', 'unread', 'favorites'] as const
export type ActivitySection = (typeof ACTIVITY_SECTIONS)[number]

const NO_DECISIONS: DecisionDto[] = []

/**
 * What the Activity space follows, for its list and for the wall beside it: both read this hook so
 * a tile never disagrees with the row that stands for it.
 */
export function useFollowedActivity(openId: string | undefined) {
  const { data: conversations } = useAllConversations()
  const { data: decisions } = useDecisions('pending')
  // Scheduled and benchmark runs are not followed sessions: their own pages report state.
  const attended = useMemo(() => (conversations ?? []).filter((entry) => !entry.scheduleId && !entry.benchmarkId), [conversations])
  const activity = useActivity(attended, openId)
  /** Account bookmarks across projects, archived threads included: archiving must not hide them. */
  const favorites = useMemo(() => (conversations ?? []).filter((entry) => entry.favorite), [conversations])
  return useMemo(() => ({ ...activity, favorites, decisions: decisions ?? NO_DECISIONS }), [activity, favorites, decisions])
}

export type FollowedActivity = ReturnType<typeof useFollowedActivity>

/** Sessions of one section in list order; without a section, what is live: waiting, then working. */
export function activitySectionIds(followed: FollowedActivity, section: ActivitySection | null): string[] {
  // A pending decision waits on the user like a permission does.
  const awaiting = [...followed.decisions.map((decision) => decision.conversationId), ...followed.awaiting.map((entry) => entry.conversation.id)]
  const running = followed.running.map((entry) => entry.conversation.id)
  const ids = section === 'awaiting' ? awaiting
    : section === 'running' ? running
    : section === 'unread' ? followed.unread.map((entry) => entry.conversation.id)
    : section === 'favorites' ? followed.favorites.map((entry) => entry.id)
    : [...awaiting, ...running]
  return [...new Set(ids)]
}

/** The section a wall address asks for, or null for the live one. */
export function activitySectionOf(params: URLSearchParams): ActivitySection | null {
  const value = params.get('show')
  return ACTIVITY_SECTIONS.find((section) => section === value) ?? null
}

/** Address of the wall showing a section or a saved view, optionally with one tile brought forward. */
export function activityWallPath({ section, view, tile }: { section?: ActivitySection | null; view?: string; tile?: string }): string {
  const params = new URLSearchParams()
  if (view) params.set('view', view)
  else if (section) params.set('show', section)
  if (tile) params.set('tile', tile)
  const query = params.toString()
  return query ? `/wall?${query}` : '/wall'
}
