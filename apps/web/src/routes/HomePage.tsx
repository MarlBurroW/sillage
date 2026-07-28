import { FolderOpen } from 'lucide-react'
import { Link, Navigate } from 'react-router-dom'
import { useProjects } from '../lib/projects'
import { Button, EmptyState } from '../components/ui'

export function HomePage() {
  const { data: projects, isPending } = useProjects()

  if (isPending) return null

  const first = projects?.[0]
  if (first) return <Navigate to={`/p/${first.id}/c/new`} replace />

  return (
    <EmptyState
      icon={<FolderOpen size={22} />}
      title="Aucun projet"
      description="Un projet pointe sur un dossier de ta machine. C'est le point de départ de toute conversation."
      action={
        <Link to="/settings/projets">
          <Button>Créer un projet</Button>
        </Link>
      }
    />
  )
}
