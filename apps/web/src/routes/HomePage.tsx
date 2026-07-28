import { FolderOpen } from 'lucide-react'
import { Link, Navigate } from 'react-router-dom'
import { useProjects } from '../lib/projects'
import { Button, EmptyState } from '../components/ui'
import { useTranslate } from '../lib/i18n'

export function HomePage() {
  const t = useTranslate()
  const { data: projects, isPending } = useProjects()

  if (isPending) return null

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
