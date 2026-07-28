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
import { translate, useTranslate } from '../lib/i18n'
import { useDeleteProject, useProjects, useUpdateProject } from '../lib/projects'

/** Recalculée à chaque rendu plutôt que figée au chargement du module : sinon un
 *  changement de langue laisserait ces deux options dans l'ancienne. */
function visibilityOptions(): SelectOption<ProjectVisibility>[] {
  return [
    {
      value: 'private',
      label: translate('project.visibility.private'),
      icon: <Lock size={15} />,
      hint: translate('project.visibility.private.hint'),
    },
    {
      value: 'shared',
      label: translate('project.visibility.shared'),
      icon: <Globe size={15} />,
      hint: translate('project.visibility.shared.hint'),
    },
  ]
}

export function ProjectPage() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const { data: projects, isPending } = useProjects()
  const { data: conversations } = useAllConversations()
  const t = useTranslate()

  const project = projects?.find((p) => p.id === projectId)

  if (isPending) return null
  if (!project) return <EmptyState title={t('project.notFound')} />

  const projectConversations = (conversations ?? []).filter((c) => c.projectId === project.id)

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold tracking-tight">{project.name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={project.visibility === 'shared' ? 'accent' : 'neutral'}>
            {project.visibility === 'shared'
              ? t('project.visibility.shared')
              : t('project.visibility.private')}
          </Badge>
          {project.git ? (
            <>
              <Badge icon={<GitBranch size={11} />}>{project.git.branch}</Badge>
              {project.git.isDirty ? (
                <Badge tone="caution">{t('project.git.dirty')}</Badge>
              ) : (
                <Badge tone="positive">{t('project.git.clean')}</Badge>
              )}
            </>
          ) : (
            <Badge>{t('project.git.none')}</Badge>
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
            {t('project.shared.readonly', { name: project.ownerName })}
          </CardBody>
        </Card>
      )}
    </div>
  )
}

function WorktreeList({ projectId, isRepository }: { projectId: string; isRepository: boolean }) {
  const { data: worktrees } = useWorktrees(isRepository ? projectId : undefined)
  const deleteWorktree = useDeleteWorktree(projectId)
  const t = useTranslate()

  if (!isRepository || !worktrees || worktrees.length === 0) return null

  return (
    <Card>
      <CardHeader
        title={t('project.worktrees.title')}
        description={t('project.worktrees.description')}
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
                    <Badge tone="caution">{t('project.git.dirty')}</Badge>
                  ) : (
                    <Badge tone="positive">{t('project.git.clean')}</Badge>
                  )
                ) : (
                  <Badge tone="critical">{t('project.worktree.missing')}</Badge>
                )}
                <span>
                  {worktree.conversationCount > 1
                    ? t('project.worktree.conversationsMany', { count: worktree.conversationCount })
                    : t('project.worktree.conversationsOne', { count: worktree.conversationCount })}
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
                  ? translate('project.worktree.deleteDirtyWarning', { name: worktree.name })
                  : translate('project.worktree.deleteConfirm', { name: worktree.name })
                const used =
                  worktree.conversationCount > 0
                    ? `\n${translate('project.worktree.deleteUsedCount', { count: worktree.conversationCount })}`
                    : ''
                if (!confirm(warning + used)) return
                // `force` uniquement si l'utilisateur a vu l'avertissement correspondant.
                deleteWorktree.mutate({ id: worktree.id, force: dirty })
              }}
            >
              {t('project.worktree.delete')}
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
  const t = useTranslate()

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
      <CardHeader title={t('project.settings.title')} icon={<FolderOpen size={16} />} />
      <CardBody className="flex flex-col gap-4">
        <Field
          label={t('project.settings.name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />

        <PathField
          label={t('project.settings.workspacePath')}
          value={workspacePath}
          onChange={setWorkspacePath}
          hint={t('project.settings.workspacePath.hint')}
        />

        {pathChanged && hasConversations ? (
          <Banner tone="caution">{t('project.settings.pathChanged.warning')}</Banner>
        ) : null}

        <Select
          label={t('project.settings.visibility')}
          value={visibility}
          onChange={setVisibility}
          options={visibilityOptions()}
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
            {t('project.settings.save')}
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
              {t('project.settings.cancel')}
            </Button>
          ) : null}
        </div>
      </CardBody>

      <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-4">
        <TriangleAlert size={16} className="shrink-0 text-caution" />
        <p className="min-w-0 flex-1 text-sm text-ink-faint">{t('project.settings.remove.notice')}</p>
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 size={15} />}
          onClick={() => {
            if (!confirm(translate('project.settings.remove.confirm', { name: initialName }))) return
            deleteProject.mutate(projectId, { onSuccess: onDeleted })
          }}
        >
          {t('project.settings.remove')}
        </Button>
      </div>
    </Card>
  )
}
