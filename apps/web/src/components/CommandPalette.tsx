import { toggleConcentration, useConcentration } from '../lib/concentration'
import { toggleRadio, useRadio, useRadioStation } from '../lib/radio'
import { toggleSounds, useSoundPrefs } from '../lib/sounds'
import * as Dialog from '@radix-ui/react-dialog'
import { Loader, Maximize2, Radio, Search, Ticket, Volume2, VolumeX, X } from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMatch, useNavigate } from 'react-router-dom'
import { SEARCH_MIN_QUERY, sessionReference } from '@sillage/protocol'
import type { ProjectActionDto } from '@sillage/protocol'
import { useQueryClient } from '@tanstack/react-query'
import { actionView, useActions, useRunAction } from '../lib/actions'
import { useCreateCard } from '../lib/cards'
import { copyText } from '../lib/clipboard'
import { saveDraft } from '../lib/composer-drafts'
import { prefillComposer } from '../lib/composer-ref'
import { liveSeq, liveStatus } from '../lib/conversation-status'
import {
  useAllConversations,
  useArchiveConversation,
  useRenameConversation,
  useSetConversationCard,
  useToggleFavorite,
} from '../lib/conversations'
import { openDecision, useDecisions } from '../lib/decisions'
import { focusEditorFile, useOpenPanelFile } from '../lib/editor-focus'
import { useTranslate } from '../lib/i18n'
import { useInstance } from '../lib/instance'
import { useMcpServers } from '../lib/mcp'
import {
  CREATE_GROUP,
  PALETTE_FILES_MIN_QUERY,
  PALETTE_MODIFIER,
  PALETTE_SHORTCUT,
  SESSION_GROUP,
  WEIGHT,
  browsePalette,
  field,
  paletteUsageBoosts,
  parsePaletteQuery,
  prefixKinds,
  rankPalette,
  recentPalette,
  recordPaletteUse,
  scopePalette,
  usePaletteCatalog,
  usePaletteFiles,
  type PaletteGroup,
  type PaletteHit,
  type PaletteItem,
  type PaletteNotice,
  type PaletteStep,
  type ScopedPalette,
} from '../lib/palette'
import { setPanelOpen, setPanelTab, showTerminal, type PanelTab } from '../lib/panel'
import { projectViewOf, projectViewPath } from '../lib/project-view'
import { useProjects } from '../lib/projects'
import { isUnread } from '../lib/reads'
import { useSchedules } from '../lib/schedules'
import { useMessageSearch } from '../lib/search'
import { useSessionCommands } from '../lib/session-commands'
import { shadowedBySection, useSessionViews, viewName } from '../lib/session-views'
import { useCurrentUser } from '../lib/session'
import { useTheme } from '../lib/theme'
import { projectScope } from '../lib/workspace-scope'
import { visibleSections } from '../routes/SettingsPage'
import {
  buildAttentionItems,
  buildCreateItems,
  buildFileItems,
  buildMessageItems,
  buildPaletteItems,
  buildSessionItems,
  type PaletteActionOp,
} from './palette/items'
import {
  ActionRow,
  GroupHeader,
  Hint,
  HitRow,
  MoreRow,
  NoticeLine,
  ScopeOffer,
  ScopeToken,
  StepToken,
  WidenRow,
} from './palette/rows'
import { IconButton, cx } from './ui'

/**
 * Rows per group allow several projects at a glance. A lone group gets all available space;
 * expanded groups show everything up to a readable limit.
 */
const GROUP_ROWS = 5
const SOLO_ROWS = 12
const EXPANDED_ROWS = 40
/** Rows waiting on the user before any query: beyond a handful, Activity is the place to triage. */
const ATTENTION_ROWS = 6
/** Shorter texts name nothing worth creating, and would offer the rows on every first letter. */
const CREATE_MIN_QUERY = 3
/** How long a confirmation stays before the palette closes on its own. */
const NOTICE_CLOSE_MS = 900

type Row =
  | { type: 'hit'; key: string; group: string; hit: PaletteHit }
  /** next is the first newly revealed result and receives selection. */
  | { type: 'more'; key: string; group: string; hidden: number; next: string | undefined }
  /** Lifts the project scope, keeping the query. */
  | { type: 'widen'; key: string; group: string; count: number }
  /** Applies the text typed in a step. */
  | { type: 'action'; key: string; group: string; label: string; disabled: boolean }

