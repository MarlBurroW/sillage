import { FolderOpen, GitBranch, Globe, Lock, Save, Trash2, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { ProjectVisibility } from '@sillage/protocol'
import { PathField } from '../components/PathField'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Select,
  type SelectOption,
} from '../components/ui'
import { ApiRequestError } from '../lib/api'
import { useAllConversations } from '../lib/conversations'
import { useDeleteWorktree, useWorktrees } from '../lib/worktrees'
import { useDeleteProject, useProjects, useUpdateProject } from '../lib/projects'

const VISIBILITY_OPTIONS: SelectOption<ProjectVisibility>[] = [
  { value: 'private', label: 'Privé', icon: <Lock size={15} />, hint: 'Visible par toi seul' },
  {
    value: 'shared',
    label: 'Partagé',
    icon: <Globe size={15} />,
    hint: 'Visible par tous les comptes',
  },
]

export function ProjectPage() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const { data: projects, isPending } = useProjects()
  const { data: conversations } = useAllConversations()

  const project = projects?.find((p) => p.id === projectId)

  if (isPending) return null
  if (!project) return <EmptyState title="Projet introuvable" />

  const projectConversations = (conversations ?? []).filter((c) => c.projectId === project.id)

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold tracking-tight">{project.name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={project.visibility === 'shared' ? 'accent' : 'neutral'}>
            {project.visibility === 'shared' ? 'Partagé' : 'Privé'}
          </Badge>
          {project.git ? (
            <>
              <Badge icon={<GitBranch size={11} />}>{project.git.branch}</Badge>
              {project.git.isDirty ? (
                <Badge tone="caution">Modifications non commitées</Badge>
              ) : (
                <Badge tone="positive">Arbre propre</Badge>
              )}
            </>
          ) : (
            <Badge>Pas un dépôt git</Badge>
          )}
        </div>
      </header>

      <WorktreeList projectId={project.id} isRepository={project.git !== null} />

      {project.isOwner ? (
        <ProjectSettings
          projectId={project.id}
          initialName={project.name}
          initialPath={project.workspacePath}
          initialVisibility={project.visibility}
          hasConversations={projectConversations.length > 0}
          onDeleted={() => navigate('/')}
        />
      ) : (
        <Card>
          <CardBody className="text-sm text-ink-faint">
            Projet partagé par {project.ownerName}. Seul son propriétaire peut le modifier.
          </CardBody>
        </Card>
      )}
    </div>
  )
}

function WorktreeList({ projectId, isRepository }: { projectId: string; isRepository: boolean }) {
  const { data: worktrees } = useWorktrees(isRepository ? projectId : undefined)
  const deleteWorktree = useDeleteWorktree(projectId)

  if (!isRepository || !worktrees || worktrees.length === 0) return null

  return (
    <Card>
      <CardHeader
        title="Worktrees"
        description="Créés depuis une nouvelle conversation. Ils vivent hors du projet, dans les données de Sillage."
        icon={<GitBranch size={16} />}
      />
      <CardBody className="flex flex-col gap-2">
        {worktrees.map((worktree) => (
          <div key={worktree.id} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-sm">{worktree.name}</p>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-faint">
                {worktree.git ? (
                  worktree.git.isDirty ? (
                    <Badge tone="caution">Modifications non commitées</Badge>
                  ) : (
                    <Badge tone="positive">Arbre propre</Badge>
                  )
                ) : (
                  <Badge tone="critical">Dossier absent</Badge>
                )}
                <span>
                  {worktree.conversationCount} conversation
                  {worktree.conversationCount > 1 ? 's' : ''}
                </span>
              </div>
            </div>
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 size={15} />}
              disabled={deleteWorktree.isPending}
              onClick={() => {
                const dirty = worktree.git?.isDirty === true
                const warning = dirty
                  ? `Le worktree « ${worktree.name} » contient du travail non commité, qui sera perdu.`
                  : `Supprimer le worktree « ${worktree.name} » ?`
                const used =
                  worktree.conversationCount > 0
                    ? `\n${worktree.conversationCount} conversation(s) l'utilisent et passeront en lecture seule.`
                    : ''
                if (!confirm(warning + used)) return
                // `force` uniquement si l'utilisateur a vu l'avertissement correspondant.
                deleteWorktree.mutate({ id: worktree.id, force: dirty })
              }}
            >
              Supprimer
            </Button>
          </div>
        ))}
      </CardBody>
    </Card>
  )
}

function ProjectSettings({
  projectId,
  initialName,
  initialPath,
  initialVisibility,
  hasConversations,
  onDeleted,
}: {
  projectId: string
  initialName: string
  initialPath: string
  initialVisibility: ProjectVisibility
  hasConversations: boolean
  onDeleted: () => void
}) {
  const updateProject = useUpdateProject()
  const deleteProject = useDeleteProject()

  const [name, setName] = useState(initialName)
  const [workspacePath, setWorkspacePath] = useState(initialPath)
  const [visibility, setVisibility] = useState(initialVisibility)

  // Les valeurs du serveur font foi quand le projet change ou après enregistrement.
  useEffect(() => {
    setName(initialName)
    setWorkspacePath(initialPath)
    setVisibility(initialVisibility)
  }, [projectId, initialName, initialPath, initialVisibility])

  const dirty =
    name !== initialName || workspacePath !== initialPath || visibility !== initialVisibility
  const pathChanged = workspacePath !== initialPath

  const error = updateProject.error instanceof ApiRequestError ? updateProject.error.message : null

  return (
    <Card>
      <CardHeader title="Réglages du projet" icon={<FolderOpen size={16} />} />
      <CardBody className="flex flex-col gap-4">
        <Field label="Nom" value={name} onChange={(event) => setName(event.target.value)} />

        <PathField
          label="Dossier du workspace"
          value={workspacePath}
          onChange={setWorkspacePath}
          hint="Chemin absolu sur la machine hôte."
        />

        {pathChanged && hasConversations ? (
          <Banner tone="caution">
            Les conversations existantes reprendront dans ce nouveau dossier. Un agent en cours
            d'exécution garde l'ancien jusqu'à son prochain démarrage.
          </Banner>
        ) : null}

        <Select
          label="Visibilité"
          value={visibility}
          onChange={setVisibility}
          options={VISIBILITY_OPTIONS}
        />

        {error ? <Banner>{error}</Banner> : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!dirty || !name.trim() || updateProject.isPending}
            icon={<Save size={15} />}
            onClick={() =>
              updateProject.mutate({ id: projectId, name: name.trim(), workspacePath, visibility })
            }
          >
            Enregistrer
          </Button>
          {dirty ? (
            <Button
              variant="ghost"
              onClick={() => {
                setName(initialName)
                setWorkspacePath(initialPath)
                setVisibility(initialVisibility)
              }}
            >
              Annuler
            </Button>
          ) : null}
        </div>
      </CardBody>

      <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-4">
        <TriangleAlert size={16} className="shrink-0 text-caution" />
        <p className="min-w-0 flex-1 text-sm text-ink-faint">
          Retirer le projet supprime ses conversations. Le dossier sur le disque n'est pas touché.
        </p>
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 size={15} />}
          onClick={() => {
            if (!confirm(`Retirer "${initialName}" de Sillage ?`)) return
            deleteProject.mutate(projectId, { onSuccess: onDeleted })
          }}
        >
          Retirer
        </Button>
      </div>
    </Card>
  )
}
