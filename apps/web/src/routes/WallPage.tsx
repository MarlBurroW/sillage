import { evaluateSessionQuery, MAX_SESSION_VIEWS, type SessionFacts, type SessionView } from '@sillage/protocol'
import { Activity, LayoutGrid, MoreHorizontal, Pencil, Plus, RotateCcw, Save, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { Button, ConfirmDialog, cx, EmptyState, Field, IconButton, Menu, MenuItem } from '../components/ui'
import { TooltipProvider } from '../components/ui/Tooltip'
import { describeQuery } from '../components/wall/describe-query'
import { NewViewDialog } from '../components/wall/NewViewDialog'
import { QueryField } from '../components/wall/QueryField'
import { WallFilters } from '../components/wall/WallFilters'
import { WallTile } from '../components/wall/WallTile'
import { activitySectionIds, activitySectionOf, ACTIVITY_SECTIONS, useFollowedActivity, type ActivitySection } from '../lib/activity'
import { useTranslate, type MessageKey } from '../lib/i18n'
import { MAX_WALL_TILES, useNow, useWallSources } from '../lib/session-wall'
import { placeTiles, wallLayout, type WallLayoutMode, type WallPlacement } from '../lib/wall-layout'
import '../styles/wall.css'
import { newViewId, shadowedBySection, useDismissed, useSaveSessionViews, useSessionViews, viewName } from '../lib/session-views'

const LAYOUTS: WallLayoutMode[] = ['auto', '2', '3', '4']
const GAP = 12
const SECTION_LAYOUT_KEY = 'sillage.wall.sectionLayout'

/** The live wall first, then Activity's lists in their order. */
const SECTION_TABS: readonly (ActivitySection | null)[] = [null, ...ACTIVITY_SECTIONS]
const SECTION_LABELS: Record<ActivitySection | 'live', MessageKey> = {
  live: 'wall.section.live',
  awaiting: 'shell.activity.awaiting',
  running: 'shell.activity.running',
  unread: 'shell.activity.unread',
  favorites: 'shell.favorites.heading',
}
/** What a section asks, as a query: where a new view starts from. */
const SECTION_QUERIES: Record<ActivitySection | 'live', string> = {
  live: 'is:attention,running',
  awaiting: 'is:attention',
  running: 'is:running',
  unread: 'is:unread',
  favorites: 'is:favorite',
}

/**
 * Activity's page: the sessions of its list, working side by side. The list's sections choose the
 * tiles, so nothing has to be typed. Saved views are the advanced way in: a GitHub-style query
 * whose text is the only source of truth, rewritten by the filter buttons.
 */
export function WallPage() {
  const t = useTranslate()
  const [params, setParams] = useSearchParams()
  const { views } = useSessionViews()
  const { mutate: saveViews } = useSaveSessionViews()
  const view = views.find((entry) => entry.id === params.get('view')) ?? null
  const section = view ? null : activitySectionOf(params)
  // Built-in views a section already answers are not offered twice; a link to one still opens it.
  const tabViews = views.filter((entry) => entry.id === view?.id || !shadowedBySection(entry))
  const urlQuery = params.get('q') ?? view?.query ?? ''
  // The field keeps its own state: the URL updates asynchronously, and a controlled input fed by it
  // would drop keystrokes. The URL follows, and wins when changed elsewhere (tabs, palette, back).
  const [query, setQueryState] = useState(urlQuery)
  const [lastUrl, setLastUrl] = useState(urlQuery)
  const written = useRef(urlQuery)
  // Adopted during render, not in an effect: a view switch must not show one frame of the
  // previous view's tiles.
  if (urlQuery !== lastUrl) {
    setLastUrl(urlQuery)
    if (urlQuery !== written.current) setQueryState(urlQuery)
  }
  // After the commit, never during render: a navigation renders in a transition that an urgent
  // update can discard, and a ref moved by the discarded pass would make the retry skip adopting.
  useEffect(() => { written.current = query }, [query])
  const modified = view !== null && query !== view.query

  const setQuery = useCallback((next: string) => {
    setQueryState(next)
    written.current = next
    setParams((current) => {
      const updated = new URLSearchParams(current)
      if (view && next === view.query) updated.delete('q')
      else updated.set('q', next)
      return updated
    }, { replace: true })
  }, [setParams, view])
  const openView = (id: string) => setParams({ view: id }, { replace: true })
  const openSection = (next: ActivitySection | null) => setParams(next ? { show: next } : {}, { replace: true })
  const updateView = useCallback((id: string, patch: Partial<SessionView>) => {
    saveViews(views.map((entry) => entry.id === id ? { ...entry, ...patch } : entry))
  }, [saveViews, views])

  const now = useNow()
  const { facts: rawFacts, conversations, projects, trees, loading } = useWallSources(now)
  const projectList = useMemo(() => [...projects.values()], [projects])
  const followed = useFollowedActivity(undefined)
  const decisionByConversation = useMemo(() => new Map(followed.decisions.map((decision) => [decision.conversationId, decision])), [followed.decisions])
  // A pending decision waits on the user like a permission does.
  const facts = useMemo(() => rawFacts.map((fact): SessionFacts => decisionByConversation.has(fact.id) && fact.state !== 'attention' ? { ...fact, state: 'attention' } : fact), [rawFacts, decisionByConversation])
  const factsById = useMemo(() => new Map(facts.map((fact) => [fact.id, fact])), [facts])
  const sectionIds = (key: ActivitySection | null) => activitySectionIds(followed, key).filter((id) => factsById.has(id))
  const result = useMemo(() => {
    if (view) return evaluateSessionQuery(query, facts, now)
    // A section shows exactly the rows of the list beside it, in their order.
    const ids = activitySectionIds(followed, section).filter((id) => factsById.has(id))
    return { ids, total: ids.length, tokens: [] }
  }, [view, query, facts, now, followed, section, factsById])

  // The tile brought forward lives in the address: the list beside the wall sets it and marks its row.
  const focusedId = params.get('tile')
  const focusedRef = useRef(focusedId)
  focusedRef.current = focusedId
  // Through a ref: the router's setter changes with the address, and tiles are memoized on this callback.
  const setParamsRef = useRef(setParams)
  setParamsRef.current = setParams
  const setFocusedId = useCallback((id: string | null) => {
    if (focusedRef.current === id) return
    focusedRef.current = id
    setParamsRef.current((current) => {
      const updated = new URLSearchParams(current)
      if (id) updated.set('tile', id)
      else updated.delete('tile')
      return updated
    }, { replace: true })
  }, [])

  const scope = view?.id ?? `activity:${section ?? 'live'}`
  const { dismissed, dismiss } = useDismissed(scope)
  const pinned = useMemo(() => view?.pinned.filter((id) => factsById.has(id)) ?? [], [view, factsById])
  // A removal lapses once the session does something new, and never hides the tile asked for.
  const isDismissed = useCallback((id: string) => {
    const at = dismissed[id]
    return id !== focusedId && at !== undefined && (factsById.get(id)?.activityAt ?? 0) <= at
  }, [dismissed, factsById, focusedId])
  const wanted = useMemo(() => {
    // Past the tile limit, the one asked for still gets a place.
    const asked = focusedId && result.ids.includes(focusedId) ? [focusedId] : []
    return [...new Set([...pinned, ...asked, ...result.ids])].filter((id) => !isDismissed(id)).slice(0, MAX_WALL_TILES)
  }, [pinned, result.ids, isDismissed, focusedId])

  const placement = useRef<WallPlacement | null>(null)
  placement.current = placeTiles(placement.current, `${scope}\n${view ? query : ''}`, wanted,
    (id) => !isDismissed(id) && (factsById.get(id)?.unread === true || id === focusedId))
  const { ids: placed, away } = placement.current
  const awaySet = new Set(away)
  const focusedPlaced = focusedId !== null && placed.includes(focusedId)
  useEffect(() => { if (focusedId && !focusedPlaced && !loading) setFocusedId(null) }, [focusedId, focusedPlaced, loading, setFocusedId])
  // A tile chosen from the list may sit below the fold.
  useEffect(() => {
    if (focusedId && focusedPlaced) document.querySelector(`.wall-tile[data-conversation-id="${CSS.escape(focusedId)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focusedId, focusedPlaced])

  // Sections have no stored view to keep a layout in: the choice stays on this device.
  const [sectionLayout, setSectionLayoutState] = useState<WallLayoutMode>(() => {
    const stored = localStorage.getItem(SECTION_LAYOUT_KEY)
    return LAYOUTS.find((mode) => mode === stored) ?? 'auto'
  })
  const layoutMode = view ? (view.layout ?? 'auto') as WallLayoutMode : sectionLayout

  // Grid sized from the space it actually has.
  const wall = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 1200, height: 800 })
  useLayoutEffect(() => {
    const node = wall.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => { if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height }) })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const layout = wallLayout(placed.length, size.width, size.height, layoutMode, GAP)

  const queryInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('input,textarea,select,[contenteditable="true"],[role="dialog"],[role="menu"]')) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === '/') { event.preventDefault(); queryInput.current?.focus() }
      else if (/^[1-9]$/.test(event.key) && placed[Number(event.key) - 1]) {
        // The tile's composer takes focus right away: the digit must not land in it.
        event.preventDefault()
        const id = placed[Number(event.key) - 1]!
        setFocusedId(id)
        document.querySelector<HTMLElement>(`.wall-tile[data-conversation-id="${id}"]`)?.focus()
      } else if (event.key === 'Escape') setFocusedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [placed, setFocusedId])

  const leaveTile = useCallback(() => setFocusedId(null), [setFocusedId])
  const togglePin = useCallback((id: string) => {
    if (!view) return
    updateView(view.id, { pinned: view.pinned.includes(id) ? view.pinned.filter((entry) => entry !== id) : [...view.pinned, id].slice(-32) })
  }, [view, updateView])
  const dismissTile = useCallback((id: string) => {
    if (view?.pinned.includes(id)) updateView(view.id, { pinned: view.pinned.filter((entry) => entry !== id) })
    dismiss(id, factsById.get(id)?.activityAt ?? Date.now())
    if (focusedRef.current === id) setFocusedId(null)
  }, [view, updateView, dismiss, factsById, setFocusedId])
  const setLayout = (mode: WallLayoutMode) => {
    if (view) return updateView(view.id, { layout: mode })
    localStorage.setItem(SECTION_LAYOUT_KEY, mode)
    setSectionLayoutState(mode)
  }

  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<SessionView | null>(null)
  const [deleting, setDeleting] = useState<SessionView | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [draftName, setDraftName] = useState('')

  const summary = view ? describeQuery(result.tokens, projectList, t) : t(section ? SECTION_LABELS[section] : 'wall.section.liveHint')
  /** What a new view starts from: the query on screen, or the one the section stands for. */
  const seedQuery = view ? query : SECTION_QUERIES[section ?? 'live']
  const capped = result.ids.length > wanted.length - pinned.length && wanted.length === MAX_WALL_TILES

  return (
    <TooltipProvider delayDuration={150}>
    <div className="wall-page">
      <header className="wall-head">
        <MobileNavigationButton />
        <h1 className="wall-title"><Activity size={16} className="text-accent" />{t('shell.overview.heading')}</h1>
        <nav className="wall-tabs" role="tablist" aria-label={t('wall.views.label')}>
          {SECTION_TABS.map((key) => {
            const ids = key === section && !view ? result.ids : sectionIds(key)
            // Waiting sessions colour the count wherever they show, as on saved views.
            const attention = (key === null || key === 'awaiting') && ids.some((id) => factsById.get(id)?.state === 'attention')
            return (
              <button key={key ?? 'live'} type="button" role="tab" aria-selected={!view && key === section} className="wall-tab" data-wall-section={key ?? 'live'} onClick={() => openSection(key)}>
                <span className="truncate">{t(SECTION_LABELS[key ?? 'live'])}</span>
                <span className={cx('wall-tab-count', attention && 'wall-tab-count-attention')} title={attention ? t('wall.views.attention') : undefined}>{ids.length}</span>
              </button>
            )
          })}
          {tabViews.length > 0 ? <span className="wall-tabs-rule" aria-hidden /> : null}
          {tabViews.map((entry) => {
            const ids = entry.id === view?.id ? result.ids : evaluateSessionQuery(entry.query, facts, now).ids
            const count = ids.length
            const attention = ids.some((id) => factsById.get(id)?.state === 'attention')
            return (
              <button key={entry.id} type="button" role="tab" aria-selected={entry.id === view?.id} className="wall-tab" data-wall-view={entry.id} onClick={() => openView(entry.id)}>
                <span className="truncate">{viewName(entry, t)}</span>
                {entry.id === view?.id && modified ? <span className="wall-tab-modified" title={t('wall.views.modified')} /> : null}
                <span className={cx('wall-tab-count', attention && 'wall-tab-count-attention')} title={attention ? t('wall.views.attention') : undefined}>{count}</span>
              </button>
            )
          })}
        </nav>
        <IconButton size="sm" label={t(view ? 'wall.views.new' : 'wall.views.newTitle')} disabled={views.length >= MAX_SESSION_VIEWS} onClick={() => setCreating(true)}><Plus size={16} /></IconButton>
        {view ? (
          <Menu trigger={<IconButton size="sm" label={t('wall.views.actions', { name: viewName(view, t) })}><MoreHorizontal size={16} /></IconButton>}>
            <MenuItem icon={<Pencil size={14} />} onSelect={() => { setDraftName(viewName(view, t)); setRenaming(view) }}>{t('wall.views.rename')}</MenuItem>
            <MenuItem icon={<Trash2 size={14} />} onSelect={() => setDeleting(view)}>{t('wall.views.delete')}</MenuItem>
          </Menu>
        ) : null}
      </header>

      {/* Queries are the advanced way in: a section needs none, a saved view shows its own. */}
      {view ? <section className="wall-controls">
        <div className="wall-query-row">
          <QueryField ref={queryInput} value={query} onChange={setQuery} projects={projectList} onHelp={() => setHelpOpen(true)} />
          {modified ? <>
            <Button variant="ghost" size="sm" icon={<RotateCcw size={14} />} onClick={() => setQuery(view.query)}>{t('wall.views.revert')}</Button>
            <Button size="sm" icon={<Save size={14} />} onClick={() => { updateView(view.id, { query }); setParams({ view: view.id }, { replace: true }) }}>{t('wall.views.save')}</Button>
          </> : null}
        </div>
        <WallFilters query={query} onChange={setQuery} projects={projectList} />
      </section> : null}

      <div className="wall-bar">
        <span className="min-w-0 truncate">
          <b>{t(placed.length - away.length === 1 ? 'wall.bar.count.one' : 'wall.bar.count', { count: placed.length - away.length })}</b>
          {result.total > result.ids.length || capped ? ` ${t('wall.bar.of', { total: result.total })}` : ''}
          {' · '}{summary}
          {pinned.length ? ` · ${t('wall.bar.pinned', { count: pinned.length })}` : ''}
          {away.length ? <> · {t('wall.bar.away', { count: away.length })} <button type="button" className="wall-link" onClick={() => away.forEach((id) => dismissTile(id))}>{t('wall.bar.tidy')}</button></> : null}
        </span>
        {capped ? <span className="text-caution">{t('wall.bar.capped', { max: MAX_WALL_TILES })}</span> : null}
        <div className="wall-layouts" role="group" aria-label={t('wall.layout.label')}>
          {LAYOUTS.map((mode) => (
            <button key={mode} type="button" aria-pressed={layoutMode === mode} onClick={() => setLayout(mode)}>
              {mode === 'auto' ? t('wall.layout.auto') : t('wall.layout.columns', { count: mode })}
            </button>
          ))}
        </div>
      </div>

      <main ref={wall} className="wall-grid-area">
        {placed.length === 0 && !loading ? (
          view
            ? <EmptyState icon={<LayoutGrid size={20} />} title={t('wall.empty.none')} description={query ? t('wall.empty.query', { query }) : t('wall.empty.hint')} />
            : <EmptyState icon={<Activity size={20} />} title={t(section ? 'wall.empty.section' : 'wall.empty.live')} description={t(section ? 'wall.empty.hint' : 'shell.activity.quiet')} />
        ) : (
          <div className="wall-grid" style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`, gridAutoRows: `${layout.rowHeight}px`, gap: GAP }}>
            {placed.map((id, index) => {
              const conversation = conversations.get(id)
              const fact = factsById.get(id)
              if (!conversation || !fact) return null
              return (
                <WallTile key={id} conversation={conversation} facts={fact} index={index}
                  projectName={conversation.projectId ? projects.get(conversation.projectId)?.name ?? null : null}
                  tree={trees.get(id) ?? null} decision={decisionByConversation.get(id) ?? null}
                  focused={focusedId === id} away={awaySet.has(id)} pinned={view?.pinned.includes(id) ?? false}
                  onFocus={setFocusedId} onLeave={leaveTile} onPin={view ? togglePin : undefined} onDismiss={dismissTile} />
              )
            })}
          </div>
        )}
      </main>

      <NewViewDialog open={creating} onOpenChange={setCreating} seed={seedQuery} facts={facts} now={now} projects={projectList}
        onCreate={(name, created) => {
          const added: SessionView = { id: newViewId(), name, preset: null, query: created, layout: layoutMode, pinned: [] }
          saveViews([...views, added])
          setCreating(false)
          setParams({ view: added.id }, { replace: true })
        }} />

      <ConfirmDialog open={renaming !== null} onOpenChange={(open) => { if (!open) setRenaming(null) }} title={t('wall.views.renameTitle')} confirmLabel={t('wall.views.rename')}
        confirmDisabled={!draftName.trim()}
        onConfirm={() => { if (renaming) updateView(renaming.id, { name: draftName.trim() }); setRenaming(null) }}>
        <Field label={t('wall.views.name')} value={draftName} onChange={(event) => setDraftName(event.target.value)} maxLength={60} autoFocus />
      </ConfirmDialog>

      <ConfirmDialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null) }} title={t('wall.views.deleteTitle', { name: deleting ? viewName(deleting, t) : '' })}
        confirmLabel={t('wall.views.delete')} tone="critical"
        onConfirm={() => {
          if (deleting) {
            saveViews(views.filter((entry) => entry.id !== deleting.id))
            if (deleting.id === view?.id) setParams({}, { replace: true })
          }
          setDeleting(null)
        }}>
        <p>{t('wall.views.deleteHint')}</p>
      </ConfirmDialog>

      <ConfirmDialog open={helpOpen} onOpenChange={setHelpOpen} title={t('wall.help.title')} confirmLabel={t('common.close')} showCancel={false} size="wide" onConfirm={() => setHelpOpen(false)}>
        <p>{t('wall.help.intro')}</p>
        <table className="wall-help">
          <tbody>
            {HELP_ROWS.map(([example, key]) => <tr key={example}><td><code>{example}</code></td><td>{t(key)}</td></tr>)}
          </tbody>
        </table>
        <p className="text-xs text-ink-faint">{t('wall.help.keyboard')}</p>
      </ConfirmDialog>
    </div>
    </TooltipProvider>
  )
}

const HELP_ROWS = [
  ['is:running', 'wall.help.running'],
  ['is:attention', 'wall.help.attention'],
  ['is:error', 'wall.help.error'],
  ['is:unread', 'wall.help.unread'],
  ['project:sillage,bardak', 'wall.help.project'],
  ['cli:claude', 'wall.help.cli'],
  ['worktree:dirty', 'wall.help.worktree'],
  ['active:30m', 'wall.help.active'],
  ['limit:6', 'wall.help.limit'],
  ['sort:activity', 'wall.help.sort'],
  ['-cli:codex', 'wall.help.negation'],
  ['"page services"', 'wall.help.text'],
] as const
