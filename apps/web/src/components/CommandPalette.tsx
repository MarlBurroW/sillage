import * as Dialog from '@radix-ui/react-dialog'
import { ChevronDown, Loader, Search, X } from 'lucide-react'
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMatch, useNavigate } from 'react-router-dom'
import { SEARCH_MIN_QUERY, type ProjectDto } from '@sillage/protocol'
import { useAllConversations } from '../lib/conversations'
import { relativeDate } from '../lib/dates'
import { openTab } from '../lib/editor-tabs'
import { useTranslate } from '../lib/i18n'
import { useMcpServers } from '../lib/mcp'
import {
  PALETTE_FILES_MIN_QUERY,
  rankPalette,
  recentPalette,
  usePaletteCatalog,
  usePaletteFiles,
  type PaletteGroup,
  type PaletteHit,
  type PaletteItem,
} from '../lib/palette'
import { setPanelOpen, setPanelTab, setPanelTree } from '../lib/panel'
import { projectViewOf, projectViewPath } from '../lib/project-view'
import { useProjects } from '../lib/projects'
import { useSchedules } from '../lib/schedules'
import { splitExcerpt, useMessageSearch } from '../lib/search'
import { useCurrentUser } from '../lib/session'
import { useTheme } from '../lib/theme'
import { useMediaQuery } from '../lib/viewport'
import { projectScope } from '../lib/workspace-scope'
import { SECTIONS } from '../routes/SettingsPage'
import { Logo } from './Logo'
import { ProjectAvatar } from './ProjectAvatar'
import { buildFileItems, buildMessageItems, buildPaletteItems } from './palette/items'
import { IconButton, cx } from './ui'

/**
 * Lignes par groupe : de quoi voir plusieurs projets d'un coup d'oeil. Un groupe seul
 * a toute la place, et un groupe déplié montre tout ce qu'il a, dans une limite qui
 * reste lisible.
 */
const GROUP_ROWS = 5
const SOLO_ROWS = 12
const EXPANDED_ROWS = 40

type Row =
  | { type: 'hit'; key: string; group: string; hit: PaletteHit }
  /** `next` : le premier résultat qu'il révèle, où la sélection descend. */
  | { type: 'more'; key: string; group: string; hidden: number; next: string | undefined }

interface Section {
  group: PaletteGroup
  rows: Row[]
}

function layout(groups: readonly PaletteGroup[], expanded: ReadonlySet<string>): Section[] {
  const limit = groups.length === 1 ? SOLO_ROWS : GROUP_ROWS
  return groups.map((group) => {
    const shown = group.hits.slice(0, expanded.has(group.key) ? EXPANDED_ROWS : limit)
    const rows: Row[] = shown.map((hit) => ({ type: 'hit', key: hit.item.key, group: group.key, hit }))
    const hidden = Math.min(group.hits.length, EXPANDED_ROWS) - shown.length
    if (hidden > 0) {
      const next = group.hits[shown.length]?.item.key
      rows.push({ type: 'more', key: `more:${group.key}`, group: group.key, hidden, next })
    }
    return { group, rows }
  })
}

/**
 * Donne le focus à l'éditeur d'un fichier dès qu'il s'affiche.
 *
 * Le panneau peut ne pas être encore là : il se charge à part, et le fichier se lit par
 * le réseau. Sans cette attente, le focus restait sur le bouton de fermeture du panneau,
 * et la première frappe partait ailleurs que dans le fichier qu'on venait de choisir.
 */
function focusEditorFile(path: string): void {
  const focus = () => {
    const file = Array.from(
      document.querySelectorAll<HTMLElement>('[data-panel="workspace"] [data-editor-file]'),
    ).find((node) => node.dataset.editorFile === path)
    if (!file) return false
    ;(file.querySelector<HTMLElement>('.cm-content') ?? file).focus({ preventScroll: true })
    return true
  }
  if (focus()) return
  const observer = new MutationObserver(() => {
    if (!focus()) return
    observer.disconnect()
    clearTimeout(timer)
  })
  const timer = setTimeout(() => observer.disconnect(), 3000)
  observer.observe(document.body, { childList: true, subtree: true })
}

