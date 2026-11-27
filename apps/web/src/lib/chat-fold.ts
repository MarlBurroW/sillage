export * from '@sillage/protocol/chat-state'
import { isAwaitingUser, type ChatState, type ChatItem, type NoticeItem } from '@sillage/protocol/chat-state'
import { DETACHED_WORK_EVICTED_NOTICE, USAGE_LIMIT_RESUMED_NOTICE, USAGE_LIMIT_STOP_NOTICE } from '@sillage/protocol'
import { formatCount, locale, translate, type MessageKey } from './i18n'
import { describeUsageLimitStop, readUsageLimitDetails } from './usage-limit'

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


const GOAL_STATUS: Record<string, MessageKey> = {
  active: 'codex.goal.status.active',
  paused: 'codex.goal.status.paused',
  blocked: 'codex.goal.status.blocked',
  usageLimited: 'codex.goal.status.usageLimited',
  budgetLimited: 'codex.goal.status.budgetLimited',
  complete: 'codex.goal.status.complete',
}

/**
 * Codex notices written by Sillage itself. The server's English text stays as the fallback for
 * the journal, the API and older clients; the CLI's own texts (warnings, sub-agent messages,
 * deprecations) are shown as they are. Null for anything else.
 */
function codexNoticeText(item: NoticeItem): string | null {
  const details = (item.details ?? {}) as Record<string, unknown>
  const text = (key: string): string => {
    const value = details[key]
    return typeof value === 'string' ? value : ''
  }
  switch (item.code) {
    case 'codex_retry':
      return details.agent
        ? translate('codex.notice.subAgentRetry', { agent: text('agent'), message: text('message') })
        : translate('codex.notice.retry', { message: text('message') })
    case 'codex_model_changed': return translate('codex.notice.modelChanged', { model: text('model') })
    case 'codex_model_rerouted': return translate('codex.notice.modelRerouted', { from: text('fromModel'), to: text('toModel') })
    case 'codex_session_error': return translate('codex.notice.sessionError')
    case 'codex_safety_buffering': return translate('codex.notice.safetyBuffering')
    case 'codex_verification': return translate('codex.notice.verification')
    case 'codex_account_changed':
      return translate('codex.notice.accountChanged', { plan: text('planType') || text('authMode') || translate('codex.notice.signedOut') })
    case 'codex_event': return translate('codex.notice.event', { method: text('method') })
    case 'codex_translation_failed': return translate('codex.notice.translationFailed', { method: text('method'), reason: text('reason') })
    case 'codex_unsupported_request': return translate('codex.notice.unsupportedRequest', { method: text('method') })
    case 'codex_auto_review_denied': return text('rationale') || translate('codex.notice.autoReviewDenied')
    case 'codex_goal': {
      const status = text('status')
      const used = typeof details.tokensUsed === 'number' ? formatCount(details.tokensUsed) : '0'
      const usage = typeof details.tokenBudget === 'number'
        ? translate('codex.goal.budget', { used, budget: formatCount(details.tokenBudget) })
        : translate('codex.goal.tokens', { used })
      return status === 'cleared'
        ? translate('codex.notice.goalCleared', { objective: text('objective') })
        : translate('codex.notice.goal', { status: translate(GOAL_STATUS[status] ?? 'codex.goal.status.active'), objective: text('objective'), usage })
    }
    case 'enteredReviewMode': return translate('codex.notice.reviewStarted')
    case 'exitedReviewMode': return translate('codex.notice.reviewFinished')
    default: return null
  }
}

export function noticeText(item: NoticeItem): string {
  if (item.code === 'claude_session_writes_lost') return translate('claude.notice.sessionWritesLost')
  if (item.code === 'claude_permission_mode_adjusted') {
    const details = item.details as { requested?: string; actual?: string } | null
    return translate('claude.notice.permissionModeAdjusted', { requested: details?.requested ?? '', actual: details?.actual ?? '' })
  }
  if (item.code === 'project_move_fork') return translate('conversation.move.fork')
  if (item.code === 'project_move_failed') return translate('conversation.move.failed')
  if (item.code === 'project_moved' || item.code === 'project_move_pending') {
    const details = item.details as { project?: string } | null
    return translate(item.code === 'project_moved' ? 'conversation.move.done' : 'conversation.move.pending', { project: details?.project ?? '' })
  }
  if (item.code === 'antigravity_model_adjusted') return translate('antigravity.modelAdjusted.notice')
  if (item.code === 'copilot_model_adjusted') return translate('copilot.modelAdjusted.notice')
  if (item.code === 'grok_hook_blocked') return translate('grok.hookBlocked.notice')
  if (item.code === 'grok_hook_stopped') return translate('grok.hookStopped.notice')
  if (item.code === 'grok_model_unavailable' || item.code === 'grok_effort_unavailable') {
    const details = item.details as { requested?: string; model?: string | null; effort?: string | null } | null
    if (details?.requested && details.model && (item.code === 'grok_model_unavailable' || details.effort)) {
      return item.code === 'grok_model_unavailable'
        ? translate('grok.modelUnavailable.notice', { requested: details.requested, model: details.model })
        : translate('grok.effortUnavailable.notice', { requested: details.requested, model: details.model, effort: details.effort ?? '' })
    }
  }
  if (item.code === 'copilot_retry') return translate('copilot.retry.notice')
  if (item.code === 'copilot_hook_ran' || item.code === 'copilot_hook_failed') {
    const details = item.details as { hookType?: string; error?: string | null } | null
    const hook = details?.hookType ?? ''
    if (item.code === 'copilot_hook_ran') return translate('copilot.hookRan.notice', { hook })
    return details?.error ? translate('copilot.hookFailed.notice', { hook, error: details.error }) : translate('copilot.hookFailedBare.notice', { hook })
  }
  if (item.code === 'copilot_auto_model') {
    const details = item.details as { model?: string } | null
    return translate('copilot.autoModel.notice', { model: details?.model ?? '' })
  }
  const codex = codexNoticeText(item)
  if (codex !== null) return codex
  if (item.code === 'antigravity_account_signed_out') return translate('antigravity.logout.notice')
  if (item.code === 'portable_fork') return translate('antigravity.fork.notice')
  if (item.code === 'additional_directories_unsupported') return translate('antigravity.directories.notice')
  if (item.code === 'antigravity_sandbox_unavailable') return translate('antigravity.sandbox.notice')
  if (item.code === USAGE_LIMIT_RESUMED_NOTICE) return translate('usageLimit.notice.resumed')
  if (item.code === DETACHED_WORK_EVICTED_NOTICE) {
    const details = item.details as { limit?: number } | null
    return translate('session.notice.detachedWorkEvicted', { limit: String(details?.limit ?? '') })
  }
  if (item.code === USAGE_LIMIT_STOP_NOTICE) {
    const details = readUsageLimitDetails(item.details)
    return details ? `${translate('usageLimit.notice.title')} · ${describeUsageLimitStop(details)}` : item.text
  }
  const value = item.translation
  if (!value) return item.text
  if (value.key === 'compaction') return describeCompaction(value.pre, value.post)
  return translate(value.key, value)
}
