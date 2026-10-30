import { PanelEmptyState } from './PanelEmptyState'
import { Tooltip, TooltipButton } from '../ui/Tooltip'
import { Check, Code2, Download, Eye, FileDiff, Loader, MoreHorizontal, RotateCcw, Save, Search, WrapText, X } from 'lucide-react'
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import {
  OPENABLE_MODEL_EXTENSIONS,
  VIEWABLE_DOCUMENT_TYPES,
  VIEWABLE_IMAGE_TYPES,
  VIEWABLE_MEDIA_TYPES,
} from '@sillage/protocol'
import { useEditorDocument, useEditorDraftPaths } from '../../lib/editor-documents'
import { clearReveal, useReveal } from '../../lib/editor-reveal'
import { useCurrentUser } from '../../lib/session'
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  openTab,
  pinTab,
  reorderTabs,
  restoreTabs,
  useEditorTabs,
} from '../../lib/editor-tabs'
import { fileIconUrl } from '../../lib/file-icons'
import { languageFromPath } from '../../lib/highlight'
import { downloadFile, rawFileUrl } from '../../lib/files-io'
import { useTranslate } from '../../lib/i18n'
import {
  isMarkdownPath,
  isSvgPath,
  setEditorWrap,
  setMarkdownView,
  setSvgView,
  useEditorWrap,
  useMarkdownView,
  useSvgView,
} from '../../lib/editor-preferences'
import { wsClient } from '../../lib/ws-client'
import { Markdown } from '../chat/Markdown'
import { FileLinkContext } from '../../lib/file-links'
import { Banner, Button, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, cx } from '../ui'
import { CodeEditor, type CodeEditorHandle } from './CodeEditor'
import { indentationOf, lineBreakOf } from './editor-setup'
import { MediaView } from './MediaView'

/** Lazy-load the viewer because three exceeds the rest of the app's size. */
const ModelView = lazy(() => import('./ModelView').then((m) => ({ default: m.ModelView })))

/** Tab drag transfer type distinct from explorer entries. */
const TAB_DRAG_TYPE = 'application/x-sillage-tab'

/** Open tabs above the active file. */
export function EditorPane({ scope }: { scope: string }) {
  const { data: user } = useCurrentUser()
  return user ? <UserEditorPane key={`${user.id}:${scope}`} userId={user.id} scope={scope} /> : null
}

