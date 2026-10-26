import { ArrowLeft, Brain, Plus, ChevronRight, Search, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { MAX_MEMORY_FILE_CHARS, MEMORY_INDEX_FILE, type MemoryFileDto, type MemoryMode } from '@sillage/protocol'
import { locale, useTranslate } from '../../lib/i18n'
import {
  memoryDescription,
  useDeleteMemoryFile,
  useMemoryBrowser,
  useProjectMemory,
  useSetMemoryMode,
  useWriteMemoryFile,
} from '../../lib/memory'
import { Banner, Button, Card, CardBody, CardHeader, ChoiceList, ConfirmDialog, Field, IconButton, type Choice } from '../ui'
import { HowItWorks, MEMORY_HELP } from './HowItWorks'
import { MarkdownEditor } from './Instructions'

export function ProjectMemory({ projectId }: { projectId: string | null }) {
  const t = useTranslate()
  const { data, error } = useProjectMemory(projectId)
  const browser = useMemoryBrowser(data?.files)
  const [open, setOpen] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [visited, setVisited] = useState<Set<string>>(() => new Set())
  const [deleting, setDeleting] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const remove = useDeleteMemoryFile(projectId)
  const setMode = useSetMemoryMode(projectId)
  const selected = data?.mode === 'sillage' ? data.files.find((file) => file.file === open) : undefined
  const modes: Choice<MemoryMode>[] = [
    { value: 'sillage', label: t('memory.mode.sillage'), hint: t('memory.mode.sillage.hint') },
    { value: 'native', label: t('memory.mode.native'), hint: t('memory.mode.native.hint') },
  ]

  function back() {
    setOpen(null)
    requestAnimationFrame(() => {
      const buttons = list.current?.querySelectorAll<HTMLButtonElement>('button[data-memory-file]')
      const trigger = Array.from(buttons ?? []).find((button) => button.dataset.memoryFile === open)
      ;(trigger ?? list.current?.querySelector('input'))?.focus()
    })
  }

  return (
    <Card>
      <CardHeader title={t(projectId ? 'memory.title' : 'discussions.memory')} description={t(projectId ? 'memory.browser.description' : 'discussions.memory.description')} icon={<Brain size={16} />}
        actions={!selected && projectId ? <IconButton label={t('memory.options')} aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}>
          <SlidersHorizontal size={16} />
        </IconButton> : null} />
      <CardBody className="flex flex-col gap-3">
        {!projectId ? <PersonalMemoryControls /> : null}
        {error || setMode.error || remove.error ? <Banner>{(error ?? setMode.error ?? remove.error)?.message}</Banner> : null}
        <div ref={list} hidden={Boolean(selected)}>
          <div className="flex flex-col gap-4">
            <div hidden={!settingsOpen} className="rounded-md border border-line px-3 py-2">
              <h3 className="text-sm font-medium text-ink-soft">{t('memory.options')}</h3>
              <div className="flex flex-col gap-3 pt-3">
                <HowItWorks items={MEMORY_HELP} />
                {data?.canEdit ? <ChoiceList label={t('memory.mode')} value={data.mode} options={modes} onChange={(mode) => setMode.mutate(mode)} /> : null}
                {data ? <p className="break-all font-mono text-xs text-ink-faint">{data.dir}</p> : null}
                {data?.importedFrom ? <p className="text-xs text-ink-faint">{t('memory.imported', { dir: data.importedFrom.dir, when: new Date(data.importedFrom.at).toLocaleDateString(locale()) })}</p> : null}
              </div>
            </div>
            {data?.mode === 'native' ? <Banner tone="info">{t('memory.native.notice')}</Banner> : null}
            {data?.mode === 'sillage' ? <>
              {data.files.length === 0 ? <p className="text-sm text-ink-faint">{t('memory.empty')}</p> : <>
                <Field type="search" label={t('memory.search')} hint={t('memory.search.hint')} icon={<Search size={15} />}
                  value={browser.query} onChange={(event) => browser.search(event.target.value)} />
                {browser.count === 0 ? <p role="status" className="text-sm text-ink-faint">{t('memory.search.empty')}</p> : null}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p role="status" className="text-xs text-ink-faint">{t('memory.page', { page: browser.page + 1, pages: browser.pages, count: browser.count })}</p>
                  {browser.pages > 1 ? <div className="flex gap-2">
                    <Button size="sm" variant="ghost" disabled={browser.page === 0} onClick={() => browser.setPage(browser.page - 1)}>{t('memory.previous')}</Button>
                    <Button size="sm" variant="ghost" disabled={browser.page === browser.pages - 1} onClick={() => browser.setPage(browser.page + 1)}>{t('memory.next')}</Button>
                  </div> : null}
                </div>
                <ul className="divide-y divide-line">
                  {browser.files.map((file) => <li key={file.file} className="flex items-center gap-2 py-2">
                    <button type="button" data-memory-file={file.file}
                      onClick={() => { setVisited((previous) => new Set([...previous, file.file])); setOpen(file.file) }}
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-accent">
                      <div className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-sm" title={file.file}>{file.file}</span>
                        <span className="block truncate text-xs text-ink-faint">{file.file === MEMORY_INDEX_FILE ? t('memory.index') : memoryDescription(file.content)}</span>
                      </div>
                      <ChevronRight size={15} className="shrink-0 text-ink-faint" />
                    </button>
                    {data.canEdit && file.file !== MEMORY_INDEX_FILE ? <IconButton label={t('memory.delete.title', { file: file.file })} size="sm" onClick={() => setDeleting(file.file)}><Trash2 size={14} /></IconButton> : null}
                  </li>)}
                </ul>

              </>}
            </> : null}
          </div>
        </div>
        {/* Keep visited editors mounted so switching notes or categories never discards a draft. */}
        {data?.files.filter((file) => visited.has(file.file)).map((file) => (
          <div key={file.file} hidden={selected?.file !== file.file}>
            <MemoryEditor projectId={projectId} file={file} canEdit={data.canEdit} active={selected?.file === file.file} onBack={back} />
          </div>
        ))}
      </CardBody>
      <ConfirmDialog open={deleting !== null} onOpenChange={(next) => (next ? null : setDeleting(null))}
        title={t('memory.delete.title', { file: deleting ?? '' })} confirmLabel={t('memory.delete.confirm')}
        tone="critical" busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting, { onSuccess: () => setDeleting(null) })}>
        <p>{t('memory.delete.body')}</p>
      </ConfirmDialog>
    </Card>
  )
}

