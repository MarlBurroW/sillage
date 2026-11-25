import { useMemo } from 'react'
import type { ConversationDto } from '@sillage/protocol'
import { useLiveBackground, useLiveLoops, useLiveStatus } from '../../lib/conversation-status'
import { buildSidebarSignals, presentSignal } from '../../lib/signals'
import { SignalDot } from '../chat/Signals'

/**
 * A session's live state on its palette row, with the sidebar's vocabulary and precedence. The
 * label is written out: a palette row is read at a glance and offers no hover to explain a dot.
 * Mounted per visible row only, so a thousand listed conversations cost ten subscriptions.
 */
export function SessionState({ conversation }: { conversation: Pick<ConversationDto, 'id' | 'status'> }) {
  // Socket status takes precedence over the load-time list snapshot.
  const status = useLiveStatus(conversation.id) ?? conversation.status
  const background = useLiveBackground(conversation.id)
  const loops = useLiveLoops(conversation.id)
  const signal = useMemo(
    () => presentSignal(buildSidebarSignals({ status, background, loops })),
    [status, background, loops],
  )
  if (!signal) return null
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[0.6875rem] text-ink-soft">
      <SignalDot signal={signal} />
      {signal.label}
    </span>
  )
}
