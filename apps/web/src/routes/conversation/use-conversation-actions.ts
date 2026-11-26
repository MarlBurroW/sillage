import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { conversationPath } from '@sillage/protocol'
import type { MessageItem } from '../../lib/chat-fold'
import {
  compactConversation,
  conversationsKey,
  forkConversation,
  sendMessage,
  steerConversation,
} from '../../lib/conversations'
import { useTranslate } from '../../lib/i18n'
import { recordPerformance } from '../../lib/performance-diagnostics'

type Submit = (text: string, attachmentIds: string[], mentions: string[], skills: string[]) => Promise<void>

/**
 * The conversation's one-off actions: fork, compaction, sending, steering and composer commands.
 *
 * The page only offers them once the conversation has loaded: the guards on `conversationId`
 * never reject a real call, they replace the page's early return the hook cannot follow.
 */
export function useConversationActions({
  conversationId,
  projectId,
  flushConfig,
}: {
  conversationId: string | undefined
  projectId: string | null | undefined
  flushConfig: () => Promise<unknown>
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [forking, setForking] = useState(false)
  /** Message offered for forking: too uncommon an action to trigger directly. */
  const [forkTarget, setForkTarget] = useState<MessageItem | null>(null)
  /** Failure of a one-off conversation action: fork or compaction. */
  const [actionError, setActionError] = useState<string | null>(null)
  const [compacting, setCompacting] = useState(false)

  /**
   * Fork the conversation just before a message.
   *
   * Cut at `seq - 1`: retain everything before it and return the cut message to the composer
   * for rephrasing. That is the purpose of a fork; keeping it in history would defeat it.
   *
   * Stable across renders: passed directly to user bubbles, a recreated function breaks
   * memoization and redraws the whole thread on every scroll. Search highlights, which retain
   * ranges on those text nodes, were lost in the process.
   */
  const fork = useCallback(
    async (message: MessageItem) => {
      if (!conversationId) return

      setForkTarget(null)
      setForking(true)
      setActionError(null)
      try {
        const branch = await forkConversation(conversationId, message.seq - 1)
        void queryClient.invalidateQueries({ queryKey: ['conversations'] })
        const draft = message.blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n\n')
        navigate(conversationPath(branch), { state: { draft } })
      } catch (err) {
        setActionError(err instanceof Error ? err.message : t('conversation.fork.error'))
      } finally {
        setForking(false)
      }
    },
    [conversationId, navigate, queryClient, t],
  )

  const compact = async () => {
    if (!conversationId) return
    setCompacting(true)
    setActionError(null)
    try {
      await compactConversation(conversationId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('conversation.compact.error'))
    } finally {
      setCompacting(false)
    }
  }

  /**
   * Commands Sillage executes itself, launched from the composer.
   *
   * Errors return to the input, restoring the command verbatim, rather than the page banner:
   * the action starts in the input and is retried there.
   */
  const runCommand = async (name: string) => {
    if (!conversationId) return
    await flushConfig()
    if (name === 'compact') await compactConversation(conversationId)
  }

  const send: Submit = async (text, attachmentIds, mentions, skills) => {
    if (!conversationId || projectId === undefined) return
    // Desktop diagnostics split a slow send between settings and delivery: Windows reports of
    // seconds after Enter could not be located without it.
    const started = performance.now()
    await flushConfig()
    const configMs = performance.now() - started
    await sendMessage(conversationId, text, attachmentIds, mentions, skills)
    recordPerformance('send', { configMs, postMs: performance.now() - started - configMs })
    void queryClient.invalidateQueries({ queryKey: conversationsKey(projectId) })
  }

  const steer: Submit = async (text, attachmentIds, mentions, skills) => {
    if (!conversationId) return
    await flushConfig()
    await steerConversation(conversationId, text, attachmentIds, mentions, skills)
  }

  return {
    forking,
    forkTarget,
    setForkTarget,
    actionError,
    compacting,
    fork,
    compact,
    runCommand,
    send,
    steer,
  }
}