function UserEditorPane({ userId, scope }: { userId: string; scope: string }) {
  const { paths, active, preview } = useEditorTabs(scope)
  useEffect(() => restoreTabs(scope), [scope])
  const drafts = useEditorDraftPaths(userId, scope)
  const closedDrafts = drafts.filter((path) => !paths.includes(path))
  const t = useTranslate()
  const tabList = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = tabList.current
    if (!node) return
    const reveal = () => node.querySelector('[data-editor-tab][aria-pressed="true"]')?.closest('[data-index]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(node)
    return () => observer.disconnect()
  }, [active, paths])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {closedDrafts.length > 0 ? (
        <details open className="shrink-0 border-b border-line bg-accent-wash px-3 py-2 text-xs text-ink-soft">
          <summary className="cursor-pointer py-1">{t('editor.drafts.recover', { count: closedDrafts.length })}</summary>
          <div className="flex max-h-32 flex-wrap gap-1 overflow-auto">
            {closedDrafts.map((path) => <Button key={path} size="sm" variant="ghost" className="min-w-0 max-w-full" title={path} onClick={() => openTab(scope, path)}><span className="truncate">{path}</span></Button>)}
          </div>
        </details>
      ) : null}
      {paths.length === 0 ? <PanelEmptyState><p className="text-sm text-ink-faint">{t('editor.empty')}</p></PanelEmptyState> : <>
      <div className="flex shrink-0 items-center border-b border-line">
        <div ref={tabList} data-file-tabs className="flex min-w-0 flex-1 items-center gap-px overflow-x-auto">
          {paths.map((path, index) => (
            <Tab
              key={path}
              path={path}
              index={index}
              active={path === active}
              preview={path === preview}
              dirty={drafts.includes(path)}
              showParent={paths.some((other) => other !== path && other.split('/').pop() === path.split('/').pop())}
              onActivate={() => activateTab(scope, path)}
              onPin={() => pinTab(scope, path)}
              onClose={() => closeTab(scope, path)}
              onDropAt={(from) => reorderTabs(scope, from, index)}
            />
          ))}
        </div>

        {active ? <IconButton
          size="sm"
          label={t(drafts.includes(active) ? 'editor.download.saved' : 'editor.download', { path: active })}
          onClick={() => downloadFile(scope, active)}
        ><Download size={14} /></IconButton> : null}
        <Menu
          trigger={
            <TooltipButton
              type="button"
              aria-label={t('editor.tabs.actions')}
              className="flex size-11 shrink-0 items-center justify-center border-l border-line text-ink-faint hover:text-ink md:size-8 pointer-coarse:size-11"
            >
              <MoreHorizontal size={14} />
            </TooltipButton>
          }
        >
          <MenuLabel>{t('editor.tabs.open')}</MenuLabel>
          <div className="max-h-60 max-w-[min(28rem,85vw)] overflow-auto">
            {paths.map((path) => <MenuItem key={path} icon={active === path ? <Check size={14} /> : undefined}
              onSelect={() => activateTab(scope, path)}><span className="truncate">{path}{drafts.includes(path) ? ' •' : ''}</span></MenuItem>)}
          </div>
          <MenuSeparator />
          <MenuItem
            icon={<X size={14} />}
            disabled={active === null || paths.length < 2}
            onSelect={() => closeOtherTabs(scope, active)}
          >
            {t('editor.tabs.closeOthers')}
          </MenuItem>
          <MenuItem icon={<X size={14} />} onSelect={() => closeOtherTabs(scope, null)}>
            {t('editor.tabs.closeAll')}
          </MenuItem>
        </Menu>
      </div>

      {/* Only one CodeMirror mounted; documents and drafts live outside the panel. */}
      {active ? (
        <FileView
          key={active}
          scope={scope}
          userId={userId}
          path={active}
        />
      ) : null}
      </>}
    </div>
  )
}

/** Draggable tabs allow grouping related files beyond opening order. Middle-click closes like browsers. */
function Tab({
  path,
  index,
  active,
  preview,
  dirty,
  showParent,
  onActivate,
  onPin,
  onClose,
  onDropAt,
}: {
  path: string
  index: number
  active: boolean
  /** Preview tab replaced by the next tree single-click. */
  preview: boolean
  dirty: boolean
  showParent: boolean
  onActivate: () => void
  onPin: () => void
  onClose: () => void
  onDropAt: (from: string) => void
}) {
  const [dropping, setDropping] = useState(false)
  const t = useTranslate()

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(TAB_DRAG_TYPE, path)
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
        // Without preventDefault browsers silently reject drops.
        event.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDropping(false)
        const from = event.dataTransfer.getData(TAB_DRAG_TYPE)
        if (from && from !== path) onDropAt(from)
      }}
      onAuxClick={(event) => {
        if (event.button === 1) onClose()
      }}
      className={cx(
        'group/tab flex h-11 shrink-0 items-center gap-1.5 border-r border-line pr-1 pl-2 md:h-8 pointer-coarse:h-11',
        active ? 'bg-surface text-ink' : 'bg-sunken text-ink-faint',
        dropping && 'border-l-2 border-l-accent',
      )}
      title={path}
      data-index={index}
    >
      {/* Double-click retains tabs like editors, matching permanent opening from the tree. */}
      <button
        type="button"
        onClick={onActivate}
        onDoubleClick={onPin}
        data-editor-tab
        onKeyDown={(event) => {
          const tabs = Array.from(event.currentTarget.closest('[data-file-tabs]')?.querySelectorAll<HTMLButtonElement>('[data-editor-tab]') ?? [])
          const index = tabs.indexOf(event.currentTarget)
          const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
          if (next === null) return
          event.preventDefault()
          tabs[next]?.focus()
          tabs[next]?.click()
        }}
        aria-pressed={active}
        aria-label={t(dirty ? 'editor.tab.labelDirty' : 'editor.tab.label', { path })}
        className="flex h-full min-w-0 items-center gap-1.5"
      >
        <img
          src={fileIconUrl(path.split('/').pop() ?? path, false)}
          alt=""
          aria-hidden
          className="size-4 shrink-0"
        />
        {/* Italics indicate tabs that will yield to the next file. */}
        <span className="flex min-w-0 flex-col text-left">
          <span className={cx('max-w-40 truncate text-xs', preview && 'italic')}>{path.split('/').pop()}</span>
          {showParent ? <span className="max-w-40 truncate text-[0.625rem] text-ink-faint">{path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/'}</span> : null}
        </span>
      </button>

      {dirty ? (
        <span aria-label={t('editor.tab.unsaved')} className="size-1.5 shrink-0 rounded-full bg-accent" />
      ) : null}

      <TooltipButton
        type="button"
        onClick={onClose}
        aria-label={t('editor.tab.close', { path })}
        className="flex size-11 items-center justify-center rounded text-ink-faint opacity-0 hover:text-ink group-hover/tab:opacity-100 focus-visible:opacity-100 md:size-6 pointer-coarse:size-11 pointer-coarse:opacity-100"
      >
        <X size={12} />
      </TooltipButton>
    </div>
  )
}

