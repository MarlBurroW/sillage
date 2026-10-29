import { toggleConcentration, useConcentration } from '../lib/concentration'
import * as Dialog from '@radix-ui/react-dialog'
import { ChevronDown, Loader, Maximize2, Search, X } from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMatch, useNavigate } from 'react-router-dom'
import { SEARCH_MIN_QUERY, type ProjectDto } from '@sillage/protocol'
import type { ProjectActionDto } from '@sillage/protocol'
import { actionView, useActions, useRunAction } from '../lib/actions'
import { useAllConversations } from '../lib/conversations'
import { relativeDate } from '../lib/dates'
import { openTab } from '../lib/editor-tabs'
import { useTranslate } from '../lib/i18n'
import { useMcpServers } from '../lib/mcp'
import {
  PALETTE_FILES_MIN_QUERY,
  field,
  WEIGHT,
  rankPalette,
  recentPalette,
  usePaletteCatalog,
  usePaletteFiles,
  type PaletteGroup,
  type PaletteHit,
  type PaletteItem,
} from '../lib/palette'
import { setPanelOpen, setPanelTab, setPanelTree, showTerminal } from '../lib/panel'
import { projectViewOf, projectViewPath } from '../lib/project-view'
import { useProjects } from '../lib/projects'
import { useSchedules } from '../lib/schedules'
import { splitExcerpt, useMessageSearch } from '../lib/search'
import { useInstance } from '../lib/instance'
import { useCurrentUser } from '../lib/session'
import { useTheme } from '../lib/theme'
import { useMediaQuery } from '../lib/viewport'
import { projectScope } from '../lib/workspace-scope'
import { visibleSections } from '../routes/SettingsPage'
import { Logo } from './Logo'
import { ProjectAvatar } from './ProjectAvatar'
import { buildFileItems, buildMessageItems, buildPaletteItems, type PaletteActionOp } from './palette/items'
import { IconButton, cx } from './ui'

/**
 * Rows per group allow several projects at a glance. A lone group gets all available space;
 * expanded groups show everything up to a readable limit.
 */
const GROUP_ROWS = 5
const SOLO_ROWS = 12
const EXPANDED_ROWS = 40