function PersonalMemoryControls() {
  const t = useTranslate()
  const { data } = useProjectMemory(null)
  const write = useWriteMemoryFile(null)
  const [adding, setAdding] = useState(false)
  const [file, setFile] = useState('')
  const [content, setContent] = useState('')
  return <div className="flex flex-col gap-3">
    <Button size="sm" variant="ghost" className="self-start" icon={<Plus size={15} />} onClick={() => setAdding(!adding)}>{t('discussions.memory.add')}</Button>
    {adding ? <form className="flex flex-col gap-3 rounded-md border border-line p-3" onSubmit={event => {
      event.preventDefault()
      write.mutate({ file: file.endsWith('.md') ? file : `${file}.md`, content }, { onSuccess: () => { setAdding(false); setFile(''); setContent('') } })
    }}>
      <Field label={t('discussions.memory.filename')} value={file} onChange={event => setFile(event.target.value)} required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*" />
      <label className="flex flex-col gap-2 text-sm">{t('discussions.memory.content')}<textarea className="min-h-28 rounded-md border border-line bg-canvas p-3" required maxLength={MAX_MEMORY_FILE_CHARS} value={content} onChange={event => setContent(event.target.value)} /></label>
      {write.error ? <Banner>{write.error.message}</Banner> : null}
      <Button type="submit" size="sm" className="self-start" disabled={write.isPending || data?.files.some(entry => entry.file === (file.endsWith('.md') ? file : `${file}.md`))}>{t('editor.save')}</Button>
    </form> : null}
    <details className="rounded-md border border-line px-3 py-2">
      <summary className="cursor-pointer text-sm">{t('discussions.memory.history')}</summary>
      <p className="mt-2 text-xs text-ink-faint">{t('discussions.memory.historyHint')}</p>
      <div className="mt-3 max-h-80 overflow-y-auto">{data?.changes?.map(change => <details key={change.id} className="border-t border-line py-2 text-xs">
        <summary className="cursor-pointer break-all">{change.file} · {new Date(change.createdAt).toLocaleString(locale())}</summary>
        <p className="mt-3 font-medium">{t('discussions.memory.before')}</p><pre className="my-2 whitespace-pre-wrap break-words font-mono text-ink-soft">{change.before ?? t('discussions.memory.absent')}</pre>
        <p className="font-medium">{t('discussions.memory.after')}</p><pre className="my-2 whitespace-pre-wrap break-words font-mono text-ink-soft">{change.after ?? t('discussions.memory.absent')}</pre>
      </details>)}</div>
    </details>
  </div>
}

function MemoryEditor({ projectId, file, canEdit, active, onBack }: {
  projectId: string | null; file: MemoryFileDto; canEdit: boolean; active: boolean; onBack: () => void
}) {
  const t = useTranslate()
  const write = useWriteMemoryFile(projectId)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (active) heading.current?.focus() }, [active])
  return <div className="flex flex-col gap-3">
    <Button variant="ghost" size="sm" className="self-start" icon={<ArrowLeft size={15} />} onClick={onBack}>{t('memory.back')}</Button>
    <h3 ref={heading} tabIndex={-1} className="break-all font-mono text-sm font-medium text-ink outline-none">{file.file}</h3>
    <MarkdownEditor value={file.content} canEdit={canEdit} maxLength={MAX_MEMORY_FILE_CHARS} placeholder=""
      saving={write.isPending} error={write.error} onSave={(content) => write.mutate({ file: file.file, content })} />
  </div>
}