function FileView({ userId, scope, path }: { userId: string; scope: string; path: string }) {
  const editor = useRef<CodeEditorHandle>(null)
  const [position, setPosition] = useState({ line: 1, column: 1 })
  const { document, dirty, load, save, refresh, rebase, edit } = useEditorDocument(userId, scope, path)
  const { file, content, error, conflict, disk, loading, saving, persisted, revision } = document
  /** Draft shown against the version on disk; meaningless once nothing differs. */
  const [comparing, setComparing] = useState(false)
  const extension = languageFromPath(path)
  const isMarkdown = isMarkdownPath(path)
  // An SVG is text: it opens like Markdown, rendered or as its source, rather than as an image only.
  const isSvg = isSvgPath(path)
  const isImage = extension in VIEWABLE_IMAGE_TYPES && !isSvg
  const isDocument = extension in VIEWABLE_DOCUMENT_TYPES
  const mediaType = VIEWABLE_MEDIA_TYPES[extension]
  const isModel = OPENABLE_MODEL_EXTENSIONS.has(extension)
  const markdownView = useMarkdownView()
  const svgView = useSvgView()
  const wrap = useEditorWrap()
  const previewable = isMarkdown || isSvg
  const reveal = useReveal(scope, path)
  /** Source shown for a search result's line without changing the preference for other files. */
  const [sourceForced, setSourceForced] = useState(false)
  const showingSource = (isMarkdown ? markdownView : isSvg ? svgView : 'source') === 'source' || sourceForced
  const setView = isMarkdown ? setMarkdownView : setSvgView
  useEffect(() => {
    if (reveal && !showingSource) setSourceForced(true)
  }, [reveal, showingSource])
  const t = useTranslate()
  const rawView = isImage || isDocument || Boolean(mediaType) || isModel
  useEffect(() => {
    if (!rawView) void load()
  }, [rawView, load])
  useEffect(() => {
    if (!dirty) setComparing(false)
  }, [dirty])

  /**
   * Follow the file on disk while it is displayed: agents write it during turns, and a tab kept
   * open used to show the old text until another tab was opened. Watching its directory is enough
   * (writes and renames both show there), and the explorer shares the same watches.
   */
  const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  useEffect(() => {
    if (rawView) return
    const unwatch = wsClient.watchTree(scope, directory)
    const unlisten = wsClient.onTreeChanged((changed, changedPath) => {
      if (changed === scope && changedPath === directory) void refresh()
    })
    // Events missed while hidden or disconnected: check on return.
    const onVisible = () => {
      if (window.document.visibilityState === 'visible') void refresh()
    }
    window.document.addEventListener('visibilitychange', onVisible)
    return () => {
      unwatch()
      unlisten()
      window.document.removeEventListener('visibilitychange', onVisible)
    }
  }, [scope, directory, rawView, refresh])
  // From the version on disk rather than the draft, and only when it changes: scanning a large
  // file on every keystroke would cost more than the editor itself.
  const baseContent = file?.content
  const style = useMemo(
    () => (baseContent === undefined ? null : { lineBreak: lineBreakOf(baseContent), indent: indentationOf(baseContent, path) }),
    [baseContent, path],
  )

  const discard = () => {
    if (dirty && !confirm(t('editor.discard.confirm', { path }))) return
    void load(true)
  }

  if (isImage) {
    return <div data-editor-file={path} tabIndex={-1} className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 outline-none">
      <img src={rawFileUrl(scope, path)} alt={path} className="max-h-full max-w-full object-contain" />
    </div>
  }
  if (isDocument) return <iframe data-editor-file={path} src={rawFileUrl(scope, path)} title={path} className="min-h-0 min-w-0 flex-1 border-0 bg-canvas" />
  if (mediaType) return <MediaView scope={scope} path={path} type={mediaType} />
  if (isModel) {
    return <Suspense fallback={<div className="flex min-h-0 flex-1 items-center justify-center text-ink-faint">
      <Loader size={20} className="animate-spin" aria-label={t('editor.loading')} />
    </div>}>
      <ModelView scope={scope} path={path} />
    </Suspense>
  }

  if (!file) {
    return error ? <div data-editor-file={path} tabIndex={-1} className="min-h-0 flex-1 overflow-auto p-3 outline-none">
      <Banner>{error.message}</Banner>
      {/* Too large to edit, an SVG still displays as an image. */}
      {isSvg ? <img src={rawFileUrl(scope, path)} alt={path} className="mt-3 max-h-full max-w-full object-contain" /> : null}
      <Button size="sm" variant="ghost" className="mt-2" disabled={loading} onClick={() => void load()}>{t('editor.retry')}</Button>
    </div> : <div className="flex min-h-0 flex-1 items-center justify-center text-ink-faint">
      <Loader size={20} className="animate-spin" aria-label={t('editor.loading')} />
    </div>
  }

  return (
    <div data-editor-file={path} tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
      // The editor handles its own Ctrl+S; elsewhere in the file (Markdown preview, footer) the browser
      // would offer to save the page instead.
      onKeyDown={(event) => {
        if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
        event.preventDefault()
        if (!conflict) void save()
      }}>
      {error ? <div className="shrink-0 p-2">
        <Banner>{error.message} {dirty ? t('editor.error.kept') : ''}</Banner>
        <Button variant="ghost" size="sm" disabled={loading || saving} onClick={() => void (error.kind === 'read' ? load() : save())}>{t('editor.retry')}</Button>
      </div> : null}
      {file.lossy ? <div role="note" className="shrink-0 border-b border-line bg-sunken px-3 py-2 text-xs text-ink-soft">{t('editor.lossy')}</div> : null}
      {conflict ? <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-caution/40 bg-caution/12 px-3 py-2 text-xs text-ink-soft">
        <p className="w-full">{t('editor.conflict.message')}</p>
        {disk ? <Button variant="primary" size="sm" icon={<FileDiff size={13} />} disabled={loading || saving} onClick={() => {
          rebase()
          setComparing(true)
        }}>{t('editor.conflict.compare')}</Button> : null}
        <Button variant="secondary" size="sm" disabled={loading || saving} onClick={discard}>{t('editor.conflict.reload')}</Button>
        <Button variant="secondary" size="sm" disabled={loading || saving} onClick={() => {
          if (confirm(t('editor.conflict.overwriteConfirm', { path }))) void save(true)
        }}>{t('editor.conflict.overwrite')}</Button>
      </div> : null}

      {comparing && showingSource ? <p role="note" className="shrink-0 border-b border-line bg-sunken px-3 py-2 text-xs text-ink-soft">{t('editor.compare.hint')}</p> : null}

      {isSvg && !showingSource ? <SvgPreview content={content} label={path} /> : !showingSource ? (
        <div className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-3">
          {/* Editor scope rather than thread scope: project panels also preview outside conversations. */}
          <FileLinkContext.Provider value={scope}>
            <Markdown text={content} base={path.slice(0, path.lastIndexOf('/') + 1)} />
          </FileLinkContext.Provider>
        </div>
      ) : (
        <div className="min-h-0 min-w-0 flex-1">
          <CodeEditor
            ref={editor}
            sessionKey={JSON.stringify([userId, scope, path])}
            revision={revision}
            onPosition={(line, column) => setPosition({ line, column })}
            initial={content}
            path={file.path}
            lineBreak={style?.lineBreak}
            indent={style?.indent}
            readOnly={file.lossy === true}
            wrap={wrap}
            original={comparing ? file.content : null}
            reveal={reveal}
            onRevealed={() => clearReveal(scope, path)}
            onChange={(value) => { edit(value); pinTab(scope, path) }}
            onSave={() => { if (!conflict) void save() }}
          />
        </div>
      )}

      {/* Only drafts at risk get a visible line; a draft kept on the device is the expected case. */}
      {dirty && persisted !== 'device' ? <p role="note" className="shrink-0 border-t border-caution/40 bg-caution/12 px-2.5 py-1 text-xs text-ink-soft">
        {t(persisted === 'tab' ? 'editor.drafts.tab' : 'editor.drafts.memory')}
      </p> : null}

      {/*
       * One line, wrapping only when the panel is narrow: path and state on the left, file
       * commands as icons on the right, Save last. It took three lines of every file's height.
       */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-line px-2.5 py-1 text-xs text-ink-faint">
        <span className="min-w-16 flex-1 basis-24 truncate" title={path}>{path}</span>
        {showingSource ? <button type="button" className="shrink-0 rounded px-1 py-1 hover:text-ink" aria-label={t('editor.position', position)} title={t('editor.goToLine')} onClick={() => editor.current?.goToLine()}>
          {t('editor.position.short', position)}
        </button> : null}
        <Tooltip label={t('editor.drafts.kept')} disabled={!dirty || persisted !== 'device'}>
          <span role="status" tabIndex={dirty ? 0 : undefined} className={cx('shrink-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent', dirty && 'text-ink-soft')}>
            {t(saving ? 'editor.saving' : loading ? 'editor.loading' : dirty ? 'editor.tab.unsaved' : 'editor.saved')}
            {dirty && persisted === 'device' ? <span className="sr-only"> {t('editor.drafts.kept')}</span> : null}
          </span>
        </Tooltip>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {showingSource ? <IconButton size="sm" label={t('editor.find')} onClick={() => editor.current?.find()}><Search size={14} /></IconButton> : null}
          {showingSource ? <IconButton size="sm" label={t('editor.wrap')} aria-pressed={wrap}
            className={wrap ? 'bg-accent-wash text-ink' : undefined} onClick={() => setEditorWrap(!wrap)}><WrapText size={14} /></IconButton> : null}
          {dirty && !conflict && showingSource ? <IconButton size="sm" label={t(comparing ? 'editor.compare.hide' : 'editor.compare')} aria-pressed={comparing}
            className={comparing ? 'bg-accent-wash text-ink' : undefined} onClick={() => setComparing(!comparing)}><FileDiff size={14} /></IconButton> : null}
          {previewable ? <IconButton size="sm" label={t(showingSource ? 'editor.view.preview' : 'editor.view.source')}
            onClick={() => {
              setSourceForced(false)
              setView(showingSource ? 'preview' : 'source')
            }}>{showingSource ? <Eye size={14} /> : <Code2 size={14} />}</IconButton> : null}
          {dirty && !conflict ? <IconButton size="sm" label={t('editor.discard')} disabled={saving || loading} onClick={discard}><RotateCcw size={14} /></IconButton> : null}
          <Button size="sm" variant={dirty ? 'primary' : 'ghost'} icon={saving ? <Loader size={13} className="animate-spin" /> : <Save size={13} />}
            disabled={!dirty || saving || loading || conflict} onClick={() => void save()}>{t(saving ? 'editor.saving' : 'editor.save')}</Button>
        </div>
      </div>
    </div>
  )
}

/**
 * The draft rendered as an image, so the preview follows edits before they are saved. An `img`
 * never runs the scripts an SVG may carry.
 */
function SvgPreview({ content, label }: { content: string; label: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [content])
  return <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
    {url ? <img src={url} alt={label} className="max-h-full max-w-full object-contain" /> : null}
  </div>
}
