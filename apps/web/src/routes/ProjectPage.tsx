import {
  BookOpen,
  Brain,
  FileText,
  FolderOpen,
  GitBranch,
  ImagePlus,
  Globe,
  Lock,
  Save,
  ShieldAlert,
  SlidersHorizontal,
  SquareKanban,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  agentKindSchema,
  defaultConfigFor,
  type AgentConfig,
  type AgentKind,
  type ProjectAgentDefaults,
  type ProjectDto,
  type ProjectVisibility,
} from '@sillage/protocol'
import { AGENT_LABELS, AGENT_META, AgentIcon } from '../components/AgentIcon'
import { useAgentSettings } from '../components/chat/agent-settings'
import { ProjectSkills } from '../components/skills/ProjectSkills'
import { ProjectInstructions } from '../components/instructions/Instructions'
import { ProjectMemory } from '../components/instructions/ProjectMemory'
import type { SettingGroup } from '../components/chat/ComposerSettings'
import { useUserSettings } from '../lib/user-settings'
import { PathField } from '../components/PathField'
import { ProjectAvatar } from '../components/ProjectAvatar'
import { WorktreeBoard } from '../components/WorktreeBoard'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ChoiceList,
  cx,
  EmptyState,
  Field,
  Select,
  Switch,
  type Choice,
  type SelectOption,
} from '../components/ui'
import { ApiRequestError } from '../lib/api'
import { useAllConversations } from '../lib/conversations'
import { translate, useTranslate } from '../lib/i18n'
import { useCapability } from '../lib/instance'
import {
  useDeleteProject,
  useProjects,
  useRemoveProjectImage,
  useSetProjectImage,
  useUpdateProject,
} from '../lib/projects'

/**
 * Recomputed on every render rather than frozen at module load; otherwise changing language
 * would leave these two options in the old one.
 */
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
  const { data: projects, isPending } = useProjects()
  const { data: conversations } = useAllConversations()
  const t = useTranslate()
  const project = projects?.find((p) => p.id === projectId)
  if (isPending) return null
  if (!project) return <EmptyState title={t('project.notFound')} />

  return <ProjectWorkspace key={project.id} project={project} hasConversations={Boolean(conversations?.some((c) => c.projectId === project.id))} />
}

const PROJECT_SECTIONS = [
  { key: 'general', icon: FolderOpen },
  { key: 'agents', icon: SlidersHorizontal },
  { key: 'instructions', icon: FileText },
  { key: 'memory', icon: Brain },
  { key: 'skills', icon: BookOpen },
  { key: 'worktrees', icon: GitBranch },
] as const

