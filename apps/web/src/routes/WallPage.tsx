import { evaluateSessionQuery, MAX_SESSION_VIEWS, type SessionFacts, type SessionView } from '@sillage/protocol'
import { LayoutGrid, MoreHorizontal, Pencil, Plus, RotateCcw, Save, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { Button, ConfirmDialog, cx, EmptyState, Field, IconButton, Menu, MenuItem } from '../components/ui'
import { TooltipProvider } from '../components/ui/Tooltip'
import { describeQuery } from '../components/wall/describe-query'
import { QueryField } from '../components/wall/QueryField'
import { WallFilters } from '../components/wall/WallFilters'
import { WallTile } from '../components/wall/WallTile'
import { useDecisions } from '../lib/decisions'
import { useTranslate } from '../lib/i18n'
import { MAX_WALL_TILES, useNow, useWallSources } from '../lib/session-wall'
import { placeTiles, wallLayout, type WallLayoutMode, type WallPlacement } from '../lib/wall-layout'
import '../styles/wall.css'
import { newViewId, useDismissed, useSaveSessionViews, useSessionViews, viewName } from '../lib/session-views'

const LAYOUTS: WallLayoutMode[] = ['auto', '2', '3', '4']
const GAP = 12

/**
 * Session wall: several sessions working side by side, chosen by a GitHub-style query. The query
 * text is the only source of truth; filter buttons and saved views rewrite it.
 */
export function WallPage() {
  const t = useTranslate()
  const [params, setParams] = useSearchParams()
  const { views } = useSessionViews()
  const { mutate: saveViews } = useSaveSessionViews()
  const view = views.find((entry) => entry.id === params.get('view')) ?? views[0] ?? null
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
    if (urlQuery !== written.current) {
      written.current = urlQuery
      setQueryState(urlQuery)
    }
  }
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
  const updateView = useCallback((id: string, patch: Partial<SessionView>) => {
    saveViews(views.map((entry) => entry.id === id ? { ...entry, ...patch } : entry))
  }, [saveViews, views])

  const now = useNow()
  const { facts: rawFacts, conversations, projects, trees, loading } = useWallSources(now)
  const projectList = useMemo(() => [...projects.values()], [projects])
  const { data: decisions } = useDecisions('pending')
  const decisionByConversation = useMemo(() => new Map((decisions ?? []).map((decision) => [decision.conversationId, decision])), [decisions])
  // A pending decision waits on the user like a permission does.
  const facts = useMemo(() => rawFacts.map((fact): SessionFacts => decisionByConversation.has(fact.id) && fact.state !== 'attention' ? { ...fact, state: 'attention' } : fact), [rawFacts, decisionByConversation])
  const factsById = useMemo(() => new Map(facts.map((fact) => [fact.id, fact])), [facts])
  const result = useMemo(() => evaluateSessionQuery(query, facts, now), [query, facts, now])

  const { dismissed, dismiss } = useDismissed(view?.id ?? '')
  const pinned = useMemo(() => view?.pinned.filter((id) => factsById.has(id)) ?? [], [view, factsById])
  // A removal lapses once the session does something new.
  const isDismissed = useCallback((id: string) => {
    const at = dismissed[id]
    return at !== undefined && (factsById.get(id)?.activityAt ?? 0) <= at
  }, [dismissed, factsById])
  const wanted = useMemo(() => [...new Set([...pinned, ...result.ids])].filter((id) => !isDismissed(id)).slice(0, MAX_WALL_TILES), [pinned, result.ids, isDismissed])

  const [focusedId, setFocusedId] = useState<string | null>(null)
  const placement = useRef<WallPlacement | null>(null)
  placement.current = placeTiles(placement.current, `${view?.id ?? ''}\n${query}`, wanted,
    (id) => !isDismissed(id) && (factsById.get(id)?.unread === true || id === focusedId))
  const { ids: placed, away } = placement.current
  const awaySet = new Set(away)
  useEffect(() => { if (focusedId && !placed.includes(focusedId)) setFocusedId(null) }, [focusedId, placed])

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
  const layout = wallLayout(placed.length, size.width, size.height, (view?.layout ?? 'auto') as WallLayoutMode, GAP)

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
        document.querySelector<HTMLElement>(`[data-conversation-id="${id}"]`)?.focus()
      } else if (event.key === 'Escape') setFocusedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [placed])

  const leaveTile = useCallback(() => setFocusedId(null), [])
  const togglePin = useCallback((id: string) => {
    if (!view) return
    updateView(view.id, { pinned: view.pinned.includes(id) ? view.pinned.filter((entry) => entry !== id) : [...view.pinned, id].slice(-32) })
  }, [view, updateView])
  const dismissTile = useCallback((id: string) => {
    if (view?.pinned.includes(id)) updateView(view.id, { pinned: view.pinned.filter((entry) => entry !== id) })
    dismiss(id, factsById.get(id)?.activityAt ?? Date.now())
    setFocusedId((current) => current === id ? null : current)
  }, [view, updateView, dismiss, factsById])

  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<SessionView | null>(null)
  const [deleting, setDeleting] = useState<SessionView | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [draftName, setDraftName] = useState('')

  const summary = describeQuery(result.tokens, projectList, t)
  const capped = result.ids.length > wanted.length - pinned.length && wanted.length === MAX_WALL_TILES

  return (
    <TooltipProvider delayDuration={150}>
    <div className="wall-page">
      <header className="wall-head">
        <MobileNavigationButton />
        <h1 className="wall-title"><LayoutGrid size={16} className="text-accent" />{t('wall.title')}</h1>
        <nav className="wall-tabs" role="tablist" aria-label={t('wall.views.label')}>
          {views.map((entry) => {
            const ids = entry.id === view?.id ? result.ids : evaluateSessionQuery(entry.query, facts, now).ids
            const count = ids.length
            const attention = ids.some((id) => factsById.get(id)?.state === 'attention')
            return (
              <button key={entry.id} type="button" role="tab" aria-selected={entry.id === view?.id} className="wall-tab" onClick={() => openView(entry.id)}>
                <span className="truncate">{viewName(entry, t)}</span>
                {entry.id === view?.id && modified ? <span className="wall-tab-modified" title={t('wall.views.modified')} /> : null}
                <span className={cx('wall-tab-count', attention && 'wall-tab-count-attention')} title={attention ? t('wall.views.attention') : undefined}>{count}</span>
              </button>
            )
          })}
        </nav>
        <IconButton size="sm" label={t('wall.views.new')} disabled={views.length >= MAX_SESSION_VIEWS} onClick={() => { setDraftName(''); setCreating(true) }}><Plus size={16} /></IconButton>
        {view ? (
          <Menu trigger={<IconButton size="sm" label={t('wall.views.actions', { name: viewName(view, t) })}><MoreHorizontal size={16} /></IconButton>}>
            <MenuItem icon={<Pencil size={14} />} onSelect={() => { setDraftName(viewName(view, t)); setRenaming(view) }}>{t('wall.views.rename')}</MenuItem>
            <MenuItem icon={<Trash2 size={14} />} onSelect={() => setDeleting(view)}>{t('wall.views.delete')}</MenuItem>
          </Menu>
        ) : null}
      </header>

      <section className="wall-controls">
        <div className="wall-query-row">
          <QueryField ref={queryInput} value={query} onChange={setQuery} projects={projectList} onHelp={() => setHelpOpen(true)} />
          {modified && view ? <>
            <Button variant="ghost" size="sm" icon={<RotateCcw size={14} />} onClick={() => setQuery(view.query)}>{t('wall.views.revert')}</Button>
            <Button size="sm" icon={<Save size={14} />} onClick={() => { updateView(view.id, { query }); setParams({ view: view.id }, { replace: true }) }}>{t('wall.views.save')}</Button>
          </> : null}
        </div>
        <WallFilters query={query} onChange={setQuery} projects={projectList} />
      </section>

      <div className="wall-bar">
        <span className="min-w-0 truncate">
          <b>{t('wall.bar.count', { count: placed.length - away.length })}</b>
          {result.total > result.ids.length || capped ? ` ${t('wall.bar.of', { total: result.total })}` : ''}
          {' · '}{summary}
          {pinned.length ? ` · ${t('wall.bar.pinned', { count: pinned.length })}` : ''}
          {away.length ? <> · {t('wall.bar.away', { count: away.length })} <button type="button" className="wall-link" onClick={() => away.forEach((id) => dismissTile(id))}>{t('wall.bar.tidy')}</button></> : null}
        </span>
        {capped ? <span className="text-caution">{t('wall.bar.capped', { max: MAX_WALL_TILES })}</span> : null}
        {view ? (
          <div className="wall-layouts" role="group" aria-label={t('wall.layout.label')}>
            {LAYOUTS.map((mode) => (
              <button key={mode} type="button" aria-pressed={(view.layout ?? 'auto') === mode} onClick={() => updateView(view.id, { layout: mode })}>
                {mode === 'auto' ? t('wall.layout.auto') : t('wall.layout.columns', { count: mode })}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <main ref={wall} className="wall-grid-area">
        {!view ? (
          <EmptyState icon={<LayoutGrid size={20} />} title={t('wall.empty.noViews')} description={t('wall.empty.noViewsHint')}
            action={<Button icon={<Plus size={14} />} onClick={() => { setDraftName(''); setCreating(true) }}>{t('wall.views.new')}</Button>} />
        ) : placed.length === 0 && !loading ? (
          <EmptyState icon={<LayoutGrid size={20} />} title={t('wall.empty.none')} description={query ? t('wall.empty.query', { query }) : t('wall.empty.hint')} />
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
                  focused={focusedId === id} away={awaySet.has(id)} pinned={view.pinned.includes(id)}
                  onFocus={setFocusedId} onLeave={leaveTile} onPin={togglePin} onDismiss={dismissTile} />
              )
            })}
          </div>
        )}
      </main>

      <ConfirmDialog open={creating} onOpenChange={setCreating} title={t('wall.views.newTitle')} confirmLabel={t('wall.views.create')}
        confirmDisabled={!draftName.trim()}
        onConfirm={() => {
          const created: SessionView = { id: newViewId(), name: draftName.trim(), preset: null, query, layout: (view?.layout ?? 'auto') as WallLayoutMode, pinned: [] }
          saveViews([...views, created])
          setCreating(false)
          setParams({ view: created.id }, { replace: true })
        }}>
        <p>{t('wall.views.newHint')}</p>
        <Field label={t('wall.views.name')} value={draftName} onChange={(event) => setDraftName(event.target.value)} maxLength={60} autoFocus />
        <p className="text-xs text-ink-faint">{t('wall.views.query')} <code className="font-mono text-ink-soft">{query || '—'}</code></p>
      </ConfirmDialog>

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
