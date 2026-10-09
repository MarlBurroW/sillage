import {
  BookOpen,
  CalendarClock,
  Contrast,
  FolderPlus,
  MessageSquare,
  Moon,
  Plug,
  Plus,
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
  ProjectDto,
  ScheduledTaskDto,
  SearchMessageDto,
} from '@sillage/protocol'
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
 * Fabrication des résultats de la palette, un type d'entité après l'autre.
 *
 * Chaque résultat dit où le chercher (ses champs) et ce qu'il ouvre ; le classement, lui,
 * est le même pour tous et vit dans `lib/palette`.
 */

type Translate = (key: MessageKey, params?: MessageParams) => string

const ICON = 15

/**
 * Une description, une consigne : de la prose, où une correspondance éparpillée ne serait
 * que du bruit. Seul un morceau d'un seul tenant y compte.
 */
function prose(text: string) {
  return field(text, 'detail', WEIGHT.detail, { mode: 'strict' })
}

/** Un titre qui se lit comme une phrase : morceaux et initiales, pas de lettres éparses. */
function sentence(text: string) {
  return field(text, 'title', WEIGHT.title, { mode: 'words' })
}

/** Une catégorie de réglages, telle que la déclare la page des réglages. */
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
  mcpServers: readonly McpServer[]
  settings: readonly SettingsEntry[]
  theme: Theme
  applyTheme: (theme: Theme) => void
}

function projectItems(t: Translate, project: ProjectDto, current: boolean): PaletteItem[] {
  // Hors du projet courant, une action ne vient que si la saisie nomme son projet
  // (« nimbus board ») : sans quoi « board » alignerait un board par projet.
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
      // Taper le nom d'un projet liste ses conversations, les plus récentes devant.
      projectField(project.name, { browse: true }),
      kindField(t('search.kind.conversation')),
    ],
    target: { type: 'navigate', to: `/p/${conversation.projectId}/c/${conversation.id}` },
    // Un favori est presque toujours ce qu'on cherche ; un fil rangé ou ouvert par une
    // tâche planifiée, rarement.
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
    // Le thème déjà appliqué n'est pas proposé : le choisir ne ferait rien.
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
 * Tout ce que la palette sait sans interroger le serveur à chaque frappe.
 *
 * Les projets archivés n'y entrent pas, ni rien de ce qui leur appartient : la palette
 * voit ce que la navigation voit.
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
    ...skillItems(t, sources.catalog, names),
    ...generalItems(sources),
  ]
}

/** Fichiers trouvés par le serveur, que la palette reclasse avec le reste. */
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
        // Mêmes champs que la présélection du serveur, voir `search/search-files.ts`.
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

/**
 * Score des passages trouvés dans les messages : sous tout ce qui correspond par son nom,
 * un passage ne disant qu'un mot en commun avec la saisie.
 */
const MESSAGE_SCORE = 0.5

/** Un passage par conversation : dix extraits du même fil noieraient tout le reste. */
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
