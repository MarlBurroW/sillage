import { conversationPath } from '@sillage/protocol'
import { Navigate } from 'react-router-dom'
import { useProjects } from '../lib/projects'
import { useAllConversations } from '../lib/conversations'
import { useCurrentUser } from '../lib/session'
import { lastContext } from '../lib/last-context'

export function HomePage() {
  const { data: projects, isPending } = useProjects()
  const { data: conversations, isPending: conversationsPending } = useAllConversations()
  const { data: user } = useCurrentUser()

  if (isPending || conversationsPending) return null

  const remembered = user && projects && conversations
    ? lastContext(user.id, projects, conversations)
    : null
  if (remembered) return <Navigate to={remembered} replace />

  const recent = conversations?.filter((entry) => !entry.archivedAt && (entry.projectId === null || projects?.some((project) => project.id === entry.projectId)))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (recent) return <Navigate to={conversationPath(recent)} replace />

  const first = projects?.[0]
  if (first) return <Navigate to={`/p/${first.id}/c/new`} replace />

  return <Navigate to="/discussions/new" replace />
}
