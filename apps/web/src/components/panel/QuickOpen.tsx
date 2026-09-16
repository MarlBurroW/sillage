import * as Dialog from '@radix-ui/react-dialog'
import { Loader, Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useEditorDraftPaths } from '../../lib/editor-documents'
import { useEditorTabs } from '../../lib/editor-tabs'
import { fileIconUrl } from '../../lib/file-icons'
import { useCurrentUser } from '../../lib/session'
import { useFileSearch } from '../../lib/tree'
import { useTranslate } from '../../lib/i18n'
import { Button, IconButton, cx } from '../ui'

/** Ouverture au clavier dans le workspace courant, jamais dans un autre projet. */
export function QuickOpen({ scope, workspaceLabel, open, onOpenChange, onSelect }: {
  scope: string
  workspaceLabel: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (path: string) => void
}) {
  const t = useTranslate()
  const { data: user } = useCurrentUser()
  const { paths, active: activePath } = useEditorTabs(scope)
  const drafts = useEditorDraftPaths(user?.id ?? '', scope)
  const [query, setQuery] = useState('')
  const [settled, setSettled] = useState('')
  const [active, setActive] = useState(0)
  const selected = useRef<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()
  const trimmed = query.trim()
  const searching = trimmed.length >= 2
  const result = useFileSearch(scope, open ? settled : '')
  useEffect(() => {
    const timer = setTimeout(() => setSettled(trimmed), 120)
    return () => clearTimeout(timer)
  }, [trimmed])
  useEffect(() => {
    if (open) return
    setQuery('')
    setSettled('')
    setActive(0)
  }, [open])

  const recent = [...new Set([...(activePath ? [activePath] : []), ...paths, ...drafts])]
  const entries = searching
    ? settled === trimmed ? (result.data?.entries ?? []).filter((entry) => !entry.isDirectory).map((entry) => entry.path) : []
    : recent.filter((path) => path.toLowerCase().includes(trimmed.toLowerCase()))
  const index = Math.min(active, Math.max(entries.length - 1, 0))
  const pending = searching && (settled !== trimmed || result.isPending)

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, entries.length])

  const choose = (path: string | undefined) => {
    if (!path) return
    selected.current = path
    onSelect(path)
    onOpenChange(false)
  }

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" />
      <Dialog.Content className="surface fixed top-[max(1rem,var(--sg-viewport-top,0px))] left-1/2 z-50 flex max-h-[min(36rem,80dvh)] w-[min(36rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col rounded-xl border border-line shadow-pop sm:top-24"
        onOpenAutoFocus={() => { selected.current = null }}
        onCloseAutoFocus={(event) => {
          const path = selected.current
          if (!path) return
          event.preventDefault()
          const root = document.querySelector('[data-panel="workspace"]')
          if (!root) return
          // La lecture réseau peut terminer après la fermeture de la palette.
          const focus = () => {
            const file = Array.from(root.querySelectorAll<HTMLElement>('[data-editor-file]')).find((node) => node.dataset.editorFile === path)
            if (!file) return false
            ;(file.querySelector<HTMLElement>('.cm-content') ?? file).focus({ preventScroll: true })
            return true
          }
          if (focus()) return
          const observer = new MutationObserver(() => { if (focus()) { observer.disconnect(); clearTimeout(timer) } })
          const timer = setTimeout(() => observer.disconnect(), 3000)
          observer.observe(root, { childList: true, subtree: true })
        }}>
        <Dialog.Title className="px-4 pt-3 text-sm font-semibold text-ink">{t('editor.quickOpen.title')}</Dialog.Title>
        <Dialog.Description className="px-4 pt-1 text-xs text-ink-faint"><span className="block truncate font-medium" title={workspaceLabel}>{workspaceLabel}</span>{t('editor.quickOpen.hint')}</Dialog.Description>
        <div className="m-3 flex shrink-0 items-center gap-2 rounded-lg border border-line bg-sunken pl-3 focus-within:border-accent">
          <Search size={16} className="shrink-0 text-ink-faint" />
          <input role="combobox" aria-label={t('editor.quickOpen.query')} aria-autocomplete="list" aria-expanded="true" aria-controls={id}
            aria-activedescendant={entries[index] ? `${id}-${index}` : undefined}
            value={query} onChange={(event) => { setQuery(event.target.value); setActive(0) }}
            placeholder={t('editor.quickOpen.placeholder')} maxLength={200}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setActive(entries.length ? (index + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length : 0)
              } else if (event.key === 'Enter') { event.preventDefault(); choose(entries[index]) }
            }} />
          <IconButton label={t('editor.quickOpen.close')} onClick={() => onOpenChange(false)}><X size={16} /></IconButton>
        </div>
        <div ref={list} id={id} role="listbox" aria-label={t('editor.quickOpen.results')} className="min-h-0 overflow-y-auto px-2 pb-2">
          {entries.map((path, entryIndex) => <div key={path} id={`${id}-${entryIndex}`} role="option" aria-label={path} aria-selected={entryIndex === index}
            onMouseDown={(event) => event.preventDefault()} onClick={() => choose(path)}
            className={cx('flex min-h-12 cursor-pointer items-center gap-2 rounded-lg px-3 py-2', entryIndex === index ? 'bg-accent-wash text-ink' : 'text-ink-soft hover:bg-surface-high')}>
            <img src={fileIconUrl(path.split('/').pop() ?? path, false)} alt="" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm">{path.split('/').pop()}</span><span className="block truncate text-xs text-ink-faint">{path}</span></span>
            {drafts.includes(path) ? <span className="text-xs text-ink-faint">{t('editor.tab.unsaved')}</span> : null}
          </div>)}
        </div>
        {pending ? <p role="status" className="flex items-center gap-2 px-4 pb-3 text-sm text-ink-faint"><Loader size={14} className="animate-spin" />{t('editor.quickOpen.loading')}</p>
          : searching && result.isError ? <div role="alert" className="px-4 pb-3 text-sm text-critical">{t('editor.quickOpen.error')} <Button size="sm" variant="ghost" onClick={() => void result.refetch()}>{t('editor.retry')}</Button></div>
          : entries.length === 0 ? <p role="status" className="px-4 pb-3 text-sm text-ink-faint">{t(searching ? 'editor.quickOpen.empty' : 'editor.quickOpen.start')}</p> : null}
        <p className="border-t border-line px-4 py-2 text-xs text-ink-faint">{t(searching && result.data?.truncated ? 'editor.quickOpen.truncated' : 'editor.quickOpen.keys')}</p>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
