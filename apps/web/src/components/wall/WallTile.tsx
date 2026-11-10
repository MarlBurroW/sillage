import { conversationPath, type ConversationDto, type DecisionDto, type SessionFacts, type WorktreeStatusDto } from '@sillage/protocol'
import { ArrowUp, EyeOff, MessageCircleQuestion, Pin, PinOff, Square, SquareArrowOutUpRight, X } from 'lucide-react'
import { memo, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { describeActivity } from '../../lib/chat-fold'
import { interruptConversation, sendMessage } from '../../lib/conversations'
import { relativeDate } from '../../lib/dates'
import { openDecision } from '../../lib/decisions'
import { useTranslate } from '../../lib/i18n'
import { useTrackRead } from '../../lib/reads'
import { buildRows } from '../../lib/tool-rows'
import { useChatStream } from '../../lib/use-chat-stream'
import { AgentIcon, AGENT_LABELS } from '../AgentIcon'
import { ChatThread } from '../chat/ChatThread'
import { TurnActivity } from '../chat/TurnActivity'
import { cx, IconButton } from '../ui'
import { Tooltip } from '../ui/Tooltip'
import { WORKTREE_STATE_TEXT, WorktreeStateIcon } from '../WorktreeTag'

/** Items kept from the end of the thread: enough to fill a tall tile, few enough to stay light. */
const TAIL_ITEMS = 30
/** Distance from the bottom under which the tile keeps following new content. */
const STICK_PX = 48

export interface WallTileProps {
  conversation: ConversationDto
  facts: SessionFacts
  projectName: string | null
  tree: WorktreeStatusDto | null
  decision: DecisionDto | null
  index: number
  focused: boolean
  away: boolean
  pinned: boolean
  onFocus: (id: string) => void
  /** Leave the tile, from Escape in its composer. */
  onLeave: () => void
  onPin: (id: string) => void
  onDismiss: (id: string) => void
}

/**
 * One session on the wall: the end of its real thread, rendered by the conversation's own
 * components so prompts can be answered in place. Focusing a tile reads it, like opening the
 * conversation, and reveals a short composer.
 */
export const WallTile = memo(function WallTile({ conversation, facts, projectName, tree, decision, index, focused, away, pinned, onFocus, onLeave, onPin, onDismiss }: WallTileProps) {
  const t = useTranslate()
  const stream = useChatStream(conversation.id, conversation.status)

  const { items, turnRunning } = stream.state
  const rows = useMemo(() => buildRows(items.slice(-TAIL_ITEMS), null, turnRunning), [items, turnRunning])
  const activity = facts.state === 'running' ? describeActivity(stream.state) ?? t('wall.tile.working') : null

  const scroller = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  useLayoutEffect(() => {
    const node = scroller.current
    if (node && stuck.current) node.scrollTop = node.scrollHeight
  }, [rows, activity])

  const focus = (event: MouseEvent<HTMLElement>) => {
    // Clicks on links, buttons and fields keep their own meaning.
    if ((event.target as HTMLElement).closest('a,button,input,textarea,select,label,[role="button"]')) return
    onFocus(conversation.id)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      onFocus(conversation.id)
    }
  }

  const state = facts.state
  const worktreeLabel = tree ? t(`worktrees.state.${tree.state}`) : null
  return (
    <article
      className={cx('wall-tile', focused && 'wall-tile-focused', away && 'wall-tile-away', facts.unread && 'wall-tile-unread',
        state === 'attention' && (conversation.status === 'error' ? 'wall-tile-error' : 'wall-tile-attention'))}
      data-conversation-id={conversation.id}
      aria-label={conversation.title}
      tabIndex={0}
      onClick={focus}
      onKeyDown={onKeyDown}
    >
      <header className="wall-tile-head">
        <Tooltip label={AGENT_LABELS[conversation.agent]}><span className="wall-tile-agent"><AgentIcon agent={conversation.agent} size={16} /></span></Tooltip>
        <Link to={conversationPath(conversation)} className="wall-tile-title">{conversation.title}</Link>
        {facts.unread ? <span className="wall-tile-unread-dot" role="img" aria-label={t('wall.tile.unread')} /> : null}
        {pinned ? <Tooltip label={t('wall.tile.pinned')}><span className="wall-tile-pinned"><Pin size={13} /></span></Tooltip> : null}
        <span className="wall-tile-actions">
          <IconButton size="sm" label={pinned ? t('wall.tile.unpin') : t('wall.tile.pin')} aria-pressed={pinned} onClick={() => onPin(conversation.id)}>
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </IconButton>
          <Link to={conversationPath(conversation)} className="wall-tile-open" aria-label={t('wall.tile.open')} title={t('wall.tile.open')}>
            <SquareArrowOutUpRight size={14} />
          </Link>
          <IconButton size="sm" label={t('wall.tile.dismiss')} onClick={() => onDismiss(conversation.id)}><X size={14} /></IconButton>
        </span>
      </header>
      <div className="wall-tile-meta">
        <span className="truncate">{projectName ?? t('discussions.title')}</span>
        {tree && worktreeLabel ? (
          <Tooltip label={`${tree.name} · ${worktreeLabel}`}>
            <span className={cx('wall-tile-tree', WORKTREE_STATE_TEXT[tree.state])}><WorktreeStateIcon state={tree.state} /><span className="truncate">{worktreeLabel}</span></span>
          </Tooltip>
        ) : null}
        {away ? (
          <Tooltip label={t('wall.tile.awayHint')}>
            <span className="wall-tile-away-tag"><EyeOff size={11} />{t('wall.tile.away')}</span>
          </Tooltip>
        ) : null}
      </div>

      <div ref={scroller} className="wall-tile-thread" onScroll={(event) => {
        const node = event.currentTarget
        stuck.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_PX
      }}>
        {stream.loading && rows.length === 0 ? <p className="wall-tile-note">{t('wall.tile.loading')}</p> : null}
        {stream.error ? <p className="wall-tile-note text-critical">{stream.error}</p> : null}
        <ChatThread rows={rows} conversationId={conversation.id} canDecide={conversation.isOwner} mayCollapseTools />
      </div>

      {decision ? (
        <button type="button" className="wall-tile-decision" onClick={() => openDecision(decision.id)}>
          <MessageCircleQuestion size={14} /><span className="truncate">{decision.question}</span><span className="wall-tile-decision-cta">{t('wall.tile.decide')}</span>
        </button>
      ) : null}

      <footer className="wall-tile-foot">
        {activity ? <TurnActivity label={activity} />
          : state === 'attention' ? <span className={conversation.status === 'error' ? 'text-critical' : 'text-caution'}>{t(conversation.status === 'error' ? 'wall.tile.error' : 'wall.tile.waiting')}</span>
          : <span>{t('wall.tile.idle', { when: relativeDate(facts.activityAt) })}</span>}
        {index < 9 ? <kbd className="wall-tile-key" title={t('wall.tile.shortcut', { key: index + 1 })}>{index + 1}</kbd> : null}
      </footer>

      {focused ? <ReadTracker conversationId={conversation.id} lastSeq={Math.max(conversation.lastSeq, stream.state.lastSeq)} /> : null}
      {focused && conversation.isOwner ? <TileComposer conversationId={conversation.id} running={state === 'running'} onLeave={onLeave} /> : null}
    </article>
  )
})