type Row =
  | { type: 'hit'; key: string; group: string; hit: PaletteHit }
  /** next is the first newly revealed result and receives selection. */
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
 * Focus a file editor when it appears. The panel loads separately and files arrive over the
 * network; without waiting, focus stayed on Close and typing missed the chosen file.
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
 * Search palette with one input and every destination. No filters to configure: group all types by
 * project, favor current project, and put unowned items under General. Project names restrict
 * queries and kind names list that kind. In-memory UI data responds instantly; only files and
 * message content query the server.
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
  /** Selected file to focus on close instead of the trigger. */
  const chosenFile = useRef<string | null>(null)
  const [query, setQuery] = useState('')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const wide = useMediaQuery('(min-width: 48rem)')

  const conversationRoute = useMatch('/p/:projectId/c/:conversationId')
  const discussionRoute = useMatch('/discussions/:conversationId')
  const concentration = useConcentration()
  const canConcentrate = Boolean(conversationRoute || discussionRoute)
  const boardRoute = useMatch('/p/:projectId/board')
  const projectRoute = useMatch('/p/:projectId/*')
  const currentProjectId = projectRoute?.params.projectId ?? null
  const routeId = conversationRoute?.params.conversationId ?? discussionRoute?.params.conversationId
  const draft = routeId === 'new'
  const currentConversationId = draft ? null : (routeId ?? null)

  const { data: user } = useCurrentUser()
  const { data: instance } = useInstance()
  const { data: projects } = useProjects()
  const { data: conversations } = useAllConversations()
  const { data: schedules } = useSchedules()
  const { data: actions } = useActions()
  // mutate is stable, the mutation object is not: avoid rebuilding results every render.
  const { mutate: startAction } = useRunAction()
  // Current-project actions run in the current conversation worktree; other projects navigate first
  // and show terminal output in their panel. Review opens Actions to inspect commands before
  // execution.
  const runAction = useCallback(
    (action: ProjectActionDto, op: PaletteActionOp) => {
      if (op === 'open') {
        const href = actionView(action).href
        if (href) window.open(href, '_blank', 'noreferrer')
        return
      }
      const here = action.projectId === currentProjectId
      if (!here) navigate(projectViewPath(action.projectId, projectViewOf(action.projectId)))
      if (op === 'review') {
        setPanelTab('actions')
        setPanelOpen(true)
      } else if (op === 'output') {
        if (action.lastRun) showTerminal(action.lastRun.terminalId)
      } else {
        startAction({ action, op, conversationId: here ? (currentConversationId ?? undefined) : undefined })
      }
    },
    [currentProjectId, currentConversationId, navigate, startAction],
  )
  const { data: mcp } = useMcpServers()
  const { data: catalog } = usePaletteCatalog(open)
  const [theme, applyTheme] = useTheme()

  const trimmed = query.trim()
  // Keep typing responsive while thousands of results rerank.
  const deferred = useDeferredValue(trimmed)
  const files = usePaletteFiles(open ? trimmed : '', currentConversationId)
  const messages = useMessageSearch(open ? trimmed : '')

  // Reopening starts fresh because the previous search represented an earlier intent.
  useEffect(() => {
    if (open) return
    setQuery('')
    setActiveKey(null)
    setExpanded(new Set())
  }, [open])

  // New queries and results invalidate old selection and expanded groups.
  useEffect(() => {
    setActiveKey(null)
    setExpanded(new Set())
  }, [trimmed])

  const visibleProjects = useMemo(() => projects ?? [], [projects])
  const settings = useMemo(
    () => visibleSections(Boolean(user?.isAdmin), instance?.capabilities),
    [user?.isAdmin, instance?.capabilities],
  )

  // Build only when opened: conversation lists change on every live event and closed palettes have
  // no use for updates.
  const items = useMemo(
    () =>
      !open ? [] : [...(canConcentrate ? [{
        key: 'command:concentration', kind: 'command' as const, projectId: null,
        title: t(concentration ? 'concentration.exit' : 'concentration.enter'),
        icon: <Maximize2 size={15} />,
        fields: [field(t(concentration ? 'concentration.exit' : 'concentration.enter'), 'title', WEIGHT.title)],
        target: { type: 'run' as const, run: toggleConcentration },
      }] : []), ...buildPaletteItems({
        t,
        projects: visibleProjects,
        currentProjectId,
        conversations: conversations ?? [],
        catalog,
        schedules: schedules ?? [],
        actions: actions ?? [],
        runAction,
        mcpServers: mcp?.servers ?? [],
        settings,
        theme,
        applyTheme,
      })],
    [open, canConcentrate, concentration, t, visibleProjects, currentProjectId, conversations, catalog, schedules, actions, runAction, mcp, settings, theme, applyTheme],
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
      const recent = recentPalette(conversations ?? [], byKey, {
        currentProjectId,
        currentConversationId,
        visibleProjects: new Set(visibleProjects.map((project) => project.id)),
      })
      const command = byKey.get('command:concentration')
      if (command) {
        const hit = { item: command, score: 0, title: [], detail: [] }
        const general = recent.find((group) => group.key === 'general')
        if (general) general.hits.unshift(hit)
        else recent.unshift({ key: 'general', projectId: null, score: 0, hits: [hit] })
      }
      return recent
    }
    // Server replies may lag a keystroke; rerank against current input so stale nonmatches never appear.
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

  // Keep keyboard selection visible when it leaves the viewport.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active?.key])

  const projectsById = useMemo(
    () => new Map(visibleProjects.map((project) => [project.id, project])),
    [visibleProjects],
  )

  /**
   * Open files where searched: the open conversation and worktree for its project, otherwise the
   * project panel on its usual landing page to preserve that preference.
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
    // Touch panels fill the screen: show the requested file rather than a tree obscuring it.
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
    // Expansion retains keyboard control and selects the first revealed result where attention goes.
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
      // Move between projects without traversing every row.
      event.preventDefault()
      jumpGroup(event.shiftKey ? -1 : 1)
    }
  }

  // Server results are pending, either debounce or an in-flight request.
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

            {/* Touch palettes fill the screen with no Escape or external backdrop; this button provides the exit. */}
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
                      // Use an index rather than a file key containing paths whose spaces are invalid in identifiers.
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

          {/* Shortcuts matter only with keyboards; omit meaningless touch hints. */}
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

/** Sticky group heading identifies the project while scrolling its results. */
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

/** Text with matching characters highlighted. */
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
          // Use solid highlighting rather than accent wash, already present on selected rows and obscuring matches.
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
    // Top scroll margin reserves sticky-heading space so keyboard selections do not slide underneath.
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
      // Keep input focused: clicking must not blur it before acting.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className={rowClass(selected)}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-ink-faint">{item.icon}</span>

      <span className="min-w-0 flex-1">
        {/*
         * Preserve title space and truncate details: long instructions must not reduce task names
         * to three letters. On touch move details below instead of ellipsis.
         */}
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

/** Compute age only at display: of a thousand conversations, only ten are visible. */
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