/** A stretch of the list the Tab key jumps between: a group of results, or a row standing alone. */
type Block =
  | { type: 'group'; key: string; group: PaletteGroup; rows: Row[] }
  | { type: 'single'; key: string; rows: [Row] }

const NOTHING: ScopedPalette = { groups: [], elsewhere: 0, fallback: false }
const NO_USAGE: ReadonlyMap<string, number> = new Map()

function layout(groups: readonly PaletteGroup[], expanded: ReadonlySet<string>, scopeId: string | null): Block[] {
  return groups.map((group): Block => {
    // The scoped project is what the palette is about: it keeps a lone group's room beside the
    // others. So do the open session's commands, which nobody finds behind a fold.
    const roomy = groups.length === 1 || group.key === SESSION_GROUP || (scopeId !== null && group.projectId === scopeId)
    const limit = roomy ? SOLO_ROWS : GROUP_ROWS
    const shown = group.hits.slice(0, expanded.has(group.key) ? EXPANDED_ROWS : limit)
    const rows: Row[] = shown.map((hit) => ({ type: 'hit', key: hit.item.key, group: group.key, hit }))
    const hidden = Math.min(group.hits.length, EXPANDED_ROWS) - shown.length
    if (hidden > 0) {
      const next = group.hits[shown.length]?.item.key
      rows.push({ type: 'more', key: `more:${group.key}`, group: group.key, hidden, next })
    }
    return { type: 'group', key: group.key, group, rows }
  })
}

