import {
  FolderOpen,
  GitBranch,
  Globe,
  Lock,
  Save,
  ShieldAlert,
  SlidersHorizontal,
  SquareKanban,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  agentKindSchema,
  defaultConfigFor,
  type AgentConfig,
  type AgentKind,
  type ProjectAgentDefaults,
  type ProjectVisibility,
} from '@sillage/protocol'
import { AGENT_LABELS, AGENT_META, AgentIcon } from '../components/AgentIcon'
import { useAgentSettings } from '../components/chat/agent-settings'
import type { SettingGroup } from '../components/chat/ComposerSettings'
import { useUserSettings } from '../lib/user-settings'
import { PathField } from '../components/PathField'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ChoiceList,
  EmptyState,
  Field,
  Select,
  type Choice,
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

      <Card>
        <CardHeader
          title={t('project.board.title')}
          description={t('project.board.description')}
          icon={<SquareKanban size={16} />}
        />
        <CardBody>
          <Button variant="ghost" onClick={() => navigate(`/p/${project.id}/board`)}>
            {t('project.board.open')}
          </Button>
        </CardBody>
      </Card>

      <WorktreeList projectId={project.id} isRepository={project.git !== null} />

      {project.isOwner ? (
        <>
          <ProjectDefaults projectId={project.id} defaults={project.defaultConfig} />
          <ProjectSettings
            projectId={project.id}
            initialName={project.name}
            initialPath={project.workspacePath}
            initialVisibility={project.visibility}
            hasConversations={projectConversations.length > 0}
            onDeleted={() => navigate('/')}
          />
        </>
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

/**
 * Les préréglages du projet : le socle des conversations qui s'y ouvrent.
 *
 * Partagé, à la différence des défauts de compte, et pour ce que le projet a de propre :
 * les serveurs MCP utiles à ce dépôt le sont pour tout le monde, et les répertoires
 * supplémentaires ne veulent rien dire ailleurs. D'où l'écriture réservée au
 * propriétaire, comme le reste des réglages du projet.
 *
 * Chaque CLI est indépendant, et peut ne rien dire : « les défauts de compte » n'est pas
 * un préréglage vide mais une absence, qui laisse chacun démarrer avec les siens. Rien
 * n'est appliqué aux conversations déjà ouvertes, qui portent chacune sa configuration.
 */
function ProjectDefaults({
  projectId,
  defaults,
}: {
  projectId: string
  defaults: ProjectAgentDefaults
}) {
  const t = useTranslate()
  const update = useUpdateProject()
  const { data: settings } = useUserSettings()

  const [agent, setAgent] = useState<AgentKind>('claude')
  /**
   * Ce qui vient d'être choisi, tant que la liste des projets n'a pas été relue. Sans
   * lui, chaque réglage reviendrait à sa valeur d'avant le temps de l'aller-retour, et
   * couper le préréglage le ferait réapparaître sous le curseur.
   */
  const [pending, setPending] = useState<{ [K in AgentKind]?: AgentConfig | null }>({})

  const stored = agent in pending ? (pending[agent] ?? null) : defaults[agent]
  // Le CLI de la valeur retenue fait foi : une configuration Claude n'a rien à régler
  // pour Codex, et l'écran en montrerait les mauvaises options.
  const preset = stored?.agent === agent ? stored : null
  const account = settings?.agentDefaults[agent] ?? defaultConfigFor(agent)

  const write = (config: AgentConfig | null) => {
    setPending((current) => ({ ...current, [agent]: config }))
    update.mutate({ id: projectId, defaultConfig: { agent, config } })
  }

  const { groups, mcp, catalogError } = useAgentSettings({
    config: preset ?? account,
    onConfigChange: write,
  })

  const agents: Choice<AgentKind>[] = agentKindSchema.options.map((value) => ({
    value,
    label: AGENT_LABELS[value],
    hint: AGENT_META[value].vendor,
    icon: <AgentIcon agent={value} size={16} />,
  }))

  const sources: Choice<'account' | 'project'>[] = [
    {
      value: 'account',
      label: t('project.defaults.source.account'),
      hint: t('project.defaults.source.account.hint'),
    },
    {
      value: 'project',
      label: t('project.defaults.source.project'),
      hint: t('project.defaults.source.project.hint'),
    },
  ]

  return (
    <Card>
      <CardHeader
        title={t('project.defaults.title')}
        description={t('project.defaults.description')}
        icon={<SlidersHorizontal size={16} />}
      />
      <CardBody className="flex flex-col gap-4">
        <ChoiceList label={t('draft.cli.legend')} value={agent} options={agents} onChange={setAgent} />

        <ChoiceList
          label={t('project.defaults.source')}
          value={preset ? 'project' : 'account'}
          options={sources}
          // Le préréglage part de ce qui était montré, c'est-à-dire des défauts du
          // compte : accepter le socle proposé ne doit pas demander de le ressaisir.
          onChange={(source) => write(source === 'project' ? (preset ?? account) : null)}
        />

        {catalogError ? <Banner tone="caution">{t('composer.catalog.unavailable')}</Banner> : null}
        {update.isError ? <Banner>{t('project.defaults.save.error')}</Banner> : null}

        {/* Rien à déplier tant que le projet ne dit rien de ce CLI : les réglages
            affichés seraient ceux du compte, et un clic les figerait pour tout le
            monde sans que personne l'ait demandé. */}
        {preset ? (
          <>
            {groups.map((group) => (
              <GroupField key={group.key} group={group} />
            ))}

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-ink-soft">
                {t('project.defaults.mcp.label')}
              </span>
              {/* Le contrôle porte déjà son icône et son décompte : l'encadrer d'un
                  second repère ferait deux prises pour un seul réglage. */}
              <div className="flex">{mcp}</div>
              <p className="text-xs text-ink-faint">{t('project.defaults.mcp.hint')}</p>
            </div>

            <p className="text-xs text-ink-faint">{t('project.defaults.applies')}</p>
          </>
        ) : null}
      </CardBody>
    </Card>
  )
}

/**
 * Une catégorie de réglage, en liste déroulante, comme sur l'écran des défauts de CLI :
 * celle des modèles est trop longue pour être dépliée, et aligner les autres dessus vaut
 * mieux qu'un écran où chaque réglage a sa forme propre.
 */
function GroupField({ group }: { group: SettingGroup }) {
  const selected = group.options.find((option) => option.value === group.value)

  return (
    <div className="flex flex-col gap-1.5">
      <Select
        label={group.label}
        value={group.value}
        options={group.options}
        onChange={group.onChange}
      />
      {selected?.tone === 'caution' ? (
        <p className="flex items-start gap-1.5 text-xs text-caution">
          <ShieldAlert size={13} className="mt-0.5 shrink-0" />
          <span>{selected.hint}</span>
        </p>
      ) : null}
    </div>
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
