import { useState } from 'react'
import type { DiffItem } from '../../lib/chat-fold'
import { useTranslate } from '../../lib/i18n'
import { useEventBody } from '../../lib/tool-output'

export function DiffCard({ item, conversationId }: { item: DiffItem; conversationId: string }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  return <details className="rounded-lg border border-line bg-surface/60 p-3 text-xs" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">{t('diff.turn.title')}</summary>
    {item.files.length > 0 ? <ul className="mt-2 space-y-1">
      {item.files.map((file) => <li key={file.path} className="break-words">{file.path} <span className="text-positive">+{file.added}</span> <span className="text-critical">−{file.removed}</span></li>)}
    </ul> : null}
    {open ? (item.patchRef ? <Patch item={item} conversationId={conversationId} /> : <PatchText patch={item.patch} />) : null}
  </details>
}

function Patch({ item, conversationId }: { item: DiffItem; conversationId: string }) {
  const t = useTranslate()
  const body = useEventBody(conversationId, item.patchRef)
  const patch = item.patchRef ? body.data?.value : item.patch
  if (body.error) return <p role="alert" className="mt-2 text-critical">{body.error.message || t('journal.content.error')}</p>
  if (item.patchRef && !body.data) return <p className="mt-2 text-ink-faint">{t('journal.content.loading')}</p>
  return <PatchText patch={patch} />
}

function PatchText({ patch }: { patch: unknown }) {
  return typeof patch === 'string' && patch ? <pre className="mt-2 max-h-96 overflow-auto whitespace-pre">{patch}</pre> : null
}
