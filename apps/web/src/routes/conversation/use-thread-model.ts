import { useEffect, useMemo, useState } from 'react'
import type { AgentConfig, ConversationDto } from '@sillage/protocol'
import { appliedPermissionLabel } from '../../components/chat/agent-settings'
import { buildBackground, type BackgroundWork } from '../../lib/background'
import { useClaudeAccounts } from '../../lib/claude-accounts'
import { useTranslate } from '../../lib/i18n'
import { buildLoops, type ArmedLoop } from '../../lib/loops'
import { buildSignals } from '../../lib/signals'
import { buildSubAgents, type SubAgent } from '../../lib/subagents'
import { buildRows } from '../../lib/tool-rows'
import { useRunningToolLabel } from '../../lib/tool-style'
import { buildTurns } from '../../lib/turns'
import { usageAccountOf } from '../../lib/usage'
import type { ChatStream } from '../../lib/use-chat-stream'
import { workflowTasksByToolCall } from '../../lib/workflows'
import type { useAgentModels } from '../../lib/agents'

/** Singleton: recreating an empty list on every render would rerender the panel. */
const NO_BACKGROUND: BackgroundWork[] = []
const NO_LOOPS: ArmedLoop[] = []

/** Infrequent enough for minute-level age display, frequent enough to stay truthful. */
const TICK_MS = 30_000

function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [active])

  return now
}

/** Everything the screen derives from the folded journal: rows, turns, agents and running work. */
export function useThreadModel(stream: ChatStream) {
  const turns = useMemo(() => buildTurns(stream.state.items), [stream.state.items])
  const rows = useMemo(() => buildRows(stream.state.items, null, stream.state.turnRunning), [stream.state.items, stream.state.turnRunning])
  const runningTool = useRunningToolLabel()
  const subAgents = useMemo(
    () => buildSubAgents(stream.state.items, stream.state.tasks, runningTool),
    [stream.state.items, stream.state.tasks, runningTool],
  )
  /**
   * Same caveat as background work below: a cold session runs nothing, so a workflow the journal
   * never saw end must not keep claiming running agents.
   */
  const workflowTasks = useMemo(
    () => workflowTasksByToolCall(stream.state.tasks, stream.warm === false),
    [stream.state.tasks, stream.warm],
  )
  const runningSubAgents = useMemo(
    () => subAgents.filter((agent) => agent.status === 'running'),
    [subAgents],
  )
  /**
   * The journal may retain background work no process runs anymore: an abruptly killed daemon
   * cannot write the session-end event. Cold sessions have no process and thus no background
   * work, regardless of the thread.
   */
  const background = useMemo(
    () => (stream.warm === false ? NO_BACKGROUND : buildBackground(stream.state)),
    [stream.warm, stream.state],
  )
  /** Same reason as background work: scheduled tasks run only while the CLI is alive. */
  const loops = useMemo(
    () => (stream.warm === false ? NO_LOOPS : buildLoops(stream.state)),
    [stream.warm, stream.state],
  )
  /**
   * Periodic wakeup keeps last-loop-wakeup age current. Without armed loops no signal depends
   * on time, so the timer stays stopped.
   */
  const now = useTicker(loops.length > 0)

  return { turns, rows, subAgents, workflowTasks, runningSubAgents, background, loops, now }
}

/** Account shown in usage details, and the signal rows of the header and composer. */
export function useConversationSignals({
  conversation,
  config,
  catalog,
  stream,
  runningSubAgents,
  background,
  loops,
  now,
}: {
  conversation: ConversationDto | undefined
  config: AgentConfig | null
  catalog: ReturnType<typeof useAgentModels>['data']
  stream: ChatStream
  runningSubAgents: SubAgent[]
  background: BackgroundWork[]
  loops: ArmedLoop[]
  now: number
}) {
  const t = useTranslate()
  // The catalog describes CLI login; conversations using an additional account's API
  // key are usage-billed, where a monetary amount does make sense.
  const { data: claudeAccounts } = useClaudeAccounts(conversation?.agent === 'claude')
  const accountKind = claudeAccounts?.accounts.find((entry) => entry.id === usageAccountOf(config))?.kind ?? null
  const billingAccount =
    accountKind === 'apiKey'
      ? { subscriptionType: null, organization: null, billedBySubscription: false }
      : catalog?.account
  /**
   * Permission mode still applied by the CLI when it differs from the chosen one. Otherwise
   * null, with no signal to display.
   */
  const pendingPermission = useMemo(
    () => (config ? appliedPermissionLabel(config, stream.appliedConfig, t) : null),
    [config, stream.appliedConfig, t],
  )
  const signals = useMemo(
    () =>
      buildSignals({
        status: stream.status,
        connected: stream.connected,
        subAgents: runningSubAgents,
        background,
        loops,
        queued: stream.state.queued,
        pending: pendingPermission,
        now,
      }),
    [
      stream.status,
      stream.connected,
      runningSubAgents,
      background,
      loops,
      stream.state.queued,
      pendingPermission,
      now,
    ],
  )

  return { billingAccount, signals }
}
