import type { RefObject } from 'react'
import type { ConversationDto, HandoffDto } from '@sillage/protocol'
import { BrowserActivity } from '../../components/browser/BrowserActivity'
import { ChatThread } from '../../components/chat/ChatThread'
import { ContinuationIntro } from '../../components/chat/ContinuationIntro'
import { HeldSessionMessages } from '../../components/chat/HeldSessionMessages'
import { NewsTicker } from '../../components/chat/NewsTicker'
import { PromptSuggestion } from '../../components/chat/PromptSuggestion'
import { QueuedMessages } from '../../components/chat/QueuedMessages'
import { TurnActivity } from '../../components/chat/TurnActivity'
import { PreviewActivity } from '../../components/preview/PreviewActivity'
import { Banner, EmptyState, cx } from '../../components/ui'
import type { MessageItem, TurnCheckpoint } from '../../lib/chat-fold'
import { useTranslate } from '../../lib/i18n'
import { showCheckpoint } from '../../lib/panel'
import type { ThreadWindow } from '../../lib/thread-window'
import type { ChatStream } from '../../lib/use-chat-stream'
import { WorkflowTasksContext, type workflowTasksByToolCall } from '../../lib/workflows'

/** Everything inside the scrolling thread: banners, earlier-history button, rows and live activity. */
export function ConversationThreadContent({
  conversationId,
  conversation,
  stream,
  placed,
  actionError,
  emptyThread,
  handoff,
  onStartContinuation,
  view,
  showEarlier,
  workflowTasks,
  mayCollapseTools,
  isOwner,
  canSteer,
  forking,
  onFork,
  flashed,
  turnAnchors,
  onRestoreCheckpoint,
  activity,
  concentration,
}: {
  conversationId: string
  conversation: ConversationDto
  stream: ChatStream
  placed: boolean
  actionError: string | null
  emptyThread: boolean
  handoff: { data: HandoffDto | undefined; error: Error | null }
  onStartContinuation: () => Promise<void>
  view: ThreadWindow
  showEarlier: () => void
  workflowTasks: ReturnType<typeof workflowTasksByToolCall>
  mayCollapseTools: boolean
  isOwner: boolean
  canSteer: boolean
  forking: boolean
  onFork: (message: MessageItem | null) => void
  flashed: string | null
  turnAnchors: RefObject<Map<string, HTMLElement>>
  onRestoreCheckpoint: (target: { checkpoint: TurnCheckpoint; undo: boolean }) => void
  activity: string | null
  concentration: boolean
}) {
  const t = useTranslate()

  return (
    <div
      className={cx(
        'sg-conversation-content mx-auto flex sg-conversation-width flex-col gap-3 p-3 md:p-6 @min-[40rem]:px-12',
        placed ? 'opacity-100 transition-opacity duration-200' : 'opacity-0',
      )}
    >
      {stream.error ? <Banner>{stream.error}</Banner> : null}
      {actionError ? <Banner>{actionError}</Banner> : null}

      {emptyThread && conversation.handoffFromId ? (
        handoff.data ? <ContinuationIntro key={conversation.id} text={handoff.data.text} canStart={isOwner}
          onStart={onStartContinuation} />
          : handoff.error ? <Banner>{handoff.error.message}</Banner>
            : <p className="text-sm text-ink-soft">{t('conversation.loading')}</p>
      ) : emptyThread ? (
        <EmptyState
          title={t('conversation.empty.title')}
          description={t('conversation.empty.description')}
        />
      ) : null}

      {view.hidden > 0 || stream.hasMore ? (
        <button
          type="button"
          onClick={showEarlier}
          disabled={stream.loadingOlder}
          className={cx(
            'surface mx-auto rounded-full border border-line px-3 py-1.5',
            'text-xs text-ink-soft transition-colors hover:text-ink',
          )}
        >
          {stream.loadingOlder ? t('journal.history.loading') : stream.hasMore ? t('journal.history.earlier') : t(
            view.hidden > 1
              ? 'conversation.thread.earlier.other'
              : 'conversation.thread.earlier.one',
            { count: view.hidden },
          )}
        </button>
      ) : null}

      <WorkflowTasksContext.Provider value={workflowTasks}>
        <ChatThread
          rows={view.rows}
          mayCollapseTools={mayCollapseTools}
          conversationId={conversationId}
          canDecide={isOwner}
          onFork={isOwner && !forking ? onFork : undefined}
          flashedId={flashed}
          anchors={turnAnchors}
          checkpoints={stream.state.checkpoints}
          onShowChanges={(checkpoint) => showCheckpoint(checkpoint.key)}
          onRestoreCheckpoint={isOwner && !stream.state.turnRunning ? (checkpoint, undo) => onRestoreCheckpoint({ checkpoint, undo }) : undefined}
        />
      </WorkflowTasksContext.Provider>

      {activity && !concentration ? <TurnActivity label={activity} /> : null}
      <BrowserActivity conversationId={conversationId} />
      <PreviewActivity conversationId={conversationId} />
      {stream.state.turnRunning && !concentration ? <NewsTicker key={conversationId} /> : null}

      {/* Below the indicator: what the agent has not read yet. */}
      <QueuedMessages
        conversationId={conversationId}
        messages={stream.state.queued}
        canCancel={isOwner}
        canSteer={canSteer}
      />

      <HeldSessionMessages
        conversationId={conversationId}
        messages={stream.state.heldSessionMessages}
        canDecide={isOwner}
      />

      {/*
       * CLI-predicted next message while nothing is sent or queued: a queued message
       * already answers the turn.
       */}
      {stream.state.suggestion && !stream.state.turnRunning && stream.state.queued.length === 0 ? (
        <PromptSuggestion text={stream.state.suggestion} disabled={!isOwner} />
      ) : null}
    </div>
  )
}