function ProjectWorkspace({ project, hasConversations }: { project: ProjectDto; hasConversations: boolean }) {
  const t = useTranslate()
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const sharedProjects = useCapability('sharedProjects')
  const sections = PROJECT_SECTIONS.filter((section) =>
    (section.key !== 'agents' || project.isOwner) && (section.key !== 'worktrees' || project.git !== null))
  // Existing sidebar links use #worktrees; new links carry a shareable category.
  const requested = params.get('section') ?? (location.hash === '#worktrees' ? 'worktrees' : 'general')
  const active = sections.find((section) => section.key === requested)?.key ?? 'general'
  const [visited, setVisited] = useState<Set<string>>(() => new Set([active]))
  useEffect(() => {
    setVisited((previous) => previous.has(active) ? previous : new Set([...previous, active]))
  }, [active])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line bg-surface px-4 pt-4 md:px-8 md:pt-6">
        <header className="mx-auto grid w-full max-w-4xl grid-cols-[minmax(0,1fr)_auto] items-center gap-2 pb-3">
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
              <ProjectAvatar project={project} className="size-7 shrink-0" />
              <span className="truncate">{project.name}</span>
            </h1>
          </div>
          <Button variant="ghost" size="sm" icon={<SquareKanban size={15} />} onClick={() => navigate(`/p/${project.id}/board`)}>
            {t('project.board.open')}
          </Button>
          <div className="col-span-2 flex flex-wrap items-center gap-2">
            {sharedProjects ? <Badge tone={project.visibility === 'shared' ? 'accent' : 'neutral'}>
              {t(project.visibility === 'shared' ? 'project.visibility.shared' : 'project.visibility.private')}
            </Badge> : null}
            {project.git ? <>
              <Badge icon={<GitBranch size={11} />}>{project.git.branch}</Badge>
              <Badge tone={project.git.isDirty ? 'caution' : 'positive'}>{t(project.git.isDirty ? 'project.git.dirty' : 'project.git.clean')}</Badge>
            </> : <Badge>{t('project.git.none')}</Badge>}
          </div>
        </header>
        <nav aria-label={t('project.navigation')} className="mx-auto grid max-w-4xl grid-cols-3 gap-x-1 md:flex">
          {sections.map(({ key, icon: Icon }) => {
            const search = new URLSearchParams(params)
            search.set('section', key)
            return <Link key={key} to={{ pathname: location.pathname, search: `?${search}` }}
              aria-current={active === key ? 'page' : undefined}
              className={cx('flex min-h-11 min-w-0 items-center justify-center gap-1.5 border-b-2 px-2 py-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent md:flex-1 md:text-sm',
                active === key ? 'border-accent text-accent' : 'border-transparent text-ink-faint hover:bg-sunken hover:text-ink')}>
              <Icon size={15} className="shrink-0" /><span>{t(`project.section.${key}`)}</span>
            </Link>
          })}
        </nav>
      </div>
      {/* Mount on first visit, then keep drafts and scroll positions across categories. */}
      {sections.map(({ key }) => visited.has(key) || active === key ? (
        <section key={key} aria-label={t(`project.section.${key}`)} hidden={active !== key}
          className={cx('min-h-0 flex-1 overflow-y-auto overscroll-contain', active !== key && 'hidden')}>
          <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 md:p-6">
            {key === 'general' ? project.isOwner ? <>
              <ProjectSettings projectId={project.id} initialName={project.name} initialPath={project.workspacePath}
                initialVisibility={project.visibility} turnCheckpoints={project.turnCheckpoints}
                hasConversations={hasConversations} onDeleted={() => navigate('/')} />
              <ProjectImage project={project} />
            </> : <Card><CardBody className="flex flex-col gap-3 text-sm text-ink-faint">
              <p>{t('project.shared.readonly', { name: project.ownerName })}</p>
              <p className="break-all font-mono">{project.workspacePath}</p>
            </CardBody></Card> : null}
            {key === 'agents' ? <ProjectDefaults projectId={project.id} defaults={project.defaultConfig} /> : null}
            {key === 'instructions' ? <Card>
              <CardHeader title={t('instructions.project.title')} description={t('instructions.project.description')} icon={<FileText size={16} />} />
              <CardBody><ProjectInstructions projectId={project.id} /></CardBody>
            </Card> : null}
            {key === 'memory' ? <ProjectMemory projectId={project.id} /> : null}
            {key === 'skills' ? <ProjectSkills projectId={project.id} isOwner={project.isOwner} /> : null}
            {key === 'worktrees' ? <WorktreeBoard projectId={project.id} isRepository={project.git !== null} showEmpty /> : null}
          </div>
        </section>
      ) : null)}
    </div>
  )
}

/**
 * Project image: upload, replace or remove.
 *
 * Agents supply one when missing; this card lets users choose their own or correct the agent's
 * choice.
 */