/**
 * Palette de recherche : une saisie, et tout ce qu'on peut rejoindre.
 *
 * Aucun filtre à régler : les résultats de tous types se rangent sous leur projet, le
 * projet courant favorisé, et ce qui n'appartient à aucun projet se range sous
 * « Général ». Taper le nom d'un projet le restreint (« nimbus cache »), taper un type le
 * liste (« skill », « ticket »). Tout ce que l'interface tient déjà en mémoire répond à
 * la frappe ; seuls les fichiers et le contenu des messages passent par le serveur.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const listId = useId()
  const list = useRef<HTMLDivElement>(null)
  /** Fichier choisi, qui doit recevoir le focus à la fermeture plutôt que le déclencheur. */
  const chosenFile = useRef<string | null>(null)
  const [query, setQuery] = useState('')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const wide = useMediaQuery('(min-width: 48rem)')

  const conversationRoute = useMatch('/p/:projectId/c/:conversationId')
  const boardRoute = useMatch('/p/:projectId/board')
  const projectRoute = useMatch('/p/:projectId/*')
  const currentProjectId = projectRoute?.params.projectId ?? null
  const draft = conversationRoute?.params.conversationId === 'new'
  const currentConversationId = draft ? null : (conversationRoute?.params.conversationId ?? null)

  const { data: user } = useCurrentUser()
  const { data: projects } = useProjects()
  const { data: conversations } = useAllConversations()
  const { data: schedules } = useSchedules()
  const { data: mcp } = useMcpServers()
  const { data: catalog } = usePaletteCatalog(open)
  const [theme, applyTheme] = useTheme()

  const trimmed = query.trim()
  // La frappe reste fluide pendant que des milliers de résultats se reclassent derrière.
  const deferred = useDeferredValue(trimmed)
  const files = usePaletteFiles(open ? trimmed : '', currentConversationId)
  const messages = useMessageSearch(open ? trimmed : '')

  // Rouvrir la palette repart d'une page blanche : la recherche précédente répondait à
  // une intention qui n'est plus celle du moment.
  useEffect(() => {
    if (open) return
    setQuery('')
    setActiveKey(null)
    setExpanded(new Set())
  }, [open])

  // Une autre saisie, d'autres résultats : la sélection et les groupes dépliés
  // désignaient ceux d'avant.
  useEffect(() => {
    setActiveKey(null)
    setExpanded(new Set())
  }, [trimmed])

  const visibleProjects = useMemo(() => projects ?? [], [projects])
  const settings = useMemo(
    () => SECTIONS.filter((section) => !section.adminOnly || user?.isAdmin),
    [user?.isAdmin],
  )

  // Fabriqués à l'ouverture seulement : la liste des conversations bouge à chaque
  // événement d'une session en cours, et la palette fermée n'a rien à en faire.
  const items = useMemo(
    () =>
      !open ? [] : buildPaletteItems({
        t,
        projects: visibleProjects,
        currentProjectId,
        conversations: conversations ?? [],
        catalog,
        schedules: schedules ?? [],
        mcpServers: mcp?.servers ?? [],
        settings,
        theme,
        applyTheme,
      }),
    [open, t, visibleProjects, currentProjectId, conversations, catalog, schedules, mcp, settings, theme, applyTheme],
  )
  const fileItems = useMemo(
    () => buildFileItems(t, files.data, visibleProjects),
    [t, files.data, visibleProjects],
  )
  const messageItems = useMemo(
    () => buildMessageItems(t, messages.data, visibleProjects, conversations ?? []),
    [t, messages.data, visibleProjects, conversations],
  )

  const groups = useMemo((): PaletteGroup[] => {
    if (!open) return []
    if (!deferred) {
      const byKey = new Map(items.map((item) => [item.key, item]))
      return recentPalette(conversations ?? [], byKey, {
        currentProjectId,
        currentConversationId,
        visibleProjects: new Set(visibleProjects.map((project) => project.id)),
      })
    }
    // Les réponses du serveur peuvent dater d'une frappe : reclassées contre la saisie
    // du moment, elles ne montrent jamais un résultat qui ne correspond plus.
    const searchable = [
      ...items,
      ...(deferred.length >= PALETTE_FILES_MIN_QUERY ? fileItems : []),
      ...(deferred.length >= SEARCH_MIN_QUERY ? messageItems : []),
    ]
    return rankPalette(searchable, deferred, {
      currentProjectId,
      projectOrder: visibleProjects.map((project) => project.id),
    })
  }, [open, deferred, items, fileItems, messageItems, conversations, currentProjectId, currentConversationId, visibleProjects])

  const sections = useMemo(() => layout(groups, expanded), [groups, expanded])
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections])
  const activeIndex = Math.max(0, rows.findIndex((row) => row.key === activeKey))
  const active = rows[activeIndex]

  // La sélection au clavier doit rester visible quand elle sort de la zone affichée.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active?.key])

  const projectsById = useMemo(
    () => new Map(visibleProjects.map((project) => [project.id, project])),
    [visibleProjects],
  )

  /**
   * Un fichier s'ouvre dans le panneau, là où il a été cherché : dans la conversation
   * ouverte quand il est de son projet, worktree compris ; sinon dans le panneau du
   * projet, sur sa vue d'accueil habituelle, pour ne pas la changer en passant.
   */
  const openFile = (projectId: string, path: string) => {
    let scope: string
    if (projectId === currentProjectId && currentConversationId) {
      scope = currentConversationId
    } else {
      scope = projectScope(projectId)
      const hasPanel = projectId === currentProjectId && (draft || boardRoute !== null)
      if (!hasPanel) navigate(projectViewPath(projectId, projectViewOf(projectId)))
    }
    openTab(scope, path)
    setPanelTab('files')
    setPanelOpen(true)
    chosenFile.current = path
    // Au doigt, le panneau prend tout l'écran : c'est le fichier qu'on veut voir, pas
    // l'arborescence qui le cacherait.
    if (!wide) setPanelTree(false, false)
  }

  const run = (item: PaletteItem) => {
    onOpenChange(false)
    const { target } = item
    if (target.type === 'navigate') navigate(target.to)
    else if (target.type === 'run') target.run()
    else openFile(target.projectId, target.path)
  }

  const choose = (row: Row | undefined) => {
    if (!row) return
    if (row.type === 'hit') {
      run(row.hit.item)
      return
    }
    // Déplier garde la main sur le clavier : la sélection descend sur le premier
    // résultat révélé, là où l'oeil va.
    setExpanded((current) => new Set([...current, row.group]))
    setActiveKey(row.next ?? null)
  }

  const jumpGroup = (direction: 1 | -1) => {
    if (sections.length < 2 || !active) return
    const current = sections.findIndex((section) => section.group.key === active.group)
    const next = sections[(current + direction + sections.length) % sections.length]
    setActiveKey(next?.rows[0]?.key ?? null)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActiveKey(rows[(activeIndex + step + rows.length) % rows.length]?.key ?? null)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(active)
    } else if (event.key === 'Tab' && sections.length > 1) {
      // Passer d'un projet à l'autre sans traverser leurs lignes une à une.
      event.preventDefault()
      jumpGroup(event.shiftKey ? -1 : 1)
    }
  }

  // Le serveur doit encore répondre : saisie en attente de son délai, ou requête en vol.
  const fetching =
    files.settling ||
    messages.settling ||
    (trimmed.length >= PALETTE_FILES_MIN_QUERY && files.isFetching) ||
    (trimmed.length >= SEARCH_MIN_QUERY && messages.isFetching)
  const pending = trimmed !== deferred || fetching

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            const path = chosenFile.current
            if (!path) return
            chosenFile.current = null
            event.preventDefault()
            focusEditorFile(path)
          }}
          className={cx(
            'surface fixed z-50 flex flex-col overflow-hidden border-line shadow-pop',
            'inset-0 border-0',
            'sm:inset-auto sm:top-[12dvh] sm:left-1/2 sm:max-h-[76dvh] sm:w-[min(44rem,94vw)]',
            'sm:-translate-x-1/2 sm:rounded-xl sm:border',
          )}
        >
          <Dialog.Title className="sr-only">{t('search.title')}</Dialog.Title>

          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 pt-safe">
            <Search size={16} className="shrink-0 text-ink-faint" />
            <input
              autoFocus
              role="combobox"
              aria-label={t('search.dialog.label')}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={rows.length ? `${listId}-${activeIndex}` : undefined}
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t('search.placeholder')}
              className="h-12 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            />
            {pending && trimmed ? <Loader size={15} className="shrink-0 animate-spin text-ink-faint" /> : null}

            {/* Au doigt la palette occupe tout l'écran : il n'y a ni touche Échap ni
                voile à toucher à côté, donc rien pour en sortir sans ce bouton. */}
            <IconButton label={t('search.close')} className="sm:hidden" onClick={() => onOpenChange(false)}>
              <X size={18} />
            </IconButton>
          </div>

          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label={t('search.results')}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5 pb-safe"
          >
            {sections.map(({ group, rows: groupRows }) => (
              <div key={group.key} role="group" aria-labelledby={`${listId}-g-${group.key}`}>
                <GroupHeader
                  id={`${listId}-g-${group.key}`}
                  project={group.projectId ? projectsById.get(group.projectId) : undefined}
                  current={group.projectId !== null && group.projectId === currentProjectId}
                />
                {groupRows.map((row) =>
                  row.type === 'hit' ? (
                    <HitRow
                      key={row.key}
                      // L'indice et non la clé : une clé de fichier porte son chemin, qui
                      // peut contenir des espaces, interdits dans un identifiant.
                      id={`${listId}-${rows.indexOf(row)}`}
                      hit={row.hit}
                      selected={row.key === active?.key}
                      onHover={() => setActiveKey(row.key)}
                      onSelect={() => choose(row)}
                    />
                  ) : (
                    <MoreRow
                      key={row.key}
                      id={`${listId}-${rows.indexOf(row)}`}
                      hidden={row.hidden}
                      selected={row.key === active?.key}
                      onHover={() => setActiveKey(row.key)}
                      onSelect={() => choose(row)}
                    />
                  ),
                )}
              </div>
            ))}

            {sections.length === 0 && !pending ? (
              <p role="status" className="px-2.5 py-8 text-center text-sm text-ink-faint">
                {!trimmed
                  ? t('search.empty.start')
                  : trimmed.length < SEARCH_MIN_QUERY
                    ? t('search.empty.moreChars', { count: SEARCH_MIN_QUERY - trimmed.length })
                    : t('search.empty.none')}
              </p>
            ) : null}
            {files.isError && trimmed.length >= PALETTE_FILES_MIN_QUERY ? (
              <p role="alert" className="px-2.5 py-2 text-xs text-critical">{t('search.files.error')}</p>
            ) : null}
          </div>

          {/* Les raccourcis n'existent qu'au clavier : au doigt, la ligne ne dirait rien. */}
          <div className="hidden shrink-0 items-center gap-4 border-t border-line px-3 py-2 text-[0.6875rem] text-ink-faint sm:flex pointer-coarse:hidden">
            <Hint keys="↑ ↓" label={t('search.hint.navigate')} />
            <Hint keys="↵" label={t('search.hint.open')} />
            {sections.length > 1 ? <Hint keys="⇥" label={t('search.hint.group')} /> : null}
            <Hint keys="esc" label={t('search.hint.close')} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <kbd className="rounded border border-line px-1 font-sans text-[0.625rem]">{keys}</kbd>
      {label}
    </span>
  )
}

