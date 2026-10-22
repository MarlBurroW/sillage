import {
  BookOpen,
  CalendarClock,
  Contrast,
  FolderPlus,
  MessageSquare,
  Moon,
  Plug,
  ExternalLink,
  Play,
  Plus,
  RotateCw,
  ShieldQuestion,
  Square,
  SquareTerminal,
  Server,
  SlidersHorizontal,
  SquareKanban,
  Sun,
  Ticket,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type {
  ConversationDto,
  McpServer,
  PaletteCatalogDto,
  PaletteFilesDto,
  ProjectActionDto,
  ProjectDto,
  ScheduledTaskDto,
  SearchMessageDto,
} from '@sillage/protocol'
import { actionView, describeActionState } from '../../lib/actions'
import type { MessageKey, MessageParams } from '../../lib/i18n'
import { describeTransport } from '../../lib/mcp'
import {
  WEIGHT,
  field,
  kindField,
  projectField,
  type PaletteItem,
} from '../../lib/palette'
import { projectViewOf, projectViewPath } from '../../lib/project-view'
import { THEMES, THEME_LABELS, type Theme } from '../../lib/theme'
import { AgentIcon } from '../AgentIcon'
import { ProjectAvatar } from '../ProjectAvatar'
import { columnLabel } from '../board/columns'
import { FileIcon } from './FileIcon'

/**
 * Build palette results entity type by type. Each supplies searchable fields and destination; all
 * share ranking in lib/palette.
 */

type Translate = (key: MessageKey, params?: MessageParams) => string

const ICON = 15

/** Descriptions and instructions are prose where scattered matches are noise: require contiguous matches. */
function prose(text: string) {
  return field(text, 'detail', WEIGHT.detail, { mode: 'strict' })
}

/** Sentence-like titles allow substrings and initials, not scattered letters. */
function sentence(text: string) {
  return field(text, 'title', WEIGHT.title, { mode: 'words' })
}

/** Settings category as declared by the settings page. */
export interface SettingsEntry {
  to: string
  labelKey: MessageKey
  descriptionKey: MessageKey
  icon: ReactNode
}

export interface PaletteSources {
  t: Translate
  projects: readonly ProjectDto[]
  currentProjectId: string | null
  conversations: readonly ConversationDto[]
  catalog: PaletteCatalogDto | undefined
  schedules: readonly ScheduledTaskDto[]
  actions: readonly ProjectActionDto[]
  runAction: (action: ProjectActionDto, op: PaletteActionOp) => void
  mcpServers: readonly McpServer[]
  settings: readonly SettingsEntry[]
  theme: Theme
  applyTheme: (theme: Theme) => void
}

function projectItems(t: Translate, project: ProjectDto, current: boolean): PaletteItem[] {
  // Other-project shortcuts appear only when the query names their project (nimbus board), or board
  // would list every project's board.
  const context = projectField(project.name, { required: !current })
  const action = (key: string, title: string, to: string, icon: ReactNode): PaletteItem => ({
    key: `action:${key}:${project.id}`,
    kind: 'action',
    projectId: project.id,
    title,
    icon,
    fields: [sentence(title), context],
    target: { type: 'navigate', to },
  })

  return [
    {
      key: `project:${project.id}`,
      kind: 'project',
      projectId: project.id,
      title: project.name,
      detail: project.workspacePath,
      icon: <ProjectAvatar project={project} className="size-[15px]" />,
      aside: t('search.kind.project'),
      fields: [
        field(project.name, 'title', WEIGHT.title),
        field(project.workspacePath, 'detail', WEIGHT.detail, { mode: 'strict' }),
        kindField(t('search.kind.project')),
      ],
      target: { type: 'navigate', to: projectViewPath(project.id, projectViewOf(project.id)) },
    },
    action('new', t('board.newConversation'), `/p/${project.id}/c/new`, <Plus size={ICON} />),
    action('board', t('shell.project.board'), `/p/${project.id}/board`, <SquareKanban size={ICON} />),
    action('schedules', t('schedule.title'), `/p/${project.id}/schedules`, <CalendarClock size={ICON} />),
    action('settings', t('shell.project.settings'), `/p/${project.id}`, <SlidersHorizontal size={ICON} />),
  ]
}

function conversationItem(t: Translate, conversation: ConversationDto, project: ProjectDto): PaletteItem {
  const card = conversation.card ? `#${conversation.card.number} ${conversation.card.title}` : undefined
  return {
    key: `conversation:${conversation.id}`,
    kind: 'conversation',
    projectId: conversation.projectId,
    title: conversation.title,
    detail: card,
    icon: <AgentIcon agent={conversation.agent} size={ICON} />,
    aside: conversation.archivedAt === null ? undefined : t('search.archived'),
    at: conversation.updatedAt,
    fields: [
      sentence(conversation.title),
      ...(card ? [prose(card)] : []),
      // Project-name queries list its conversations newest first.
      projectField(project.name, { browse: true }),
      kindField(t('search.kind.conversation')),
    ],
    target: { type: 'navigate', to: `/p/${conversation.projectId}/c/${conversation.id}` },
    // Favorites are usually intended; archived or scheduled threads rarely are.
    boost: (conversation.favorite ? 1.5 : 0) - (conversation.archivedAt !== null ? 3 : 0) - (conversation.scheduleId ? 1 : 0),
  }
}

function cardItems(t: Translate, catalog: PaletteCatalogDto | undefined, names: Map<string, string>): PaletteItem[] {
  return (catalog?.cards ?? []).flatMap((card): PaletteItem[] => {
    const project = names.get(card.projectId)
    if (project === undefined) return []
    const title = `#${card.number} ${card.title}`
    const closed = card.column === 'done' || card.column === 'abandoned'
    return [{
      key: `card:${card.id}`,
      kind: 'card',
      projectId: card.projectId,
      title,
      detail: columnLabel(card.column),
      icon: <Ticket size={ICON} />,
      aside: t('search.kind.card'),
      fields: [sentence(title), projectField(project), kindField(t('search.kind.card'))],
      target: { type: 'navigate', to: `/p/${card.projectId}/board?carte=${card.number}` },
      boost: closed ? -1.5 : 0,
    }]
  })
}

function scheduleItems(t: Translate, schedules: readonly ScheduledTaskDto[], names: Map<string, string>): PaletteItem[] {
  return schedules.flatMap((task): PaletteItem[] => {
    const project = names.get(task.projectId)
    if (project === undefined) return []
    const prompt = task.prompt.split('\n', 1)[0] ?? ''
    return [{
      key: `schedule:${task.id}`,
      kind: 'schedule',
      projectId: task.projectId,
      title: task.name,
      detail: prompt,
      icon: <CalendarClock size={ICON} />,
      aside: task.enabled ? t('search.kind.schedule') : `${t('search.kind.schedule')} · ${t('search.paused')}`,
      fields: [
        sentence(task.name),
        prose(prompt),
        projectField(project),
        kindField(t('search.kind.schedule')),
      ],
      target: { type: 'navigate', to: `/p/${task.projectId}/schedules` },
      boost: task.enabled ? 0 : -1,
    }]
  })
}

/** Action performed by a palette result. */
export type PaletteActionOp = 'run' | 'stop' | 'restart' | 'open' | 'output' | 'review'

const ACTION_OPS: Record<PaletteActionOp, { title: MessageKey; icon: ReactNode }> = {
  run: { title: 'search.command.runAction', icon: <Play size={ICON} /> },
  stop: { title: 'search.command.stopAction', icon: <Square size={ICON - 2} /> },
  restart: { title: 'search.command.restartAction', icon: <RotateCw size={ICON} /> },
  open: { title: 'search.command.openAction', icon: <ExternalLink size={ICON} /> },
  output: { title: 'search.command.outputAction', icon: <SquareTerminal size={ICON} /> },
  review: { title: 'search.command.reviewAction', icon: <ShieldQuestion size={ICON} /> },
}

/**
 * Project actions with state-appropriate gestures: running services stop, restart, or open rather
 * than start twice. Other-project actions require naming their project, like project shortcuts.
 */
function runItems(sources: PaletteSources, names: Map<string, string>): PaletteItem[] {
  const { t } = sources
  return sources.actions.flatMap((action): PaletteItem[] => {
    const project = names.get(action.projectId)
    if (project === undefined) return []
    const view = actionView(action)
    const ops: PaletteActionOp[] =
      view.primary === 'review' ? ['review']
        : view.primary === 'stop' ? [...(view.href ? ['open' as const] : []), 'stop', 'restart']
          : view.primary === 'output' ? ['output']
            : ['run']
    const state = describeActionState(action, t)
    return ops.map((op): PaletteItem => {
      const title = t(ACTION_OPS[op].title, { label: action.label })
      return {
        key: `run:${action.id}:${op}`,
        kind: 'action',
        projectId: action.projectId,
        title,
        detail: state,
        icon: ACTION_OPS[op].icon,
        aside: t('search.kind.runAction'),
        fields: [
          // Include verbs in matching: stop finds running services, launch finds waiting ones.
          sentence(title),
          prose(action.command),
          projectField(project, { required: action.projectId !== sources.currentProjectId }),
          kindField(t('search.kind.runAction')),
        ],
        target: { type: 'run', run: () => sources.runAction(action, op) },
      }
    })
  })
}

function skillItems(t: Translate, catalog: PaletteCatalogDto | undefined, names: Map<string, string>): PaletteItem[] {
  return (catalog?.skills ?? []).flatMap((skill): PaletteItem[] => {
    const project = skill.projectId === null ? null : names.get(skill.projectId)
    if (project === undefined) return []
    return [{
      key: `skill:${skill.id}`,
      kind: 'skill',
      projectId: skill.projectId,
      title: skill.name,
      detail: skill.description,
      icon: <BookOpen size={ICON} />,
      aside: skill.enabled ? t('search.kind.skill') : `${t('search.kind.skill')} · ${t('search.disabled')}`,
      fields: [
        field(skill.name, 'title', WEIGHT.title),
        prose(skill.description),
        ...(project === null ? [] : [projectField(project)]),
        kindField(t('search.kind.skill')),
      ],
      target: { type: 'navigate', to: `/skills/${skill.id}` },
      boost: skill.enabled ? 0 : -1,
    }]
  })
}

function generalItems(sources: PaletteSources): PaletteItem[] {
  const { t } = sources
  const settingsContext = [kindField(t('settings.title')), kindField(t('shell.settings.label'))]

  const settings = sources.settings.map((section): PaletteItem => {
    const title = t(section.labelKey)
    const detail = t(section.descriptionKey)
    return {
      key: `setting:${section.to}`,
      kind: 'setting',
      projectId: null,
      title,
      detail,
      icon: section.icon,
      aside: t('settings.title'),
      fields: [sentence(title), prose(detail), ...settingsContext],
      target: { type: 'navigate', to: `/settings/${section.to}` },
    }
  })

  const mcp = sources.mcpServers.map((server): PaletteItem => {
    const detail = describeTransport(server.transport)
    return {
      key: `mcp:${server.id}`,
      kind: 'mcp',
      projectId: null,
      title: server.name,
      detail,
      icon: <Plug size={ICON} />,
      aside: server.enabled ? t('search.kind.mcp') : `${t('search.kind.mcp')} · ${t('search.disabled')}`,
      fields: [field(server.name, 'title', WEIGHT.title), prose(detail), kindField(t('search.kind.mcp'))],
      target: { type: 'navigate', to: '/settings/mcp' },
      boost: server.enabled ? 0 : -1,
    }
  })

  const command = (key: string, title: string, icon: ReactNode, target: PaletteItem['target']): PaletteItem => ({
    key: `command:${key}`,
    kind: 'command',
    projectId: null,
    title,
    icon,
    aside: t('search.kind.command'),
    fields: [sentence(title), kindField(t('search.kind.command'))],
    target,
  })
  const themeIcons: Record<Theme, ReactNode> = {
    light: <Sun size={ICON} />,
    dark: <Moon size={ICON} />,
    'dark-contrast': <Contrast size={ICON} />,
  }
  const commands = [
    command('new-project', t('shell.projects.add'), <FolderPlus size={ICON} />, { type: 'navigate', to: '/projects/new' }),
    command('services', t('services.title'), <Server size={ICON} />, { type: 'navigate', to: '/services' }),
    // Omit the applied theme because selecting it would do nothing.
    ...THEMES.filter((theme) => theme !== sources.theme).map((theme) =>
      command(`theme:${theme}`, t('search.command.theme', { name: t(THEME_LABELS[theme]) }), themeIcons[theme], {
        type: 'run',
        run: () => sources.applyTheme(theme),
      }),
    ),
  ]

  return [...settings, ...mcp, ...commands]
}

/**
 * Everything known without per-keystroke server queries. Exclude archived projects and their
 * contents so palette visibility matches navigation.
 */
export function buildPaletteItems(sources: PaletteSources): PaletteItem[] {
  const { t } = sources
  const byId = new Map(sources.projects.map((project) => [project.id, project]))
  const names = new Map(sources.projects.map((project) => [project.id, project.name]))

  const conversations = sources.conversations.flatMap((conversation) => {
    const project = byId.get(conversation.projectId)
    return project ? [conversationItem(t, conversation, project)] : []
  })

  return [
    ...sources.projects.flatMap((project) => projectItems(t, project, project.id === sources.currentProjectId)),
    ...conversations,
    ...cardItems(t, sources.catalog, names),
    ...scheduleItems(t, sources.schedules, names),
    ...runItems(sources, names),
    ...skillItems(t, sources.catalog, names),
    ...generalItems(sources),
  ]
}

/** Server-found files reranked alongside other results. */
export function buildFileItems(t: Translate, files: PaletteFilesDto | undefined, projects: readonly ProjectDto[]): PaletteItem[] {
  const names = new Map(projects.map((project) => [project.id, project.name]))
  return (files?.projects ?? []).flatMap((group) => {
    const project = names.get(group.projectId)
    if (project === undefined) return []
    return group.paths.map((path): PaletteItem => {
      const slash = path.lastIndexOf('/')
      const name = path.slice(slash + 1)
      const dir = slash === -1 ? '' : path.slice(0, slash)
      return {
        key: `file:${group.projectId}:${path}`,
        kind: 'file',
        projectId: group.projectId,
        title: name,
        detail: dir || undefined,
        icon: <FileIcon name={name} />,
        aside: t('search.kind.file'),
        // Same fields as server preselection; see search/search-files.ts.
        fields: [
          field(name, 'title', WEIGHT.title),
          field(dir, 'detail', WEIGHT.dir, { mode: 'strict' }),
          projectField(project),
        ],
        target: { type: 'file', projectId: group.projectId, path },
      }
    })
  })
}

/** Message excerpt scores rank below named matches because excerpts may share only incidental query words. */
const MESSAGE_SCORE = 0.5

/** One excerpt per conversation: ten from one thread would bury other results. */
export function buildMessageItems(
  t: Translate,
  messages: readonly SearchMessageDto[] | undefined,
  projects: readonly ProjectDto[],
  conversations: readonly ConversationDto[],
): PaletteItem[] {
  const visible = new Set(projects.map((project) => project.id))
  const titles = new Map(conversations.map((conversation) => [conversation.id, conversation.title]))
  const seen = new Set<string>()
  return (messages ?? []).flatMap((message): PaletteItem[] => {
    if (!visible.has(message.projectId) || seen.has(message.conversationId)) return []
    seen.add(message.conversationId)
    return [{
      key: `message:${message.conversationId}:${message.seq}`,
      kind: 'message',
      projectId: message.projectId,
      title: titles.get(message.conversationId) ?? message.conversationTitle,
      excerpt: message.excerpt,
      icon: <MessageSquare size={ICON} />,
      aside: message.role === 'user' ? t('search.role.user') : t('search.role.agent'),
      fields: [],
      target: { type: 'navigate', to: `/p/${message.projectId}/c/${message.conversationId}?seq=${message.seq}` },
      fixedScore: MESSAGE_SCORE,
    }]
  })
}
