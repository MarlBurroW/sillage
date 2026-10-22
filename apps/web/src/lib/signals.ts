import type { ConversationStatus } from '@sillage/protocol'
import type { BackgroundWork } from './background'
import type { QueuedMessage } from './chat-fold'
import { translate } from './i18n'
import { describeSchedule, formatAgo, type ArmedLoop } from './loops'
import { subAgentLabel, type SubAgent } from './subagents'

/**
 * Conversation activity in one shared form, displayed by the header, composer, and conversation
 * list at their own density. One derivation for three surfaces: previously each chose content and
 * colors independently, so identical purple background-task indicators could disagree. Families
 * describe what the reader should do, not the originating feature. This bounds the palette: signals
 * in one family differ by icon and label, never color.
 */

export type SignalFamily =
  /** Something is running now. */
  | 'working'
  /** Nothing is running, but the conversation will restart by itself. */
  | 'scheduled'
  /** The agent or connection needs something from the user. */
  | 'awaiting'
  /** A state invalidating the displayed information. */
  | 'broken'

export type SignalKind =
  | 'subagents'
  | 'background'
  | 'running'
  | 'loop'
  | 'awaiting'
  | 'queued'
  | 'interrupted'
  | 'offline'
  | 'error'
  | 'pending'

export const SIGNAL_FAMILY: Record<SignalKind, SignalFamily> = {
  subagents: 'working',
  background: 'working',
  running: 'working',
  loop: 'scheduled',
  awaiting: 'awaiting',
  queued: 'awaiting',
  interrupted: 'awaiting',
  offline: 'awaiting',
  pending: 'awaiting',
  error: 'broken',
}

export interface Signal {
  kind: SignalKind
  family: SignalFamily
  /** Translated label displayed when space permits. */
  label: string
  /** Additional tooltip information, empty when the label is sufficient. */
  detail: string
}

/**
 * Order by family rather than feature: colors remain grouped and the row reads from common to
 * severe left to right.
 */
const ORDER: SignalKind[] = [
  'running',
  'subagents',
  'background',
  'loop',
  'queued',
  'awaiting',
  'pending',
  'interrupted',
  'offline',
  'error',
]

export interface SignalInput {
  status: ConversationStatus
  connected: boolean
  subAgents: SubAgent[]
  background: BackgroundWork[]
  loops: ArmedLoop[]
  queued: QueuedMessage[]
  /**
   * Configuration still applied by the CLI while another is saved and displayed. Empty when both
   * agree, meaning no restart is pending.
   */
  pending: string | null
  /**
   * Render timestamp used for wakeup ages. Pass it in rather than reading time here: reading the
   * clock would make derivation nondeterministic and prevent memoization.
   */
  now: number
}

export function buildSignals(input: SignalInput): Signal[] {
  const found = new Map<SignalKind, Signal>()
  const add = (kind: SignalKind, label: string, detail = '') => {
    found.set(kind, { kind, family: SIGNAL_FAMILY[kind], label, detail })
  }

  if (input.status === 'running') add('running', translate('signal.running'))

  if (input.subAgents.length > 0) {
    add(
      'subagents',
      plural('signal.subagents', input.subAgents.length),
      input.subAgents
        .map((agent) =>
          agent.activity ? `${subAgentLabel(agent)} · ${agent.activity}` : subAgentLabel(agent),
        )
        .join('\n'),
    )
  }

  if (input.background.length > 0) {
    add(
      'background',
      plural('signal.background', input.background.length),
      input.background
        .map((task) => (task.activity ? `${task.description} · ${task.activity}` : task.description))
        .join('\n'),
    )
  }

  if (input.loops.length > 0) {
    add('loop', plural('signal.loop', input.loops.length), describeLoops(input.loops, input.now))
  }

  if (input.queued.length > 0) {
    add(
      'queued',
      plural('signal.queued', input.queued.length),
      input.queued.map((message) => message.text).join('\n'),
    )
  }

  // Before status-derived states: what governs the turn takes precedence over what the turn is doing.
  if (input.pending) {
    add('pending', translate('signal.pending'), translate('signal.pending.detail', { value: input.pending }))
  }

  if (input.status === 'awaiting_input') add('awaiting', translate('signal.awaiting'))
  if (input.status === 'interrupted') add('interrupted', translate('signal.interrupted'))
  if (input.status === 'error') add('error', translate('signal.error'))

  // Ambient state becomes a signal only when something fails: a working connection has nothing to
  // report, while a broken one invalidates the page's displayed data.
  if (!input.connected) add('offline', translate('signal.offline'), translate('signal.offline.detail'))

  return sorted(found)
}

/**
 * Signals for an unopened conversation. The list has no log to fold, only counters from the status
 * stream. Derive the same signals without details that no tooltip would show on a six-pixel row
 * anyway.
 */
export function buildSidebarSignals(input: {
  status: ConversationStatus
  background: number
  loops: number
}): Signal[] {
  const found = new Map<SignalKind, Signal>()
  const add = (kind: SignalKind, label: string) => {
    found.set(kind, { kind, family: SIGNAL_FAMILY[kind], label, detail: '' })
  }

  if (input.status === 'running') add('running', translate('signal.running'))
  if (input.status === 'awaiting_input') add('awaiting', translate('signal.awaiting'))
  if (input.status === 'error') add('error', translate('signal.error'))
  if (input.status === 'interrupted') add('interrupted', translate('signal.interrupted'))
  if (input.background > 0) add('background', plural('signal.background', input.background))
  if (input.loops > 0) add('loop', plural('signal.loop', input.loops))

  return sorted(found)
}

function sorted(found: Map<SignalKind, Signal>): Signal[] {
  return ORDER.flatMap((kind) => {
    const signal = found.get(kind)
    return signal ? [signal] : []
  })
}

/**
 * The catalog has no plural rules: select at the call site as elsewhere. Restrict prefixes to keys
 * with both `.one` and `.many` variants so the compiler checks concatenation.
 */
type PluralPrefix =
  | 'signal.subagents'
  | 'signal.background'
  | 'signal.loop'
  | 'signal.queued'
  | 'conversation.loop.iterations'

function plural(prefix: PluralPrefix, count: number): string {
  return translate(`${prefix}.${count > 1 ? 'many' : 'one'}`, { count })
}

/** Cadence, counted wakeups, and latest wakeup age, one loop per line. */
function describeLoops(loops: ArmedLoop[], now: number): string {
  return loops
    .map((loop) => {
      const cadence = loop.recurring
        ? (describeSchedule(loop.schedule) ?? loop.schedule)
        : translate('conversation.loop.oneShot')
      const fired =
        loop.lastFiredAt === null
          ? translate('conversation.loop.pending')
          : translate('conversation.loop.lastFired', { ago: formatAgo(now - loop.lastFiredAt) })
      const runs = plural('conversation.loop.iterations', loop.iterations)
      return `${cadence} · ${runs} · ${fired}\n${loop.prompt}`
    })
    .join('\n\n')
}

/**
 * Signal best describing the current state, or null when there is nothing to report. Used where
 * only a dot fits. Exclude loops: they describe future activity and can appear alongside this
 * signal rather than competing with it.
 */
const PRESENT_PRIORITY: SignalFamily[] = ['broken', 'awaiting', 'working']

export function presentSignal(signals: Signal[]): Signal | null {
  for (const family of PRESENT_PRIORITY) {
    const match = signals.find((signal) => signal.family === family)
    if (match) return match
  }
  return null
}
