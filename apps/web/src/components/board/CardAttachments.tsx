import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileText, Paperclip, Plus, Trash2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { MAX_ATTACHMENT_BYTES, type AttachmentDto } from '@sillage/protocol'
import { api } from '../../lib/api'
import { formatBytes, uploadAttachment } from '../../lib/attachments'
import { useTranslate } from '../../lib/i18n'
import { Button, IconButton, cx } from '../ui'

export function CardAttachments({ cardId, projectId }: { cardId: string; projectId: string }) {
  const t = useTranslate()
  const client = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const endpoint = `/api/cards/${cardId}/attachments`
  const key = ['card-attachments', cardId]
  const files = useQuery({ queryKey: key, queryFn: () => api.get<AttachmentDto[]>(endpoint) })
  const refresh = async () => {
    await Promise.all([client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: ['cards', projectId] })])
  }
  const upload = useMutation({
    mutationFn: async (selected: File[]) => {
      const failed: string[] = []
      // Envoi séquentiel : plusieurs vidéos ne saturent pas la mémoire du serveur.
      for (const file of selected) {
        try { await uploadAttachment(file, endpoint) }
        catch (error) { failed.push(`${file.name} : ${error instanceof Error ? error.message : t('board.files.error')}`) }
      }
      setErrors(failed)
    },
    onSettled: refresh,
  })
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`${endpoint}/${id}`), onSuccess: refresh })
  const add = (selected: File[]) => {
    if (!selected.length || upload.isPending) return
    setErrors([])
    upload.mutate(selected)
  }
  return (
    <section className="flex flex-col gap-3" aria-label={t('board.files.title')}>
      <div className="flex items-center gap-2">
        <Paperclip size={16} className="text-ink-faint" />
        <h3 className="flex-1 text-sm font-semibold">{t('board.files.title')}</h3>
        <Button size="sm" variant="ghost" icon={<Plus size={14} />} disabled={upload.isPending} onClick={() => input.current?.click()}>{t('board.files.add')}</Button>
      </div>
      <p className="text-xs leading-relaxed text-ink-faint">{t('board.files.hint', { max: Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024) })}</p>
      <input ref={input} type="file" multiple className="hidden" aria-label={t('board.files.add')}
        onChange={(event) => { add(Array.from(event.target.files ?? [])); event.target.value = '' }} />
      <div onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setOver(true) } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(false) }}
        onDrop={(event) => { event.preventDefault(); setOver(false); add(Array.from(event.dataTransfer.files)) }}
        className={cx('rounded-xl border border-dashed p-3 transition-colors', over ? 'border-accent bg-accent-wash' : 'border-line')}>
        {files.data?.length ? <ul className="flex flex-col gap-2">
          {files.data.map((file) => <li key={file.id} className="flex items-center gap-3 rounded-lg border border-line bg-sunken p-2">
            <a href={`/api/attachments/${file.id}`} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-center gap-3 text-sm hover:text-accent">
              {file.inlineImage ? <img src={`/api/attachments/${file.id}`} alt="" className="size-12 shrink-0 rounded-md object-cover" /> : <FileText size={24} className="mx-3 shrink-0 text-ink-faint" />}
              <span className="min-w-0"><span className="block truncate">{file.filename}</span><span className="block text-xs text-ink-faint">{formatBytes(file.sizeBytes)}</span></span>
              <Download size={14} className="ml-auto shrink-0 text-ink-faint" />
            </a>
            <IconButton label={t('board.files.remove', { name: file.filename })} size="sm" disabled={remove.isPending}
              onClick={() => { if (confirm(t('board.files.removeConfirm', { name: file.filename }))) remove.mutate(file.id) }}><Trash2 size={14} /></IconButton>
          </li>)}
        </ul> : null}
        <button type="button" disabled={upload.isPending} onClick={() => input.current?.click()}
          className="flex min-h-16 w-full items-center justify-center gap-2 rounded-lg px-3 py-4 text-sm text-ink-faint hover:bg-surface-high hover:text-ink">
          <Upload size={16} />{t(upload.isPending ? 'board.files.uploading' : 'board.files.drop')}
        </button>
      </div>
      {files.isError ? <div role="alert" className="text-sm text-critical">{t('board.files.loadError')} <button onClick={() => void files.refetch()} className="underline">{t('agent.install.retry')}</button></div> : null}
      {errors.map((error) => <p key={error} role="alert" className="text-sm text-critical">{error}</p>)}
      {remove.isError ? <p role="alert" className="text-sm text-critical">{t('board.files.error')}</p> : null}
    </section>
  )
}
