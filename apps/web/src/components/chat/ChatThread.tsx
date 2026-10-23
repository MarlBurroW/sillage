import { DiffCard } from './DiffCard'
import { Fragment, type RefObject } from 'react'
import { noticeText, type MessageItem, type TurnCheckpoint } from '../../lib/chat-fold'
import type { ChatRow } from '../../lib/tool-rows'
import { translate, translateError, useTranslate } from '../../lib/i18n'
import { Banner, cx } from '../ui'
import { ElicitationPrompt } from './ElicitationPrompt'
import { MessageBubble } from './MessageBubble'
import { PermissionPrompt } from './PermissionPrompt'
import { PlanReview } from './PlanReview'
import { PlanProgress } from './PlanProgress'
import { QuestionPrompt } from './QuestionPrompt'
import { TaskResult } from './TaskResult'
import { ToolCall, ToolCallGroup } from './ToolCall'
import { TurnChanges } from './TurnChanges'

/**
 * Additional content beneath translated Sillage error titles. Full messages serve log readers
 * without catalogs (scheduler, webhooks) but would repeat the title; older logs contain French
 * text.
 */
const ERROR_DETAILS: Record<string, (message: string) => string> = {
  daemon_restarted: () => '',
  // Only the final parenthesized reason adds information. Translate Sillage-authored reasons;
  // preserve native CLI errors.
  config_applied_by_restart: (message) => {
    const reason = /\(([^]*)\)\.?$/.exec(message)?.[1] ?? message
    return LIVE_CHANGE_REFUSED.has(reason) ? translate('error.config_applied_by_restart.live') : reason
  },
}
/** restartForConfig reason in English matching earlier logs. */
const LIVE_CHANGE_REFUSED = new Set(['the CLI cannot apply this change live', 'le CLI ne gère pas ce changement à chaud'])

/**
 * Conversation thread shared by main agent and subagents: identical events should not require two
 * rendering implementations. Page additions (turn anchors, highlighting, forks) are optional
 * because panels offer no rail or fork button.
 */
