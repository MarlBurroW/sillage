import { useEffect, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AgentConfig, AgentKind, ConversationDto, UsageWindow, WorktreeStatusDto } from '@sillage/protocol'
import type { ChatState, ContextState } from './chat-fold'
import type { BackgroundWork } from './background'
import { useConversationStats } from './conversation-stats'
import { usePreviews } from './previews'
import { sessionVersionGap } from './session-version'
import type { StatusItem, StatusItemKey } from './status-bar'
import type { SubAgent } from './subagents'
import { useAgentUsage, usageAccountOf } from './usage'
import { useConversationWorktree } from './worktrees'

/**
 * Everything the status line can show for one session, gathered from the folded journal and the
 * few queries behind it. Values a session does not have are null or empty: the line hides them.
 * The settings preview builds the same shape from sample values.
 */
export interface StatusData {
  agent: AgentKind
  /** A CLI process holds the session; null while unknown. */
  warm: boolean | null
  /** Quota windows of the session's account, as the CLI reports them. */
  windows: UsageWindow[]
  context: ContextState | null
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number }
  lastTurnTokens: number | null
  /** API-equivalent cost at public prices, null when unpriced. */
  costUsd: number | null
  subAgents: string[]
  background: string[]
  turnStartedAt: number | null
  model: string | null
  cliVersion: string | null
  versionGap: string | null
  worktree: WorktreeStatusDto | null
  files: number
  tools: { calls: number; errors: number } | null
  previews: { port: number; title: string | null }[]
}

/**
 * Claude's stream reports the window it is drawing on with each turn, fresher than the usage read
 * the server caches for five minutes: it overrides that window, or stands alone until the read
 * arrives.
 */
export function mergeLiveWindow(windows: UsageWindow[], live: ChatState['rateLimit']): UsageWindow[] {
  if (!live || live.utilization === null || live.type === 'overage') return windows
  const fresh = { utilization: live.utilization, resetsAt: live.resetsAt }
  if (windows.some((window) => window.id === live.type)) {
    return windows.map((window) => (window.id === live.type ? { ...window, ...fresh } : window))
  }
  return [...windows, { id: live.type, label: live.type, ...fresh }]
}

export function useStatusData({ conversation, stream, config, runningSubAgents, background, items }: {
  conversation: ConversationDto
  /** The conversation's stream (`useChatStream`): its folded state and whether a process holds it. */
  stream: { state: ChatState; warm: boolean | null }
  config: AgentConfig | null
  runningSubAgents: SubAgent[]
  background: BackgroundWork[]
  items: StatusItem[]
}): StatusData {
  const state = stream.state
  const shown = useMemo(() => new Set<StatusItemKey>(items.filter((item) => item.on).map((item) => item.key)), [items])
  // Each query runs only for an item on the line: a reading nobody shows costs nothing.
  const usage = useAgentUsage(conversation.agent, shown.has('quota'), usageAccountOf(config))
  const stats = useConversationStats(conversation.id, shown.has('tools') || shown.has('cost'))
  const previews = usePreviews(shown.has('previews'))
  const worktree = useConversationWorktree(conversation)

  // Figures computed by the server move with each turn: refresh them when one ends, rather than
  // polling while nothing changes.
  const queryClient = useQueryClient()
  const wasRunning = useRef(state.turnRunning)
  useEffect(() => {
    if (wasRunning.current && !state.turnRunning) {
      void queryClient.invalidateQueries({ queryKey: ['conversation-stats', conversation.id] })
    }
    wasRunning.current = state.turnRunning
  }, [state.turnRunning, queryClient, conversation.id])

  const files = useMemo(() => new Set(state.editTurns.flatMap((turn) => turn.files.map((file) => file.path))).size, [state.editTurns])

  return {
    agent: conversation.agent,
    warm: stream.warm,
    windows: mergeLiveWindow(usage.data?.limitsAvailable ? usage.data.windows : [], state.rateLimit),
    context: state.context,
    tokens: { input: state.inputTokens, output: state.outputTokens, cacheWrite: state.cacheCreationTokens, cacheRead: state.cacheReadTokens },
    lastTurnTokens: state.lastTurnTokens ?? null,
    costUsd: stats.data?.costUsd ?? null,
    subAgents: runningSubAgents.map((agent) => agent.description || agent.type),
    background: background.map((work) => work.description),
    turnStartedAt: state.turnRunning ? (state.turnStartedAt ?? null) : null,
    model: state.model,
    cliVersion: state.cliVersion ?? null,
    versionGap: sessionVersionGap(conversation.agent, state.cliVersion),
    worktree,
    files,
    tools: stats.data ? { calls: stats.data.toolCalls, errors: stats.data.toolErrors } : null,
    previews: (previews.data?.targets ?? [])
      .filter((target) => target.conversationId === conversation.id && !target.hidden)
      .map((target) => ({ port: target.port, title: target.title })),
  }
}
