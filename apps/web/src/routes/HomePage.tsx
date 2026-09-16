import { FolderOpen } from 'lucide-react'
import { Link, Navigate } from 'react-router-dom'
import { useProjects } from '../lib/projects'
import { useAllConversations } from '../lib/conversations'
import { useCurrentUser } from '../lib/session'
import { lastContext } from '../lib/last-context'
import { Button, EmptyState } from '../components/ui'
import { useTranslate } from '../lib/i18n'

export function HomePage() {
  const t = useTranslate()
  const { data: projects, isPending } = useProjects()
  const { data: conversations, isPending: conversationsPending } = useAllConversations()
  const { data: user } = useCurrentUser()

  if (isPending || conversationsPending) return null

  const remembered = user && projects && conversations
    ? lastContext(user.id, projects, conversations)
    : null
  if (remembered) return <Navigate to={remembered} replace />

  const recent = conversations?.filter((entry) => !entry.archivedAt && projects?.some((project) => project.id === entry.projectId))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (recent) return <Navigate to={`/p/${recent.projectId}/c/${recent.id}`} replace />

  const first = projects?.[0]
  if (first) return <Navigate to={`/p/${first.id}/c/new`} replace />

  return (
    <EmptyState
      icon={<FolderOpen size={22} />}
      title={t('home.empty.title')}
      description={t('home.empty.description')}
      action={
        <Link to="/settings/projets">
          <Button>{t('home.createProject')}</Button>
        </Link>
      }
    />
  )
}