export function ChatThread({
  rows,
  conversationId,
  canDecide = false,
  mayCollapseTools = true,
  onFork,
  flashedId = null,
  anchors,
  checkpoints,
  onShowChanges,
  onRestoreCheckpoint,
}: {
  rows: ChatRow[]
  conversationId: string
  /**
   * Allow responding to prompts. False by default, including read-only shared conversations, where
   * prompts render without actions.
   */
  mayCollapseTools?: boolean
  canDecide?: boolean
  /** Absent when threads cannot fork because subagents have no independent entity. */
  onFork?: (message: MessageItem) => void
  /** Recently reached message highlighted briefly for orientation. */
  flashedId?: string | null
  /** User-message positions kept current for turn navigation. */
  anchors?: RefObject<Map<string, HTMLElement>>
  /** Turn checkpoints absent on subagent threads. */
  checkpoints?: TurnCheckpoint[]
  onShowChanges?: (checkpoint: TurnCheckpoint) => void
  onRestoreCheckpoint?: (checkpoint: TurnCheckpoint) => void
}) {
  const t = useTranslate()

  // Place turn markers at their ends, before the next user message or after the final item.
  // Identify turns by their opening message.
  const byOpener = new Map<string, TurnCheckpoint>()
  for (const checkpoint of checkpoints ?? []) {
    if (checkpoint.openerId) byOpener.set(checkpoint.openerId, checkpoint)
  }
  let current: TurnCheckpoint | null = null
  const strip = (checkpoint: TurnCheckpoint | null) =>
    checkpoint && onShowChanges ? (
      <TurnChanges
        key={`checkpoint-${checkpoint.key}`}
        checkpoint={checkpoint}
        onShow={onShowChanges}
        onRestore={onRestoreCheckpoint}
      />
    ) : null

  return (
    <>
      {rows.map((row) => {
        if (row.kind === 'item' && row.item.kind === 'message' && row.item.role === 'user' && !row.item.parentToolCallId) {
          const closing = strip(current)
          current = byOpener.get(row.item.id) ?? null
          if (closing) {
            return (
              <Fragment key={`turn-${row.item.id}`}>
                {closing}
                {renderRow(row)}
              </Fragment>
            )
          }
        }
        return renderRow(row)
      })}
      {strip(current)}
    </>
  )

  function renderRow(row: ChatRow) {
        if (row.kind === 'tool-group') {
          return <ToolCallGroup key={row.key} tools={row.tools} complete={row.complete} mayCollapse={mayCollapseTools} conversationId={conversationId} />
        }
        if (row.kind === 'tool') {
          return <ToolCall key={row.key} tool={row.tool} conversationId={conversationId} />
        }

        const item = row.item
        switch (item.kind) {
          case 'message':
            // data-seq applies to both roles because search may target agent replies. Turn anchors
            // apply only to user messages delimiting navigation turns.
            return (
              <div
                key={item.id}
                data-seq={item.seq}
                className={cx(flashedId === item.id && 'sg-flash-turn')}
                ref={
                  anchors && item.role === 'user'
                    ? (node) => {
                        if (!node) return
                        anchors.current.set(item.id, node)
                        // Use a block body: Map.delete returns boolean while React requires cleanup functions returning nothing.
                        return () => {
                          anchors.current.delete(item.id)
                        }
                      }
                    : undefined
                }
              >
                <MessageBubble
                  message={item}
                  onFork={item.role === 'user' ? onFork : undefined}
                />
              </div>
            )
          case 'permission':
            return (
              <PermissionPrompt
                key={item.id}
                conversationId={conversationId}
                permission={item}
                canDecide={canDecide}
              />
            )
          case 'question':
            return (
              <QuestionPrompt
                key={item.id}
                conversationId={conversationId}
                item={item}
                canDecide={canDecide}
              />
            )
          case 'elicitation':
            return (
              <ElicitationPrompt
                key={item.id}
                conversationId={conversationId}
                item={item}
                canDecide={canDecide}
              />
            )
          case 'plan':
            return (
              <PlanReview
                key={item.id}
                conversationId={conversationId}
                item={item}
                canDecide={canDecide}
              />
            )
          case 'error': {
            // Translate only the code: CLI messages contain details catalogs cannot know, such as
            // quota reset times. Unknown codes have no title and rely on the message.
            const title = translateError(item.code, '')
            const detail = ERROR_DETAILS[item.code]
            const message = title && detail ? detail(item.message) : item.message
            return (
              <Banner key={item.id} tone={item.recoverable ? 'caution' : 'critical'}>
                {title ? <span className="font-medium">{title}</span> : null}
                {title && message ? <br /> : null}
                {message ? <span className="whitespace-pre-wrap break-words">{message}</span> : null}
              </Banner>
            )
          }
          case 'task':
            return <TaskResult key={item.id} item={item} />
          case 'plan_progress':
            return <PlanProgress key={item.id} item={item} />
          case 'diff':
            return <DiffCard key={item.id} item={item} conversationId={conversationId} />
          case 'notice':
            if (item.level) {
              return (
                <Banner key={item.id} tone={item.level === 'warning' ? 'caution' : 'info'}>
                  <span className="whitespace-pre-wrap break-words">{noticeText(item)}</span>
                  {item.details != null ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer">{t('notice.details')}</summary>
                      <pre className="mt-2 max-h-80 overflow-auto text-xs whitespace-pre-wrap break-words">
                        {typeof item.details === 'string' ? item.details : JSON.stringify(item.details, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </Banner>
              )
            }
            return (
              <div key={item.id} className="flex items-center gap-3 py-1">
                <span className="h-px flex-1 bg-line" />
                <span className="text-[0.6875rem] text-ink-faint">{noticeText(item)}</span>
                <span className="h-px flex-1 bg-line" />
              </div>
            )
        }
  }
}