/**
 * En-tête de groupe, collé en haut de la liste pendant qu'on fait défiler ses lignes :
 * c'est lui qui dit à quel projet appartient ce qu'on regarde.
 */
function GroupHeader({ id, project, current }: { id: string; project: ProjectDto | undefined; current: boolean }) {
  const t = useTranslate()
  return (
    <div
      id={id}
      className="surface sticky top-0 z-10 flex items-center gap-2 px-2.5 pt-2.5 pb-1 text-xs font-semibold text-ink-soft"
    >
      {project ? (
        <ProjectAvatar project={project} className="size-4" />
      ) : (
        <Logo size={14} className="text-accent" />
      )}
      <span className="min-w-0 truncate">{project ? project.name : t('search.group.general')}</span>
      {current ? <span className="shrink-0 font-normal text-ink-faint">{t('search.group.current')}</span> : null}
    </div>
  )
}

/** Texte dont certaines lettres sont surlignées, celles que la saisie a retenues. */
function Highlighted({ text, positions }: { text: string; positions: readonly number[] }) {
  if (positions.length === 0) return <>{text}</>
  const marked = new Set(positions)
  const parts: { text: string; hit: boolean }[] = []
  for (let index = 0; index < text.length; index += 1) {
    const hit = marked.has(index)
    const last = parts.at(-1)
    if (last && last.hit === hit) last.text += text[index]
    else parts.push({ text: text[index] as string, hit })
  }
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? (
          <mark key={index} className="bg-transparent font-semibold text-ink">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

function Excerpt({ excerpt }: { excerpt: string }) {
  return (
    <>
      {splitExcerpt(excerpt).map((part, index) =>
        part.hit ? (
          // Fond franc plutôt que le lavis d'accent : la ligne sélectionnée porte déjà ce
          // lavis, et le passage trouvé s'y confondait.
          <mark key={index} className="rounded bg-accent/25 px-0.5 font-medium text-ink">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

function rowClass(selected: boolean, compact = false) {
  return cx(
    // La marge haute de défilement laisse la place de l'en-tête collé : sans elle, la
    // ligne choisie au clavier remonterait dessous.
    'flex w-full cursor-pointer scroll-mt-9 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left',
    compact ? 'min-h-8 text-xs' : 'min-h-10 pointer-coarse:min-h-12',
    selected ? 'bg-accent-wash text-ink' : compact ? 'text-ink-faint' : 'text-ink-soft',
  )
}

function HitRow({
  id,
  hit,
  selected,
  onHover,
  onSelect,
}: {
  id: string
  hit: PaletteHit
  selected: boolean
  onHover: () => void
  onSelect: () => void
}) {
  const { item } = hit
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      onMouseMove={onHover}
      // Le champ garde le focus : un clic ne doit pas le lui retirer avant d'agir.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className={rowClass(selected)}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-ink-faint">{item.icon}</span>

      <span className="min-w-0 flex-1">
        {/* Le titre garde sa place, c'est le détail qui s'efface : une consigne longue
            ne doit pas réduire le nom d'une tâche à ses trois premières lettres. Au doigt,
            le détail passe dessous plutôt que de se réduire à des points de suspension. */}
        <span className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-2">
          <span className="max-w-full shrink-0 truncate text-sm">
            <Highlighted text={item.title} positions={hit.title} />
          </span>
          {item.detail ? (
            <span className="min-w-0 truncate text-xs text-ink-faint sm:flex-1">
              <Highlighted text={item.detail} positions={hit.detail} />
            </span>
          ) : null}
        </span>
        {item.excerpt ? (
          <span className="mt-0.5 line-clamp-2 text-xs text-ink-faint">
            <Excerpt excerpt={item.excerpt} />
          </span>
        ) : null}
      </span>

      <Aside item={item} />
    </div>
  )
}

/** L'ancienneté se calcule à l'affichage : pour mille conversations, seules dix se voient. */
function Aside({ item }: { item: PaletteItem }) {
  const parts = [item.aside, item.at === undefined ? undefined : relativeDate(item.at)].filter(Boolean)
  if (parts.length === 0) return null
  return <span className="shrink-0 text-[0.6875rem] text-ink-faint">{parts.join(' · ')}</span>
}

function MoreRow({
  id,
  hidden,
  selected,
  onHover,
  onSelect,
}: {
  id: string
  hidden: number
  selected: boolean
  onHover: () => void
  onSelect: () => void
}) {
  const t = useTranslate()
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      onMouseMove={onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className={rowClass(selected, true)}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <ChevronDown size={14} />
      </span>
      <span>{t('search.more', { count: hidden })}</span>
    </div>
  )
}