/**
 * A focused tile is being read: same cursor upkeep as an open conversation. Mounted on focus so
 * the cursor goes out at once, as when opening the conversation, not on the next interval.
 */
function ReadTracker({ conversationId, lastSeq }: { conversationId: string; lastSeq: number }) {
  useTrackRead(conversationId, lastSeq)
  return null
}

function TileComposer({ conversationId, running, onLeave }: { conversationId: string; running: boolean; onLeave: () => void }) {
  const t = useTranslate()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const message = text.trim()
    if (!message || sending) return
    setSending(true)
    setError(null)
    try {
      // While a turn runs, the server queues the message like the main composer does.
      await sendMessage(conversationId, message)
      setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }
  return (
    <form className="wall-tile-composer" onSubmit={submit}>
      <input value={text} onChange={(event) => setText(event.target.value)} placeholder={t(running ? 'wall.composer.queue' : 'wall.composer.placeholder')}
        aria-label={t('wall.composer.label')} autoFocus
        onKeyDown={(event) => { if (event.key === 'Escape') { event.currentTarget.blur(); onLeave() } }} />
      {running ? <IconButton size="sm" type="button" label={t('wall.composer.stop')} onClick={() => void interruptConversation(conversationId)}><Square size={13} /></IconButton> : null}
      <IconButton size="sm" type="submit" label={t('wall.composer.send')} disabled={!text.trim() || sending} className="wall-tile-send"><ArrowUp size={14} /></IconButton>
      {error ? <p className="wall-tile-composer-error" role="alert">{error}</p> : null}
    </form>
  )
}