function ProjectImage({ project }: { project: ProjectDto }) {
  const t = useTranslate()
  const input = useRef<HTMLInputElement>(null)
  const setImage = useSetProjectImage()
  const removeImage = useRemoveProjectImage()
  const failure = setImage.error ?? removeImage.error
  const error = failure instanceof ApiRequestError ? failure.message : null

  return (
    <Card>
      <CardHeader
        title={t('project.image.title')}
        description={t('project.image.description')}
        icon={<ImagePlus size={16} />}
      />
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <ProjectAvatar project={project} className="size-14" />
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              // Clear so choosing the same file twice triggers another upload.
              event.target.value = ''
              if (!file) return
              removeImage.reset()
              setImage.mutate({ id: project.id, file })
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={setImage.isPending}
            onClick={() => input.current?.click()}
          >
            {project.image ? t('project.image.replace') : t('project.image.choose')}
          </Button>
          {project.image ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={removeImage.isPending}
              onClick={() => {
                setImage.reset()
                removeImage.mutate(project.id)
              }}
            >
              {t('project.image.remove')}
            </Button>
          ) : null}
        </div>
        {project.image?.provisional ? (
          <p className="text-xs text-ink-faint">{t('project.image.provisional')}</p>
        ) : null}
        {error ? <Banner>{error}</Banner> : null}
      </CardBody>
    </Card>
  )
}

/**
 * Project presets: baseline for conversations opened here.
 *
 * Shared, unlike account defaults, and specific to the project: repository-useful MCP servers
 * benefit everyone, and extra directories have no meaning elsewhere. Hence owner-only writes,
 * like other project settings.
 *
 * Each CLI is independent and may specify nothing: “account defaults” is an absence, not an
 * empty preset, letting everyone start with their own. Existing conversations retain their own
 * configurations.
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
   * Pending choice until the project list is reread. Otherwise settings would revert during the
   * round trip, and disabling a preset would make it reappear under the pointer.
   */
  const [pending, setPending] = useState<{ [K in AgentKind]?: AgentConfig | null }>({})

  const stored = agent in pending ? (pending[agent] ?? null) : defaults[agent]
  // The selected value's CLI is authoritative: Claude configuration cannot configure
  // Codex, and the screen would display incorrect options.
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
          // Start presets from displayed account defaults: accepting the proposed baseline
          // must not require re-entering it.
          onChange={(source) => write(source === 'project' ? (preset ?? account) : null)}
        />

        {catalogError ? <Banner tone="caution">{t('composer.catalog.unavailable')}</Banner> : null}
        {update.isError ? <Banner>{t('project.defaults.save.error')}</Banner> : null}

        {/*
         * Nothing to expand while the project specifies nothing for this CLI: displayed account
         * defaults would become shared settings on click without anyone requesting it.
         */}
        {preset ? (
          <>
            {groups.map((group) => (
              <GroupField key={group.key} group={group} />
            ))}

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-ink-soft">
                {t('project.defaults.mcp.label')}
              </span>
              {/*
               * The control already includes its icon and count; another marker would create
               * two handles for one setting.
               */}
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
 * Settings category dropdown, like CLI defaults: the model list is too long to expand, and
 * consistent controls beat a different form for every setting.
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
  turnCheckpoints,
  hasConversations,
  onDeleted,
}: {
  projectId: string
  initialName: string
  turnCheckpoints: boolean
  initialPath: string
  initialVisibility: ProjectVisibility
  hasConversations: boolean
  onDeleted: () => void
}) {
  const updateProject = useUpdateProject()
  const deleteProject = useDeleteProject()
  const t = useTranslate()
  const sharedProjects = useCapability('sharedProjects')

  const [name, setName] = useState(initialName)
  const [workspacePath, setWorkspacePath] = useState(initialPath)
  const [visibility, setVisibility] = useState(initialVisibility)

  // Server values are authoritative on project changes or after saving.
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

        {sharedProjects ? (
          <Select
            label={t('project.settings.visibility')}
            value={visibility}
            onChange={setVisibility}
            options={visibilityOptions()}
          />
        ) : null}

        {/* Applied on click outside the form: a switch, not a checkbox to save. */}
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm">{t('project.settings.checkpoints')}</p>
            <p className="text-xs text-ink-faint">{t('project.settings.checkpoints.hint')}</p>
          </div>
          <Switch
            checked={turnCheckpoints}
            label={t('project.settings.checkpoints')}
            disabled={updateProject.isPending}
            onCheckedChange={(checked) => updateProject.mutate({ id: projectId, turnCheckpoints: checked })}
          />
        </div>

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
