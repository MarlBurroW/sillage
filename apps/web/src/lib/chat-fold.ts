export * from '@sillage/protocol/chat-state'
import { isAwaitingUser, type ChatState, type ChatItem, type NoticeItem } from '@sillage/protocol/chat-state'
import { locale, translate } from './i18n'

/** Tokens in thousands, below which extra precision adds no useful information. */
function thousands(tokens: number): string {
  return `${Math.round(tokens / 1000)} k`
}

/**
 * Exact token count, grouped according to locale. Unlike `thousands`, which conveys size at a
 * glance, a moving counter is read repeatedly and its changing value conveys activity. Rounding to
 * thousands leaves it at 0 k before jumping to 1 k: accurate, but motionless and therefore no proof
 * of progress.
 */
function exactTokens(tokens: number): string {
  return tokens.toLocaleString(locale())
}

/**
 * What compaction actually freed, limited to what the CLI reports: Claude provides both sizes;
 * Codex provides neither.
 */
function describeCompaction(preTokens: number | null, postTokens: number | null): string {
  if (preTokens === null) return translate('activity.compaction.done')
  if (postTokens === null) {
    return translate('activity.compaction.doneWithPre', { tokens: thousands(preTokens) })
  }
  return translate('activity.compaction.doneWithBoth', {
    pre: thousands(preTokens),
    post: thousands(postTokens),
  })
}

/**
 * What the agent is doing, or null when there is nothing to report. Derived solely from the log,
 * like the rest of the display, so it remains accurate after reload without parallel state. A
 * pending permission request returns nothing because the request itself provides the information.
 */
export function describeActivity(state: ChatState): string | null {
  // Check compaction before the turn: menu-triggered compaction does not always open a turn, and
  // takes precedence when both coexist. The reported size is the pre-compaction size, the only one
  // known until completion.
  if (state.compacting) {
    return state.context
      ? translate('activity.compacting.tokens', { tokens: thousands(state.context.usedTokens) })
      : translate('activity.compacting')
  }
  if (!state.turnRunning) return null

  // The counter takes precedence over the last thread item: it is populated only during active
  // reasoning and says more than a bare Thinking label inferred from a completed tool. It is also
  // the only sign of life when the model hides its text.
  if (state.thinkingTokens !== null) {
    return translate('activity.thinking.tokens', { tokens: exactTokens(state.thinkingTokens) })
  }

  return activityOf(state.items, null)
}

/**
 * The thread author's activity inferred from its latest item. `thread` identifies the author:
 * `null` for the main agent, the spawning call for a subagent. Without this filter a busy subagent
 * would make the main thread claim to search files while it is waiting for the report.
 */
export function activityOf(items: ChatItem[], thread: string | null): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (!item) continue
    if ((item.kind === 'tool' || item.kind === 'message') && item.parentToolCallId !== thread) {
      continue
    }

    if (isAwaitingUser(item)) return null
    if (
      item.kind === 'permission' ||
      item.kind === 'question' ||
      item.kind === 'elicitation' ||
      item.kind === 'plan'
    ) {
      return translate('message.thinking.label')
    }
    if (item.kind === 'tool') {
      return item.status === 'running'
        ? translate('activity.toolRunning', { name: item.name })
        : translate('message.thinking.label')
    }
    if (item.kind === 'message') {
      if (item.role === 'user') return translate('message.thinking.label')
      if (item.streamingText) return translate('activity.writing')
      return translate('message.thinking.label')
    }
  }

  return translate('message.thinking.label')
}


export function noticeText(item: NoticeItem): string {
  if (item.code === 'antigravity_model_adjusted') return translate('antigravity.modelAdjusted.notice')
  if (item.code === 'antigravity_account_signed_out') return translate('antigravity.logout.notice')
  if (item.code === 'portable_fork') return translate('antigravity.fork.notice')
  if (item.code === 'additional_directories_unsupported') return translate('antigravity.directories.notice')
  if (item.code === 'antigravity_sandbox_unavailable') return translate('antigravity.sandbox.notice')
  const value = item.translation
  if (!value) return item.text
  if (value.key === 'compaction') return describeCompaction(value.pre, value.post)
  return translate(value.key, value)
}