/**
 * Search palette with one input and every destination. Opened inside a project it searches that
 * project, shown as a token before the input; without the token it groups all types by project and
 * puts unowned items under General. Project names restrict queries, kind names list that kind, and
 * a leading `>`, `#` or `/` keeps commands, tickets or files. The open session's commands have
 * their own group, and the typed text can start a session or a ticket. In-memory UI data responds
 * instantly; only files and message content query the server.
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
  const queryClient = useQueryClient()
  const listId = useId()
  const list = useRef<HTMLDivElement>(null)
  /** Selected file to focus on close instead of the trigger. */
  const chosenFile = useRef<{ scope: string; path: string } | null>(null)
  const [query, setQuery] = useState('')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [scope, setScope] = useState<string | null>(null)
  /** Project the shortcut returns to once the token is removed. */
  const [home, setHome] = useState<string | null>(null)
  const [wasOpen, setWasOpen] = useState(false)
  /** Question asked in place of the search: a list to pick from or a value to type. */
  const [step, setStep] = useState<PaletteStep | null>(null)
  const [notice, setNotice] = useState<PaletteNotice | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const openPanelFile = useOpenPanelFile()

  const conversationRoute = useMatch('/p/:projectId/c/:conversationId')
  const discussionRoute = useMatch('/discussions/:conversationId')
  const concentration = useConcentration()
  const radioPlaying = useRadio() !== 'off'
  const radioName = useRadioStation().data?.title ?? ''
  const soundsOn = useSoundPrefs().enabled
  const canConcentrate = Boolean(conversationRoute || discussionRoute)
  const boardRoute = useMatch('/p/:projectId/board')
  const projectRoute = useMatch('/p/:projectId/*')
  const currentProjectId = projectRoute?.params.projectId ?? null
  const routeId = conversationRoute?.params.conversationId ?? discussionRoute?.params.conversationId
  const draft = routeId === 'new'
  const currentConversationId = draft ? null : (routeId ?? null)

  // Set while rendering rather than in an effect: the first painted frame must already be scoped,
  // or the unscoped results flash on every opening.
  if (open !== wasOpen) {
    setWasOpen(open)
    setScope(open ? currentProjectId : null)
    setHome(open ? currentProjectId : null)
  }

  const { data: user } = useCurrentUser()
  const { data: instance } = useInstance()
  const { data: projects } = useProjects()
  const { data: conversations } = useAllConversations()
  const { data: schedules } = useSchedules()
  const { data: actions } = useActions()
  const { data: decisions } = useDecisions('pending')
  const sessionCommands = useSessionCommands()
  // mutate is stable, the mutation object is not: avoid rebuilding results every render.
  const { mutate: startAction } = useRunAction()
  const { mutate: renameConversation } = useRenameConversation()
  const { mutate: archiveConversation } = useArchiveConversation()
  const { mutate: favoriteConversation } = useToggleFavorite()
  const { mutate: linkCard } = useSetConversationCard()
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

  const visibleProjects = useMemo(() => projects ?? [], [projects])
  const projectsById = useMemo(
    () => new Map(visibleProjects.map((project) => [project.id, project])),
    [visibleProjects],
  )
  // An archived or unknown project cannot hold the token: the palette would search nothing.
  const scopeProject = scope ? projectsById.get(scope) : undefined
  const scopeId = scopeProject?.id ?? null
  const homeProject = home ? projectsById.get(home) : undefined
  /** Project whose shortcuts and recent conversations lead: the token's, otherwise the open one. */
  const focusId = scopeId ?? currentProjectId
  const focusProject = focusId ? projectsById.get(focusId) : undefined
  const { mutateAsync: createCard } = useCreateCard(focusId ?? '')

  // A step owns the input: its text is an answer, never a prefixed search.
  const live = useMemo(() => (step ? { prefix: null, text: query.trim() } : parsePaletteQuery(query)), [step, query])
  // Keep typing responsive while thousands of results rerank.
  const settled = useDeferredValue(live)
  const searching = open && !step
  const files = usePaletteFiles(searching && (live.prefix === null || live.prefix === '/') ? live.text : '', currentConversationId, scopeId)
  const everywhere = useMessageSearch(searching && live.prefix === null ? live.text : '')
  // A second, scoped request: the global one spends its few results across every project.
  const inScope = useMessageSearch(searching && live.prefix === null && scopeId ? live.text : '', scopeId)
  // Habits are read once per opening: results must not reorder under the cursor after a pick.
  const usage = useMemo(() => (open ? paletteUsageBoosts() : NO_USAGE), [open])

  // Reopening starts fresh because the previous search represented an earlier intent.
  useEffect(() => {
    if (open) return
    setQuery('')
    setActiveKey(null)
    setExpanded(new Set())
    setStep(null)
    setNotice(null)
  }, [open])

  // New queries, results, scopes and steps invalidate old selection and expanded groups.
  useEffect(() => {
    setActiveKey(null)
    setExpanded(new Set())
  }, [live.text, live.prefix, scopeId, step])

  // A confirmation of something invisible, such as a copy, has nothing left to offer.
  useEffect(() => {
    if (!notice?.close) return
    const timer = setTimeout(() => onOpenChange(false), NOTICE_CLOSE_MS)
    return () => clearTimeout(timer)
  }, [notice, onOpenChange])

  const enterScope = (projectId: string, clear: boolean) => {
    setScope(projectId)
    setHome(projectId)
    setNotice(null)
    if (clear) setQuery('')
    input.current?.focus()
  }
  const leaveScope = () => {
    setScope(null)
    setNotice(null)
    input.current?.focus()
  }
  const enterStep = (next: PaletteStep) => {
    setStep(next)
    setNotice(null)
    setQuery(next.type === 'input' ? next.initial : '')
    input.current?.focus()
  }
  const leaveStep = () => {
    setStep(null)
    setQuery('')
    input.current?.focus()
  }
  // The proposed value is there to be replaced: selected, the first keystroke overwrites it.
  useEffect(() => {
    if (step?.type === 'input') input.current?.select()
  }, [step])

  const settings = useMemo(
    () => visibleSections(Boolean(user?.isAdmin), instance?.capabilities),
    [user?.isAdmin, instance?.capabilities],
  )

  const currentConversation = useMemo(
    () => (currentConversationId ? conversations?.find((entry) => entry.id === currentConversationId) : undefined),
    [conversations, currentConversationId],
  )

  // Build only when opened: conversation lists change on every live event and closed palettes have
  // no use for updates.
  const { views: savedViews } = useSessionViews()
  const wallViews = useMemo(() => savedViews.filter((view) => !shadowedBySection(view)).map((view) => ({ id: view.id, name: viewName(view, t) })), [savedViews, t])
  const sessionItems = useMemo((): PaletteItem[] => {
    if (!open) return []
    const radioTitle = t(radioPlaying ? 'radio.palette.stop' : 'radio.palette.play')
    const radio: PaletteItem = {
      key: 'command:radio', kind: 'command', projectId: null,
      title: radioTitle, icon: <Radio size={15} />,
      fields: [field(radioTitle, 'title', WEIGHT.title), field(`radio lo-fi lofi music musique ${radioName}`, 'context', WEIGHT.context, { browse: true })],
      target: { type: 'run', run: toggleRadio },
    }
    const soundsTitle = t(soundsOn ? 'sounds.palette.mute' : 'sounds.palette.unmute')
    const sounds: PaletteItem = {
      key: 'command:sounds', kind: 'command', projectId: null,
      title: soundsTitle, icon: soundsOn ? <VolumeX size={15} /> : <Volume2 size={15} />,
      fields: [field(soundsTitle, 'title', WEIGHT.title), field(t('sounds.palette.keywords'), 'context', WEIGHT.context, { browse: true })],
      target: { type: 'run', run: toggleSounds },
    }
    const focus: PaletteItem[] = canConcentrate ? [{
      key: 'command:concentration', kind: 'command', projectId: null, group: SESSION_GROUP,
      title: t(concentration ? 'concentration.exit' : 'concentration.enter'),
      icon: <Maximize2 size={15} />,
      fields: [field(t(concentration ? 'concentration.exit' : 'concentration.enter'), 'title', WEIGHT.title)],
      target: { type: 'run', run: toggleConcentration },
    }] : []
    if (!currentConversation) return [...focus, radio, sounds]
    const { id, favorite, archivedAt } = currentConversation
    return [...focus, ...buildSessionItems({
      t,
      conversation: currentConversation,
      commands: sessionCommands,
      cards: catalog?.cards ?? [],
      rename: (title) => renameConversation({ id, title }),
      toggleFavorite: () => favoriteConversation({ id, favorite: !favorite }),
      toggleArchived: () => archiveConversation({ id, archived: archivedAt === null }),
      setCard: (cardId) => linkCard({ id, cardId }),
      copyReference: async () => {
        const copied = await copyText(sessionReference(id))
        return { text: t(copied ? 'sessionRef.copied' : 'sessionRef.copyFailed'), error: !copied, close: copied }
      },
      openPanel: (tab: PanelTab) => {
        setPanelTab(tab)
        setPanelOpen(true)
      },
    }), radio, sounds]
  }, [open, canConcentrate, concentration, radioPlaying, radioName, soundsOn, t, currentConversation, sessionCommands, catalog, renameConversation, favoriteConversation, archiveConversation, linkCard])
  const items = useMemo(
    () =>
      !open ? [] : [...sessionItems, ...buildPaletteItems({
        t,
        projects: visibleProjects,
        currentProjectId: focusId,
        conversations: conversations ?? [],
        catalog,
        schedules: schedules ?? [],
        actions: actions ?? [],
        runAction,
        mcpServers: mcp?.servers ?? [],
        settings,
        theme,
        applyTheme,
        wallViews,
      })],
    [open, sessionItems, t, visibleProjects, focusId, conversations, catalog, schedules, actions, runAction, mcp, settings, theme, applyTheme, wallViews],
  )
  const fileItems = useMemo(
    () => buildFileItems(t, files.data, visibleProjects),
    [t, files.data, visibleProjects],
  )
  const messageItems = useMemo(
    // Scoped excerpts first: the builder keeps one per conversation, and these are the ones wanted.
    () => buildMessageItems(t, [...(scopeId ? (inScope.data ?? []) : []), ...(everywhere.data ?? [])], visibleProjects, conversations ?? []),
    [t, scopeId, inScope.data, everywhere.data, visibleProjects, conversations],
  )
  const stepItems = useMemo(() => (step?.type === 'pick' ? step.items() : []), [step])

  /**
   * What waits on the user, read when the palette opens rather than followed live: the list is on
   * screen for seconds, and each row still shows its session's live state.
   */
  const attention = useMemo((): PaletteItem[] => {
    if (!open || settled.text || settled.prefix || step) return []
    const visible = (projectId: string | null) =>
      scopeId ? projectId === scopeId : projectId === null || projectsById.has(projectId)
    const sessions = (conversations ?? []).flatMap((entry): string[] => {
      if (entry.id === currentConversationId || entry.scheduleId || entry.benchmarkId || !visible(entry.projectId)) return []
      const status = liveStatus(entry.id) ?? entry.status
      // A failure already read is history; one not yet seen is news.
      const failed = status === 'error' && entry.archivedAt === null && isUnread(entry, liveSeq(entry.id))
      return status === 'awaiting_input' || failed ? [entry.id] : []
    })
    const byKey = new Map(items.map((item) => [item.key, item]))
    return buildAttentionItems(
      t,
      byKey,
      { decisions: (decisions ?? []).filter((decision) => visible(decision.projectId)), sessions },
      openDecision,
    ).slice(0, ATTENTION_ROWS)
  }, [open, settled, step, scopeId, projectsById, conversations, currentConversationId, items, decisions, t])

  const createItems = useMemo((): PaletteItem[] => {
    if (!open || step || settled.prefix || settled.text.length < CREATE_MIN_QUERY || !focusProject) return []
    const text = settled.text
    const projectId = focusProject.id
    return buildCreateItems(t, text, focusProject, {
      session: () => {
        const key = `new:${projectId}`
        saveDraft(key, { text, attachments: [], mentions: [], skills: [] })
        // An open draft of this project already read its saved text: hand it the new one directly.
        if (draft && currentProjectId === projectId) prefillComposer(text)
        else navigate(`/p/${projectId}/c/new`)
      },
      card: async () => {
        const card = await createCard({ title: text })
        void queryClient.invalidateQueries({ queryKey: ['palette', 'catalog'] })
        const title = `#${card.number} ${card.title}`
        return {
          text: t('search.create.card.done'),
          item: {
            key: `card:${card.id}`,
            kind: 'card',
            projectId,
            title,
            icon: <Ticket size={15} />,
            aside: t('search.create.card.open'),
            fields: [],
            target: { type: 'navigate', to: `/p/${projectId}/board?carte=${card.number}` },
            transient: true,
          },
        }
      },
    })
  }, [open, step, settled, focusProject, t, draft, currentProjectId, navigate, createCard, queryClient])

  const view = useMemo((): ScopedPalette => {
    if (!open || step?.type === 'input') return NOTHING
    const context = {
      currentProjectId: focusId,
      projectOrder: visibleProjects.map((project) => project.id),
      usage,
    }
    if (step) {
      const groups = settled.text ? rankPalette(stepItems, settled.text, context) : browsePalette(stepItems, context)
      return { groups, elsewhere: 0, fallback: false }
    }
    if (!settled.text && !settled.prefix) {
      const byKey = new Map(items.map((item) => [item.key, item]))
      const recent = recentPalette(conversations ?? [], byKey, {
        currentProjectId: focusId,
        currentConversationId,
        visibleProjects: new Set(visibleProjects.map((project) => project.id)),
        scoped: scopeId !== null,
        attention,
      })
      // Shortcut then Enter toggles concentration: the gesture depends on this row staying first.
      const command = byKey.get('command:concentration')
      if (command) recent.unshift({ key: SESSION_GROUP, projectId: null, score: 0, hits: [{ item: command, score: 0, title: [], detail: [] }] })
      return { groups: recent, elsewhere: 0, fallback: false }
    }
    // Server replies may lag a keystroke; rerank against current input so stale nonmatches never appear.
    const all = [
      ...items,
      ...(settled.text.length >= PALETTE_FILES_MIN_QUERY ? fileItems : []),
      ...(settled.text.length >= SEARCH_MIN_QUERY ? messageItems : []),
    ]
    const kinds = settled.prefix ? prefixKinds(settled.prefix) : null
    const searchable = kinds ? all.filter((item) => kinds.has(item.kind)) : all
    const ranked = settled.text ? rankPalette(searchable, settled.text, context) : browsePalette(searchable, context)
    const scoped = scopeId ? scopePalette(ranked, scopeId) : { groups: ranked, elsewhere: 0, fallback: false }
    return createItems.length > 0
      ? { ...scoped, groups: [...scoped.groups, { key: CREATE_GROUP, projectId: null, score: 0, hits: createItems.map((item) => ({ item, score: 0, title: [], detail: [] })) }] }
      : scoped
  }, [open, step, stepItems, settled, items, fileItems, messageItems, conversations, focusId, scopeId, currentConversationId, visibleProjects, usage, attention, createItems])

  const blocks = useMemo((): Block[] => {
    if (step?.type === 'input') {
      const text = live.text
      return [{
        type: 'single',
        key: 'submit',
        rows: [{ type: 'action', key: 'submit', group: 'submit', label: step.action(text), disabled: !text || text === step.initial.trim() }],
      }]
    }
    const listed = layout(view.groups, expanded, view.fallback ? null : scopeId)
    if (notice?.item) {
      const item = notice.item
      listed.unshift({ type: 'single', key: 'notice', rows: [{ type: 'hit', key: item.key, group: 'notice', hit: { item, score: 0, title: [], detail: [] } }] })
    }
    // After the results and before the creations: a search that found nothing useful is one Enter
    // away from the other projects, and starting something new stays the last resort.
    if (view.elsewhere > 0) {
      const widen: Block = { type: 'single', key: 'widen', rows: [{ type: 'widen', key: 'widen', group: 'widen', count: view.elsewhere }] }
      const create = listed.findIndex((block) => block.key === CREATE_GROUP)
      listed.splice(create === -1 ? listed.length : create, 0, widen)
    }
    return listed
  }, [step, live.text, view, expanded, scopeId, notice])
  const rows = useMemo(() => blocks.flatMap((block): Row[] => block.rows), [blocks])
  const activeIndex = Math.max(0, rows.findIndex((row) => row.key === activeKey))
  const active = rows[activeIndex]
  /** Project the selected row would put in the token. */
  const scopeTarget =
    !step && active?.type === 'hit' && active.hit.item.kind === 'project' && active.hit.item.projectId !== scopeId
      ? active.hit.item.projectId
      : null
  /** The selected result has an address, so it can open beside the current view. */
  const canOpenAside = active?.type === 'hit' && active.hit.item.target.type === 'navigate'

  // Keep keyboard selection visible when it leaves the viewport.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active?.key])

  /**
   * Open files where searched: the open conversation and worktree for its project, otherwise the
   * project panel on its usual landing page to preserve that preference.
   */
  const openFile = (projectId: string, path: string) => {
    let scopeKey: string
    if (projectId === currentProjectId && currentConversationId) {
      scopeKey = currentConversationId
    } else {
      scopeKey = projectScope(projectId)
      const hasPanel = projectId === currentProjectId && (draft || boardRoute !== null)
      if (!hasPanel) navigate(projectViewPath(projectId, projectViewOf(projectId)))
    }
    openPanelFile(scopeKey, path)
    chosenFile.current = { scope: scopeKey, path }
  }

  const run = (item: PaletteItem, aside: boolean) => {
    const { target } = item
    if (!item.transient && item.kind !== 'message') recordPaletteUse(item.key)
    if (target.type === 'step') {
      enterStep(target.step)
      return
    }
    if (target.type === 'stay') {
      void target.run().then(
        (outcome) => {
          setNotice(outcome)
          setQuery('')
          input.current?.focus()
        },
        (error: unknown) => setNotice({ text: error instanceof Error ? error.message : t('search.action.failed'), error: true }),
      )
      return
    }
    onOpenChange(false)
    if (target.type === 'navigate') {
      // The app's own address: a new tab in a browser, a new window in the desktop app.
      if (aside) window.open(target.to, '_blank')
      else navigate(target.to)
    } else if (target.type === 'run') target.run()
    else openFile(target.projectId, target.path)
  }

  const choose = (row: Row | undefined, aside = false) => {
    if (!row) return
    if (row.type === 'hit') {
      run(row.hit.item, aside)
    } else if (row.type === 'widen') {
      leaveScope()
    } else if (row.type === 'action') {
      if (row.disabled || step?.type !== 'input') return
      onOpenChange(false)
      step.submit(live.text)
    } else {
      // Expansion retains keyboard control and selects the first revealed result where attention goes.
      setExpanded((current) => new Set([...current, row.group]))
      setActiveKey(row.next ?? null)
    }
  }

  const jumpBlock = (direction: 1 | -1) => {
    if (blocks.length < 2 || !active) return
    const current = blocks.findIndex((block) => block.rows.some((row) => row.key === active.key))
    const next = blocks[(current + direction + blocks.length) % blocks.length]
    setActiveKey(next?.rows[0]?.key ?? null)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActiveKey(rows[(activeIndex + delta + rows.length) % rows.length]?.key ?? null)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(active, event.metaKey || event.ctrlKey)
    } else if (event.key === 'Tab' && !event.shiftKey && scopeTarget) {
      // The typed text named the project: it has done its job once the token holds it.
      event.preventDefault()
      enterScope(scopeTarget, true)
    } else if (event.key === 'Tab' && blocks.length > 1) {
      // Move between projects without traversing every row.
      event.preventDefault()
      jumpBlock(event.shiftKey ? -1 : 1)
    } else if (
      event.key === 'Backspace' &&
      (step || scopeId) &&
      // A held key that just emptied the query must not carry on into the token.
      !event.repeat &&
      event.currentTarget.selectionStart === 0 &&
      event.currentTarget.selectionEnd === 0
    ) {
      event.preventDefault()
      if (step) leaveStep()
      else leaveScope()
    }
  }

  /**
   * Pressing the shortcut again switches between the project and everywhere without losing the
   * query. Outside a project there is nothing to switch, so the event reaches the shell, which
   * closes the palette as before.
   */
  const onShortcut = (event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
    if (!step && !scopeId && !homeProject) return
    event.preventDefault()
    event.stopPropagation()
    // Inside a step the shortcut has no scope to switch, and closing would lose the answer.
    if (step) return
    if (scopeId) leaveScope()
    else if (homeProject) enterScope(homeProject.id, false)
  }

  // Server results are pending, either debounce or an in-flight request.
  const fetching =
    searching &&
    (files.settling ||
      everywhere.settling ||
      (live.text.length >= PALETTE_FILES_MIN_QUERY && files.isFetching) ||
      (live.text.length >= SEARCH_MIN_QUERY && live.prefix === null && (everywhere.isFetching || inScope.isFetching)))
  const pending = live !== settled || fetching
  const typed = live.text !== '' || live.prefix !== null
  const placeholder = step
    ? step.placeholder
    : scopeProject
      ? t('search.placeholder.scoped', { name: scopeProject.name })
      : t('search.placeholder')

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={onShortcut}
          onEscapeKeyDown={(event) => {
            // Escape answers the question in front: leave the step first, the palette next.
            if (!step) return
            event.preventDefault()
            leaveStep()
          }}
          onCloseAutoFocus={(event) => {
            const file = chosenFile.current
            if (!file) return
            chosenFile.current = null
            event.preventDefault()
            focusEditorFile(file.scope, file.path)
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
            {step ? (
              <StepToken title={step.title} onLeave={leaveStep} />
            ) : scopeProject ? (
              <ScopeToken project={scopeProject} onRemove={leaveScope} />
            ) : homeProject ? (
              <ScopeOffer project={homeProject} onAdd={() => enterScope(homeProject.id, false)} />
            ) : null}
            <input
              ref={input}
              autoFocus
              role="combobox"
              aria-label={step ? step.title : t('search.dialog.label')}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={rows.length ? `${listId}-${activeIndex}` : undefined}
              value={query}
              maxLength={200}
              onChange={(event) => {
                setQuery(event.target.value)
                // The outcome of the previous action belongs to the previous text.
                setNotice(null)
              }}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              className="h-12 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            />
            {pending && typed ? <Loader size={15} className="shrink-0 animate-spin text-ink-faint" /> : null}

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
            {notice ? <NoticeLine text={notice.text} error={notice.error} /> : null}
            {view.fallback && scopeProject ? (
              <p role="status" className="px-2.5 pt-3 text-xs text-ink-faint">
                {t('search.fallback', { name: scopeProject.name })}
              </p>
            ) : null}
            {blocks.map((block, position) => {
              if (block.type === 'single') {
                const [row] = block.rows
                const index = rows.indexOf(row)
                const selected = row.key === active?.key
                if (row.type === 'widen') {
                  return (
                    <WidenRow
                      key={block.key}
                      id={`${listId}-${index}`}
                      count={row.count}
                      // Alone, it is the answer to the query rather than an afterthought below results.
                      separated={position > 0}
                      selected={selected}
                      onHover={() => setActiveKey(row.key)}
                      onSelect={() => choose(row)}
                    />
                  )
                }
                if (row.type === 'action') {
                  return (
                    <ActionRow
                      key={block.key}
                      id={`${listId}-${index}`}
                      label={row.label}
                      disabled={row.disabled}
                      selected={selected}
                      onSelect={() => choose(row)}
                    />
                  )
                }
                return row.type === 'hit' ? (
                  <HitRow
                    key={block.key}
                    id={`${listId}-${index}`}
                    hit={row.hit}
                    selected={selected}
                    onHover={() => setActiveKey(row.key)}
                    onSelect={(aside) => choose(row, aside)}
                  />
                ) : null
              }

              const { group } = block
              const project = group.projectId ? projectsById.get(group.projectId) : undefined
              // The token already names the scoped project or the step: a heading above its results
              // would repeat it. Below another group it stays, or these rows would read as part of
              // that group.
              const headless =
                position === 0 &&
                !view.fallback &&
                (step !== null || (project !== undefined && project.id === scopeId))
              return (
                <div
                  key={block.key}
                  role="group"
                  {...(headless
                    ? { 'aria-label': step ? step.title : project?.name }
                    : { 'aria-labelledby': `${listId}-g-${group.key}` })}
                  className={headless ? 'pt-1.5' : undefined}
                >
                  {headless ? null : (
                    <GroupHeader
                      id={`${listId}-g-${group.key}`}
                      group={group.key}
                      project={project}
                      current={group.projectId !== null && group.projectId === currentProjectId}
                      onScope={project ? () => enterScope(project.id, false) : undefined}
                    />
                  )}
                  {block.rows.map((row) =>
                    row.type === 'hit' ? (
                      <HitRow
                        key={row.key}
                        // Use an index rather than a file key containing paths whose spaces are invalid in identifiers.
                        id={`${listId}-${rows.indexOf(row)}`}
                        hit={row.hit}
                        selected={row.key === active?.key}
                        onHover={() => setActiveKey(row.key)}
                        onSelect={(aside) => choose(row, aside)}
                      />
                    ) : row.type === 'more' ? (
                      <MoreRow
                        key={row.key}
                        id={`${listId}-${rows.indexOf(row)}`}
                        hidden={row.hidden}
                        selected={row.key === active?.key}
                        onHover={() => setActiveKey(row.key)}
                        onSelect={() => choose(row)}
                      />
                    ) : null,
                  )}
                </div>
              )
            })}

            {rows.length === 0 && !pending ? (
              <p role="status" className="px-2.5 py-8 text-center text-sm text-ink-faint">
                {step
                  ? t('search.empty.none')
                  : !typed
                    ? t('search.empty.start')
                    : live.prefix === '/' && live.text.length < PALETTE_FILES_MIN_QUERY
                      ? t('search.empty.file')
                      : live.prefix === null && live.text.length < SEARCH_MIN_QUERY
                        ? t('search.empty.moreChars', { count: SEARCH_MIN_QUERY - live.text.length })
                        : t('search.empty.none')}
              </p>
            ) : null}
            {files.isError && searching && live.text.length >= PALETTE_FILES_MIN_QUERY ? (
              <p role="alert" className="px-2.5 py-2 text-xs text-critical">{t('search.files.error')}</p>
            ) : null}
            {/* The prefixes are invisible until taught; the quiet moment before typing is where to say them. */}
            {!typed && !step && rows.length > 0 ? (
              <p className="hidden px-2.5 pt-3 pb-1 text-[0.6875rem] text-ink-faint sm:block pointer-coarse:hidden">
                {t('search.prefixes')}
              </p>
            ) : null}
          </div>

          {/* Shortcuts matter only with keyboards; omit meaningless touch hints. */}
          <div className="hidden shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3 py-2 text-[0.6875rem] text-ink-faint sm:flex pointer-coarse:hidden">
            <Hint keys="↑ ↓" label={t('search.hint.navigate')} />
            <Hint
              keys="↵"
              label={
                step?.type === 'input'
                  ? t('search.hint.confirm')
                  : active?.type === 'hit' && active.hit.item.target.type === 'step'
                    ? t('search.hint.continue')
                    : t('search.hint.open')
              }
            />
            {canOpenAside ? (
              <Hint keys={`${PALETTE_MODIFIER} ↵`} label={t(instance?.profile === 'desktop' ? 'search.hint.window' : 'search.hint.tab')} />
            ) : null}
            {scopeTarget ? (
              <Hint keys="⇥" label={t('search.hint.scope')} />
            ) : blocks.length > 1 ? (
              <Hint keys="⇥" label={t('search.hint.group')} />
            ) : null}
            {step ? (
              <Hint keys="esc" label={t('search.hint.back')} />
            ) : (
              <>
                {scopeProject ? (
                  <Hint keys={PALETTE_SHORTCUT} label={t('search.hint.everywhere')} />
                ) : homeProject ? (
                  <Hint keys={PALETTE_SHORTCUT} label={t('search.hint.inProject', { name: homeProject.name })} />
                ) : null}
                <Hint keys="esc" label={t('search.hint.close')} />
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
