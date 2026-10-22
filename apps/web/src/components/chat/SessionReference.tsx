import { Info, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ConversationDto } from '@sillage/protocol'
import { sessionReference } from '@sillage/protocol'
import { useLiveBackground, useLiveLoops, useLiveMetrics, useLiveStatus } from '../../lib/conversation-status'
import { useTranslate } from '../../lib/i18n'
import { sessionHref } from '../../lib/session-references'
import { buildSidebarSignals } from '../../lib/signals'
import { AgentIcon } from '../AgentIcon'
import { SessionDetails } from '../SessionPreview'
import { IconButton, Popover } from '../ui'
import { Tooltip } from '../ui/Tooltip'

function ReferenceDetails({ conversation }: { conversation: ConversationDto }) {
  const status = useLiveStatus(conversation.id) ?? conversation.status
  const background = useLiveBackground(conversation.id)
  const loops = useLiveLoops(conversation.id)
  const metrics = useLiveMetrics(conversation.id) ?? conversation.metrics
  const signals = useMemo(() => buildSidebarSignals({ status, background, loops }), [status, background, loops])
  return <SessionDetails conversation={conversation} metrics={metrics} signals={signals} />
}

/** Navigation and details have separate targets, including on touch screens. */
export function SessionReference({ id, conversation, loading = false }: {
  id: string
  conversation?: ConversationDto
  loading?: boolean
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const info = useRef<HTMLButtonElement>(null)
  if (!conversation) return <span className="sg-session-unavailable" title={sessionReference(id)}>
    {t(loading ? 'sessionRef.loading' : 'sessionRef.unavailable')}
  </span>
  const details = <ReferenceDetails conversation={conversation} />
  const href = sessionHref(conversation)
  return <span className="sg-session-ref" data-session-reference={id}>
    <Tooltip label={details} className="session-preview-tooltip" disabled={open}>
      <Link to={href} className="sg-session-link"><AgentIcon agent={conversation.agent} size={14} /><span>{conversation.title}</span></Link>
    </Tooltip>
    <Popover open={open} onOpenChange={setOpen} label={t('shell.preview.open', { title: conversation.title })}
      side="bottom" className="session-preview-popover"
      onCloseAutoFocus={event => {
        event.preventDefault()
        // Closing animations must not steal focus from a field the user already clicked.
        const active = document.activeElement
        if (!active || active === document.body || active.closest('.session-preview-popover')) info.current?.focus({ preventScroll: true })
      }}
      trigger={<button ref={info} type="button" className="sg-session-info" aria-label={t('shell.preview.open', { title: conversation.title })}><Info size={13} /></button>}>
      <div className="session-preview-close"><IconButton label={t('common.close')} onClick={() => setOpen(false)}><X size={15} /></IconButton></div>
      {details}
      <Link to={href} className="mt-3 flex min-h-11 items-center justify-center rounded-md border border-line text-sm text-ink" onClick={() => setOpen(false)}>{t('sessionRef.open')}</Link>
    </Popover>
  </span>
}
