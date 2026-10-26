import { conversationPath } from '@sillage/protocol'
import type { ConversationDto } from '@sillage/protocol'
import { useAllConversations } from './conversations'

interface SessionIndex {
  sessions: Map<string, ConversationDto>
  ids: ReadonlySet<string>
}

// Every message observes the same list. Build its index once per snapshot, not once per bubble.
const indexes = new WeakMap<ConversationDto[], Map<string, SessionIndex>>()
const EMPTY: SessionIndex = { sessions: new Map(), ids: new Set() }
let latestIds = new Map<string, ReadonlySet<string>>()

/** Reuse the sidebar's authorized list, including archives, without fetching transcripts. */
export function useSessionReferences(projectId?: string | null) {
  const { data, isPending } = useAllConversations(projectId !== undefined)
  let index = data ? indexes.get(data) : undefined
  if (data && !index) {
    const byProject = new Map<string, Map<string, ConversationDto>>()
    for (const session of data) {
      const group = byProject.get(session.projectId ?? '') ?? new Map<string, ConversationDto>()
      group.set(session.id, session)
      byProject.set(session.projectId ?? '', group)
    }
    byProject.set('', new Map(data.map(session => [session.id, session])))
    index = new Map()
    const nextIds = new Map<string, ReadonlySet<string>>()
    for (const [id, sessions] of byProject) {
      const previous = latestIds.get(id)
      // Parsing only needs membership. Renames, favorites and activity update the reference
      // components without reparsing every historical message or allocating one ID set per bubble.
      const ids = previous?.size === sessions.size && [...sessions.keys()].every(key => previous.has(key))
        ? previous : new Set(sessions.keys())
      index.set(id, { sessions, ids })
      nextIds.set(id, ids)
    }
    latestIds = nextIds
    indexes.set(data, index)
  }
  return { ...(projectId === undefined ? EMPTY : index?.get(projectId ?? '') ?? EMPTY), loading: isPending }
}

export function sessionHref(session: Pick<ConversationDto, 'projectId' | 'id'>): string {
  return conversationPath(session)
}

function searchable(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
}

export function matchSessions(sessions: Map<string, ConversationDto>, query: string, excludeId?: string): ConversationDto[] {
  const words = searchable(query.trim()).split(/\s+/).filter(Boolean)
  return [...sessions.values()]
    .filter(session => session.id !== excludeId &&
      (words.length > 0 || session.archivedAt === null) &&
      words.every(word => searchable(`${session.title} ${session.agent} ${session.id}`).includes(word)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12)
}
