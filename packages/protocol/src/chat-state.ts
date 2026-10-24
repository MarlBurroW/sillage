import type {
  AgentQuestion,
  AgentSkillDto,
  BackgroundTask,
  CheckpointFile,
  ContentBlock,
  ElicitationField,
  ElicitationValue,
  EventBodyRef,
  Loop,
  McpServerStatus,
  PermissionOption,
  PlanFollowUpOption,
  SillageEvent,
  SlashCommandDto,
  ToolPresentation,
} from './index.js'

/** Fold the event log into the display model (invariant I2: rendering is a pure function of the log, replayable from scratch).
 *
 * All displayed information must originate here. If UI state cannot be derived from this function, the server is missing an event; the client does not need another state variable. */

export interface MessageItem {
  kind: 'message'
  id: string
  role: 'user' | 'assistant'
  /** Timestamp of the first event that created the message, in milliseconds. */
  ts: number
  /** Position in the log, the only reliable boundary for forking the thread. */
  seq: number
  blocks: ContentBlock[]
  /** Incoming text, cleared when the corresponding message arrives. */
  streamingText: string
  streamingThinking: string
  /** Call that spawned the subagent authoring this message. Null for the main agent. */
  parentToolCallId: string | null
}

export interface ToolItem {
  /** Human-facing action supplied by the harness, separate from tool arguments. */
  title?: string | null
  kind: 'tool'
  id: string
  /** Call start time: the only basis for a running timer. */
  ts: number
  name: string
  input: unknown
  output: unknown
  inputRef?: EventBodyRef
  outputRef?: EventBodyRef
  presentation?: ToolPresentation
  /**
   * Actual output size when `output` is only a preview, otherwise null. History replay trims large
   * outputs; the card requests the full body when opened.
   */
  outputBytes: number | null
  status: 'running' | 'done' | 'failed' | 'interrupted'
  durationMs: number | null
  parentToolCallId: string | null
}

export interface PermissionItem {
  kind: 'permission'
  id: string
  toolName: string
  input: unknown
  suggestions: PermissionOption[]
  status: 'pending' | 'allowed' | 'denied' | 'expired'
  /** Wording supplied by the CLI, which knows why it is asking. Null if none is provided. */
  title: string | null
  description: string | null
}

/** An agent question, pending or already resolved. */
export interface QuestionItem {
  kind: 'question'
  id: string
  questions: AgentQuestion[]
  status: 'pending' | 'answered' | 'cancelled' | 'expired'
  /** Selected answers by question ID. Empty until answered. */
  answers: Record<string, string[]>
  blocking: boolean
}

/** Input requested by an MCP server. */
export interface ElicitationItem {
  kind: 'elicitation'
  id: string
  serverName: string
  mode: 'form' | 'url'
  message: string
  url: string | null
  fields: ElicitationField[]
  title: string | null
  status: 'pending' | 'accept' | 'decline' | 'cancel' | 'expired'
  content: Record<string, ElicitationValue>
}

/** A plan submitted for approval before execution. */
export interface PlanItem {
  kind: 'plan'
  id: string
  plan: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  /** Follow-up options supplied by the adapter; empty for logs predating this field. */
  followUpOptions: PlanFollowUpOption[]
  /** The selected option's `id`, opaque to the UI. */
  followUpMode: string | null
}

export interface ErrorItem {
  kind: 'error'
  id: string
  code: string
  message: string
  recoverable: boolean
}

/** A subtle thread marker with no content of its own (model change, resume). */
export interface NoticeItem {
  kind: 'notice'
  id: string
  text: string
  code?: string
  translation?:
    | { key: 'activity.modelChanged'; model: string }
    | { key: 'checkpoint.restored.notice'; written: number; deleted: number }
    | { key: 'activity.configRestartDeferred' }
    | { key: 'compaction'; pre: number | null; post: number | null }
  level?: 'info' | 'warning'
  details?: unknown
}

export interface PlanProgressItem {
  kind: 'plan_progress'
  id: string
  items: Extract<SillageEvent, { type: 'plan.updated' }>['items']
}

export interface DiffItem {
  kind: 'diff'
  id: string
  files: Extract<SillageEvent, { type: 'diff.updated' }>['files']
  patch?: string
  patchRef?: EventBodyRef
}

/**
 * Report from work the thread was no longer tracking. Only autonomous work receives one. A tracked
 * subagent already returns its result through the spawning call; repeating it here would display
 * the same result twice.
 */
export interface TaskItem {
  kind: 'task'
  id: string
  description: string
  status: 'completed' | 'failed' | 'stopped'
  summary: string
  durationMs: number | null
}

export type ChatItem = (
  | MessageItem
  | ToolItem
  | PermissionItem
  | QuestionItem
  | ElicitationItem
  | PlanItem
  | ErrorItem
  | NoticeItem
  | TaskItem
  | PlanProgressItem
  | DiffItem
) & { position?: number }

/** Whether an item awaits a user decision before the turn can resume. */
export function isAwaitingUser(item: ChatItem): boolean {
  if (item.kind === 'question' && !item.blocking) return false
  return (
    (item.kind === 'permission' ||
      item.kind === 'question' ||
      item.kind === 'elicitation' ||
      item.kind === 'plan') &&
    item.status === 'pending'
  )
}

/**
 * A message waiting for the current turn to end. Kept outside `items`: it appears after the
 * activity indicator to show that the agent is handling the content above it. Putting it in `items`
 * would force turn navigation and tool grouping to ignore it.
 */
export interface QueuedMessage {
  queueId: string
  text: string
  attachmentCount: number
}

/**
 * A message from another session held by Sillage instead of restarting this one. Outside `items`
 * for the same reason as queued messages: the agent has not read it. `text` is the full envelope,
 * read using `parseSessionMessage`.
 */
export interface HeldSessionMessage {
  messageId: string
  text: string
  reason: 'loop' | 'rate'
}

/** A file touched by the agent during a turn. */
export interface EditedFile {
  path: string
  action: 'created' | 'modified' | 'deleted'
  /**
   * Calls that touched this file during the turn, in order. The file appears once, but agents often
   * revisit it over several passes: retaining every call lets us display every edit; retaining only
   * the last would erase earlier edits.
   */
  toolCallIds: string[]
}

/**
 * Edits grouped by turn, in turn order. Grouped by user message rather than `turn.started`: the
 * request gives a series of edits its meaning, and the order of these two events varies by CLI.
 */
export interface EditTurn {
  seq?: number
  /** ID of the user message that opened the turn. */
  id: string
  ts: number
  /** Message prefix used to identify the turn in the list. */
  label: string
  files: EditedFile[]
}

/**
 * Turn checkpoint: changes made to the repository and the information needed to restore it.
 * Attached to the opening user message, like `EditTurn`, since that is where it appears in the
 * thread. `openerId` remains null until that message arrives: the log records the before snapshot
 * first, then the message.
 */
export interface TurnCheckpoint {
  key: string
  /** Position of the before snapshot in the log, immediately before the turn's message. */
  seq: number
  openerId: string | null
  /** Opening message text: labels the turn and seeds the fork draft. */
  openerText: string
  status: 'pending' | 'ready' | 'failed'
  files: CheckpointFile[]
  truncated: boolean
  excluded: number
  reason: string | null
  /** True once the workspace has been restored to its state before this turn. */
  restored: boolean
}

/** Latest known quota state reported by the CLI. */
export interface RateLimitState {
  type: string
  status: 'allowed' | 'allowed_warning' | 'rejected'
  utilization: number | null
  resetsAt: number | null
}

/** Context window usage reported by the CLI. */
export interface ContextState {
  usedTokens: number
  maxTokens: number
  ratio: number
}

export interface ChatState {
  planId: string | null
  diffId: string | null
  items: ChatItem[]
  queued: QueuedMessage[]
  heldSessionMessages: HeldSessionMessage[]
  lastSeq: number
  /** Equivalent API cost. Not billed on subscription accounts. */
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  model: string | null
  rateLimit: RateLimitState | null
  context: ContextState | null
  /** Track turn completion to display a reliable activity indicator. */
  turnRunning: boolean
  /**
   * Size of the current reasoning, whether revealed or hidden. A non-null value means the agent is
   * thinking now: any other sign of progress resets it to null, so the indicator never claims
   * reasoning while text is being written or a tool is running.
   */
  thinkingTokens: number | null
  /** Edit history by turn, derived from `file.edited`. */
  editTurns: EditTurn[]
  /** Checkpoints, one per captured turn, in turn order. */
  checkpoints: TurnCheckpoint[]
  /**
   * Compaction is underway. Separate from `turnRunning`: during compaction the agent rewrites its
   * memory rather than answering. Labeling it as reasoning would imply an answer that will never
   * arrive.
   */
  compacting: boolean
  /**
   * Work the CLI continues outside the turn: workflows, background commands, and backgrounded
   * subagents. Replaced on every `background.updated`, never appended to: this is a snapshot, not a
   * sequence of starts and stops. A nonempty list while `turnRunning` is false describes the
   * previously invisible state where the agent has yielded but files are still changing.
   */
  background: BackgroundTask[]
  /**
   * Armed loops from the latest end-of-turn inventory. Replaced rather than appended to, like
   * `background`: the CLI reports neither loop creation nor completion, only an inventory.
   */
  loops: Loop[]
  /**
   * Session MCP servers reported by the CLI. Replaced rather than appended to, like `background`
   * and `loops`: the CLI publishes the full inventory on every change. Includes servers from its
   * own configuration, marked `external`; users must be able to see failures even if they never
   * declared those servers in Sillage.
   */
  mcp: McpServerStatus[]
  /**
   * Slash commands recognized by the session, already filtered by the server to those usable here.
   * Replaced rather than appended to, like `mcp`: the CLI republishes the full list. Empty before
   * any session starts and for CLIs that do not publish commands.
   */
  commands: SlashCommandDto[]
  /**
   * Skills provided by the CLI, referenced with `$`. Replaced rather than appended to, like
   * `commands`. Published only by Codex: Claude includes its skills among commands.
   */
  skills: AgentSkillDto[]
  /**
   * The next message predicted by the CLI after the latest turn. Replaced rather than appended to:
   * a suggestion applies only to the next turn. Cleared whenever a turn starts, including one
   * opened by a different message. Also null for CLIs without suggestions.
   */
  suggestion: string | null
  /**
   * Observed wakeups by reinjected instruction: count and latest timestamp. Kept separately from
   * `loops` to survive list replacement. Keyed by instruction for lack of a better identifier: the
   * CLI reinjects only text without its task origin. Two loops sharing their first 200 characters
   * would combine counts, which is still preferable to counting nothing.
   */
  loopFires: Map<string, { count: number; lastAt: number }>
  /**
   * What the CLI reports about each registered task from start to stop. Separate from `background`:
   * that snapshot says which tasks are alive, while this table describes them. Also retains
   * completed tasks whose reports remain visible.
   */
  tasks: Map<string, TaskState>
}

/** Task progress described by `task.*` events. */
export interface TaskState {
  id: string
  /** Spawning tool call, null when the harness started it independently. */
  toolCallId: string | null
  kind: string
  description: string
  /** Current activity, null until the first progress report. */
  activity: string | null
  lastTool: string | null
  toolUses: number
  totalTokens: number
  durationMs: number
  /**
   * True once work continues after the thread stops tracking it: its tool call has returned or it
   * never had one. This distinguishes workflows from ordinary subagents, both reported in the same
   * list. Once set, it stays set: autonomous work must report completion in the thread even if the
   * latest snapshot has already removed it.
   */
  unattended: boolean
  /** True once its report arrives; the task can then be taken at its word. */
  done: boolean
  /**
   * How it ended, null while running. Separate from `done` because detached work does not always
   * finish by itself: stopped with its session, it has ended without succeeding. The subagent row
   * must say so rather than show normal completion of its spawning call.
   */
  outcome: 'completed' | 'failed' | 'stopped' | null
}

export function emptyChatState(): ChatState {
  return {
    planId: null,
    diffId: null,
    items: [],
    queued: [],
    heldSessionMessages: [],
    lastSeq: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    model: null,
    rateLimit: null,
    context: null,
    editTurns: [],
    checkpoints: [],
    turnRunning: false,
    thinkingTokens: null,
    compacting: false,
    background: [],
    loops: [],
    mcp: [],
    commands: [],
    skills: [],
    suggestion: null,
    loopFires: new Map(),
    tasks: new Map(),
  }
}

/**
 * Matching key between a reinjected instruction and its loop. Truncated well below the CLI's
 * 1000-character inventory limit: comparing full strings would miss long instructions truncated on
 * only one side.
 */
export function loopKey(prompt: string): string {
  return prompt.slice(0, 200)
}

/**
 * What a turn did to a file touched several times. Created then rewritten remains a creation; a
 * final deletion takes precedence because the file no longer exists at the end of the turn.
 */
function mergeAction(current: EditedFile['action'], next: EditedFile['action']): EditedFile['action'] {
  if (next === 'deleted') return 'deleted'
  return current
}

/** Beyond this length, a turn label overflows the panel column. */
const TURN_LABEL_MAX = 60

/**
 * The user message opening the current turn. Some turns have none (compaction or resume); the log
 * position then serves as a unique marker.
 */
function lastUserMessage(state: ChatState): { id: string; label: string } {
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const item = state.items[i]
    if (item?.kind !== 'message' || item.role !== 'user') continue

    const text = item.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    return {
      id: item.id,
      label: text.length > TURN_LABEL_MAX ? `${text.slice(0, TURN_LABEL_MAX).trimEnd()}...` : text,
    }
  }

  return { id: `seq-${state.lastSeq}`, label: '' }
}

/**
 * Blocks suitable for a message bubble. `tool_use` blocks render separately. Empty text and
 * reasoning blocks are omitted: Fable and Opus reason on the server and return an empty `thinking`
 * block containing only its encrypted signature, which would otherwise create an empty expandable
 * Thinking section.
 */
export function renderableBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.filter((block) => {
    if (block.type === 'tool_use' || block.type === 'tool_result') return false
    if (block.type === 'text' || block.type === 'thinking') return block.text.trim() !== ''
    return true
  })
}

/**
 * Whether the item produces visible content. An agent message containing only `tool_use` blocks
 * renders nothing because its blocks appear separately as tool calls. It remains in the thread, but
 * counting it as visible left an empty gutter row and split consecutive tools into two groups for
 * no apparent reason.
 */
export function hasVisibleContent(item: ChatItem): boolean {
  if (item.kind !== 'message') return true
  if (item.streamingText.trim() || item.streamingThinking.trim()) return true
  return renderableBlocks(item.blocks).length > 0
}

/**
 * Append an item using a new array. The array must change identity on every edit or dependent
 * `useMemo` and `useEffect` hooks never run; this was precisely why turn navigation stayed empty.
 */
function appendItem(state: ChatState, item: ChatItem): void {
  state.items = [...state.items, item]
}

/**
 * Replace an item with an updated copy instead of mutating it. This enables row memoization:
 * in-place mutation preserves the reference, so `React.memo` would see no change and the streaming
 * message would never redraw. Neighboring items retain their identity and avoid redrawing.
 */
function replaceItem<T extends ChatItem>(state: ChatState, index: number, next: T): void {
  const items = [...state.items]
  items[index] = { ...next, position: items[index]?.position }
  state.items = items
}

function findLastIndex(items: ChatItem[], predicate: (item: ChatItem) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item && predicate(item)) return i
  }
  return -1
}

/** Message index, creating the message if it does not exist yet. */
function messageIndex(
  state: ChatState,
  id: string,
  role: 'user' | 'assistant',
  ts: number,
  seq: number,
  parentToolCallId: string | null,
): number {
  const existing = findLastIndex(state.items, (item) => item.kind === 'message' && item.id === id)
  if (existing !== -1) return existing

  appendItem(state, {
    kind: 'message',
    id,
    role,
    // Timestamp and position of the first received fragment: a multipart message retains its start
    // time, not its last block's time.
    ts,
    seq,
    blocks: [],
    streamingText: '',
    streamingThinking: '',
    parentToolCallId,
  })
  return state.items.length - 1
}

function updateMessage(
  state: ChatState,
  id: string,
  role: 'user' | 'assistant',
  ts: number,
  seq: number,
  parentToolCallId: string | null,
  update: (message: MessageItem) => MessageItem,
): void {
  const index = messageIndex(state, id, role, ts, seq, parentToolCallId)
  const current = state.items[index] as MessageItem
  // Message fragments may have mixed origins: deltas logged before the parent field existed,
  // followed by a `message.completed` carrying it. The first event naming a parent wins; never
  // discard a known parent, since transcript resynchronization emits null.
  const parent = current.parentToolCallId ?? parentToolCallId
  replaceItem(state, index, { ...update(current), parentToolCallId: parent })
}

/**
 * Close calls still open at the end of a turn or session. An interrupted CLI does not return
 * results for in-flight calls: without this fallback they stay running forever, even after reload,
 * and an abandoned `Task` claims its subagent is still working, complete with a timer. A late
 * `tool.completed` takes over by unconditionally rewriting the status.
 */
/**
 * Replace a task in the table. Copy the whole table for the same reason as thread items: in-place
 * mutation preserves its reference and prevents memoized views from redrawing.
 */
function putTask(state: ChatState, task: TaskState): void {
  const tasks = new Map(state.tasks)
  tasks.set(task.id, task)
  state.tasks = tasks
}

/** State of a thread tool call, or null if no record exists. */
function toolStatus(state: ChatState, toolCallId: string): ToolItem['status'] | null {
  const index = findLastIndex(state.items, (item) => item.kind === 'tool' && item.id === toolCallId)
  const item = index === -1 ? null : state.items[index]
  return item && item.kind === 'tool' ? item.status : null
}

function closeRunningTools(state: ChatState, preserveBackground = false): void {
  state.items.forEach((item, index) => {
    if (item.kind === 'tool' && item.status === 'running') {
      if (preserveBackground && state.background.some((task) => task.id === item.id)) return
      replaceItem(state, index, { ...item, status: 'interrupted' as const })
    }
  })
}

/**
 * The task counterpart of `closeRunningTools` at session end. A backgrounded subagent's tool call
 * has already returned, so `closeRunningTools` misses it; its unreported task kept it displayed as
 * active. Without this closure it stayed active forever, including after reload, because no further
 * events would be written for it.
 */
function closePendingTasks(state: ChatState): void {
  const tasks = new Map(state.tasks)
  for (const [id, task] of tasks) {
    if (!task.done) tasks.set(id, { ...task, activity: null, done: true, outcome: 'stopped' })
  }
  state.tasks = tasks
}

/**
 * Events proving reasoning has ended. Use an explicit list rather than everything except
 * `thinking.progress`: usage updates and subagent reports can arrive during reasoning without
 * ending it and would briefly blank the counter. `thinking.delta` is deliberately absent: it
 * alternates frame by frame with progress when reasoning is revealed. Including it erased every
 * value before rendering, so the counter never appeared.
 */
const THINKING_ENDED_BY = new Set<SillageEvent['type']>([
  'message.started',
  'message.delta',
  'message.completed',
  'tool.started',
  'tool.completed',
  'turn.started',
  'turn.completed',
  'session.ended',
  'context.compaction_started',
])

/**
 * Apply an event. Mutate state, then return it in a new object: deep-copying on every event is too
 * expensive for long conversations on phones, and only the root reference triggers React rendering.
 * `ts` comes from the log: the server write time is the only shared reference. Client timestamps
 * would vary across devices for the same message.
 */
export function applyEvent(
  state: ChatState,
  seq: number,
  ts: number,
  event: SillageEvent,
): ChatState {
  // Recognize a turn by its output as well as its opening marker. `turn.started` is emitted only
  // when Sillage sends a message, whereas `turn.completed` is emitted for every CLI `result`.
  // Session restarts therefore leave orphan completions, making the thread appear idle while the
  // agent works, with no Stop button or activity indicator. Incoming text or a starting tool proves
  // activity; `turn.completed` will close it either way.
  if (event.type === 'message.delta' || event.type === 'tool.started') {
    state.turnRunning = true
  }

  // Silent reasoning has no explicit end: the activity following it closes it. Without this reset,
  // the counter would remain visible during writing or tool execution and claim reasoning had not
  // finished.
  const previousLength = state.items.length
  if (THINKING_ENDED_BY.has(event.type)) state.thinkingTokens = null

  switch (event.type) {
    case 'session.started': {
      // The CLI re-emits initialization when the model changes during a session: the only reliable
      // signal for marking the switch in the thread.
      if (state.model && state.model !== event.model && state.items.length > 0) {
        appendItem(state, {
          kind: 'notice',
          id: `model-${seq}`,
          text: '', translation: { key: 'activity.modelChanged', model: event.model },
        })
      }
      state.model = event.model
      break
    }

    case 'turn.started': {
      state.turnRunning = true
      state.planId = null
      state.diffId = null
      // The new turn answers either the suggestion or something else; either way the suggestion is now obsolete.
      state.suggestion = null
      break
    }

    case 'turn.completed': {
      state.turnRunning = false
      state.planId = null
      state.diffId = null
      closeRunningTools(state, true)
      // Fallback: compaction ending without a boundary or error would otherwise leave the indicator
      // on until reload.
      state.compacting = false
      state.costUsd += event.costUsd
      state.inputTokens += event.inputTokens
      state.outputTokens += event.outputTokens
      state.cacheCreationTokens += event.cacheCreationTokens
      state.cacheReadTokens += event.cacheReadTokens
      break
    }

    case 'session.ended': {
      state.turnRunning = false
      state.compacting = false
      // Background work belongs to the CLI process and stops with it without an announcement. Loops
      // stop too, since scheduled tasks fire only while the CLI runs. Previously counted wakeups
      // remain: they are log facts, not process state.
      state.background = []
      state.loops = []
      closeRunningTools(state)
      closePendingTasks(state)
      break
    }

    case 'message.delta': {
      updateMessage(state, event.messageId, 'assistant', ts, seq, event.parentToolCallId, (message) => ({
        ...message,
        streamingText: message.streamingText + event.text,
      }))
      break
    }

    case 'thinking.progress': {
      // A resumed-session turn has no `turn.started`: reasoning proves it is running, just as a
      // text delta does above.
      state.turnRunning = true
      state.thinkingTokens = event.estimatedTokens
      break
    }

    case 'thinking.delta': {
      updateMessage(state, event.messageId, 'assistant', ts, seq, event.parentToolCallId, (message) => ({
        ...message,
        streamingThinking: message.streamingThinking + event.text,
      }))
      break
    }

    case 'message.completed': {
      // The message following a before snapshot opens the captured turn.
      if (event.role === 'user' && !event.parentToolCallId) {
        const index = state.checkpoints.findIndex((checkpoint) => checkpoint.openerId === null)
        if (index !== -1) {
          const text = event.blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n\n')
          state.checkpoints = state.checkpoints.map((checkpoint, i) =>
            i === index ? { ...checkpoint, openerId: event.messageId, openerText: text } : checkpoint,
          )
        }
      }
      updateMessage(state, event.messageId, event.role, ts, seq, event.parentToolCallId, (message) => ({
        ...message,
        // A message arrives in several parts under one ID: append blocks rather than replace them.
        // The blocks now carry streamed content, so clear the buffers.
        blocks: [...message.blocks, ...event.blocks],
        streamingText: '',
        streamingThinking: '',
      }))
      break
    }

    case 'file.edited': {
      const opener = lastUserMessage(state)
      const current = state.editTurns.at(-1)
      const turn =
        current && current.id === opener.id
          ? current
          : { id: opener.id, seq, ts, label: opener.label, files: [] }

      const existing = turn.files.find((file) => file.path === event.path)
      const files = existing
        ? turn.files.map((file) =>
            file.path === event.path
              ? {
                  ...file,
                  action: mergeAction(file.action, event.action),
                  toolCallIds: [...file.toolCallIds, event.toolCallId],
                }
              : file,
          )
        : [...turn.files, { path: event.path, action: event.action, toolCallIds: [event.toolCallId] }]

      // Replace rather than mutate: the thread rerenders by comparing references.
      state.editTurns =
        turn === current
          ? [...state.editTurns.slice(0, -1), { ...turn, files }]
          : [...state.editTurns, { ...turn, files }]
      break
    }

    case 'tool.started': {
      appendItem(state, {
        kind: 'tool',
        id: event.toolCallId,
        ts,
        name: event.name,
        presentation: event.presentation,
        title: event.title,
        input: event.input,
        inputRef: event.inputRef,
        output: null,
        outputBytes: null,
        status: 'running',
        durationMs: null,
        parentToolCallId: event.parentToolCallId,
      })
      break
    }

    case 'tool.input_updated': {
      const index = findLastIndex(state.items, (item) => item.kind === 'tool' && item.id === event.toolCallId)
      if (index !== -1) {
        const previous = state.items[index] as ToolItem
        replaceItem(state, index, { ...previous, input: event.input, inputRef: event.inputRef,
          title: event.title !== undefined ? event.title : previous.title,
          name: event.name ?? previous.name, presentation: event.presentation ?? previous.presentation })
      }
      break
    }

    case 'tool.output_delta': {
      const index = findLastIndex(state.items, (item) => item.kind === 'tool' && item.id === event.toolCallId)
      if (index !== -1) {
        const tool = state.items[index] as ToolItem
        if (tool.status !== 'running') break
        const output = (typeof tool.output === 'string' ? tool.output : '') + event.chunk
        // The final output remains in the log; keep the live buffer bounded.
        replaceItem(state, index, { ...tool, output: output.length > 100_000 ? `…\n${output.slice(-100_000)}` : output })
      }
      break
    }

    case 'tool.completed': {
      const index = findLastIndex(
        state.items,
        (item) => item.kind === 'tool' && item.id === event.toolCallId,
      )
      if (index !== -1) {
        replaceItem(state, index, {
          ...(state.items[index] as ToolItem),
          output: event.output,
          outputBytes: event.outputBytes ?? null,
          outputRef: event.outputRef,
          status: event.isError ? 'failed' : 'done',
          durationMs: event.durationMs,
        })
      }
      // The call has returned while its spawned task is still alive: it is no longer tracked. The
      // snapshot sets the same flag because neither event is guaranteed to arrive first.
      for (const task of state.tasks.values()) {
        if (task.toolCallId !== event.toolCallId || task.unattended) continue
        if (state.background.some((live) => live.id === task.id)) {
          putTask(state, { ...task, unattended: true })
        }
      }
      break
    }

    case 'permission.requested': {
      appendItem(state, {
        kind: 'permission',
        id: event.requestId,
        toolName: event.toolName,
        input: event.input,
        suggestions: event.suggestions,
        status: 'pending',
        title: event.title ?? null,
        description: event.description ?? null,
      })
      break
    }

    case 'permission.resolved': {
      const index = findLastIndex(
        state.items,
        (item) => item.kind === 'permission' && item.id === event.requestId,
      )
      if (index !== -1) {
        replaceItem(state, index, {
          ...(state.items[index] as PermissionItem),
          status: event.decision === 'allowed' ? 'allowed' : event.decision,
        })
      }
      break
    }

    case 'question.requested': {
      appendItem(state, {
        kind: 'question',
        id: event.requestId,
        questions: event.questions,
        blocking: event.blocking !== false,
        status: 'pending',
        answers: {},
      })
      break
    }

    case 'question.resolved': {
      const index = findLastIndex(
        state.items,
        (item) => item.kind === 'question' && item.id === event.requestId,
      )
      if (index !== -1) {
        replaceItem(state, index, {
          ...(state.items[index] as QuestionItem),
          status: event.status,
          answers: event.answers,
        })
      }
      break
    }

    case 'context.compaction_started': {
      state.compacting = true
      break
    }

    case 'checkpoint.started': {
      state.checkpoints = [
        ...state.checkpoints,
        {
          key: event.key,
          seq,
          openerId: null,
          openerText: '',
          status: 'pending',
          files: [],
          truncated: false,
          excluded: 0,
          reason: null,
          restored: false,
        },
      ]
      break
    }

    case 'checkpoint.completed': {
      state.checkpoints = state.checkpoints.map((checkpoint) =>
        checkpoint.key === event.key
          ? {
              ...checkpoint,
              status: event.status,
              files: event.files,
              truncated: event.truncated,
              excluded: event.excluded,
              reason: event.reason,
            }
          : checkpoint,
      )
      break
    }

    case 'checkpoint.restored': {
      state.checkpoints = state.checkpoints.map((checkpoint) =>
        checkpoint.key === event.key ? { ...checkpoint, restored: true } : checkpoint,
      )
      // Thread marker: the agent does not know its files have been restored.
      appendItem(state, {
        kind: 'notice',
        id: `restore-${seq}`,
        text: '', translation: { key: 'checkpoint.restored.notice', written: event.written, deleted: event.deleted },
      })
      break
    }

    case 'context.compacted': {
      state.compacting = false
      // Subtle marker: the thread loses no visible content, but earlier content is no longer in the
      // agent's memory in its original form.
      appendItem(state, {
        kind: 'notice',
        id: `compact-${seq}`,
        text: '', translation: { key: 'compaction', pre: event.preTokens, post: event.postTokens },
      })
      // Reset the gauge to what the CLI reports next turn: retaining the old value would show a
      // full context immediately after clearing it.
      state.context = null
      break
    }

    case 'message.queued': {
      state.queued = [
        ...state.queued,
        { queueId: event.queueId, text: event.text, attachmentCount: event.attachmentCount },
      ]
      break
    }

    case 'message.dequeued': {
      state.queued = state.queued.filter((entry) => entry.queueId !== event.queueId)
      break
    }

    case 'session_message.held': {
      state.heldSessionMessages = [
        ...state.heldSessionMessages,
        { messageId: event.messageId, text: event.text, reason: event.reason },
      ]
      break
    }

    case 'session_message.released': {
      state.heldSessionMessages = state.heldSessionMessages.filter(
        (entry) => entry.messageId !== event.messageId,
      )
      break
    }

    case 'elicitation.requested': {
      appendItem(state, {
        kind: 'elicitation',
        id: event.requestId,
        serverName: event.serverName,
        mode: event.mode,
        message: event.message,
        url: event.url,
        fields: event.fields,
        title: event.title,
        status: 'pending',
        content: {},
      })
      break
    }

    case 'elicitation.resolved': {
      const index = findLastIndex(
        state.items,
        (item) => item.kind === 'elicitation' && item.id === event.requestId,
      )
      if (index !== -1) {
        replaceItem(state, index, {
          ...(state.items[index] as ElicitationItem),
          status: event.status,
          content: event.content,
        })
      }
      break
    }

    case 'plan.review_requested': {
      appendItem(state, {
        kind: 'plan',
        id: event.requestId,
        plan: event.plan,
        status: 'pending',
        followUpOptions: event.followUpOptions,
        followUpMode: null,
      })
      break
    }

    case 'plan.review_resolved': {
      const index = findLastIndex(
        state.items,
        (item) => item.kind === 'plan' && item.id === event.requestId,
      )
      if (index !== -1) {
        replaceItem(state, index, {
          ...(state.items[index] as PlanItem),
          status: event.decision,
          followUpMode: event.followUpMode,
        })
      }
      break
    }

    case 'agent.notice': {
      const id = event.id ?? `notice-${seq}`
      const index = findLastIndex(state.items, (item) => item.kind === 'notice' && item.id === id)
      const item: NoticeItem = {
        kind: 'notice', id, text: event.message, code: event.code,
        level: event.level, details: event.details,
      }
      if (index === -1) appendItem(state, item)
      else replaceItem(state, index, item)
      break
    }

    case 'suggestion.updated': {
      // Arrives after the turn's `result`: only the latest suggestion counts, and only until another turn starts.
      state.suggestion = event.text
      break
    }

    case 'error': {
      state.compacting = false
      // A setting waiting for the turn to end is not a failure: the turn continues and the choice
      // is saved. An alert banner would make it look like an error.
      if (event.code === 'config_restart_deferred') {
        appendItem(state, {
          kind: 'notice',
          id: `config-deferred-${seq}`,
          text: '', translation: { key: 'activity.configRestartDeferred' },
        })
        break
      }
      appendItem(state, {
        kind: 'error',
        id: `error-${seq}`,
        code: event.code,
        message: event.message,
        recoverable: event.recoverable,
      })
      // An unrecoverable failure ended the session and its CLI background work, just like
      // `session.ended`, logged immediately afterward by the server. But that end event uses the
      // same database as the error and may be missing; without it the turn would remain open
      // forever. Close it here too.
      if (!event.recoverable) {
        state.turnRunning = false
        state.background = []
        state.loops = []
        closeRunningTools(state)
        closePendingTasks(state)
      }
      break
    }

    case 'usage.updated': {
      if (event.rateLimit) state.rateLimit = event.rateLimit
      if (event.context) state.context = event.context
      break
    }

    case 'background.updated': {
      // Replace rather than merge: the event carries the full list, keeping the indicator
      // resilient. The next event repairs a missed one instead of leaving a task active forever.
      state.background = event.tasks
      // A task still alive after its tool call returns is no longer tracked. This is the only point
      // where that question arises: the list proves it is still alive.
      for (const task of event.tasks) {
        const known = state.tasks.get(task.id)
        if (!known || known.unattended) continue
        if (known.toolCallId === null || toolStatus(state, known.toolCallId) !== 'running') {
          putTask(state, { ...known, unattended: true })
        }
      }
      break
    }

    case 'loops.updated': {
      state.loops = event.loops
      break
    }

    case 'mcp.updated': {
      state.mcp = event.servers
      break
    }

    case 'commands.updated': {
      state.commands = event.commands
      break
    }

    case 'skills.updated': {
      state.skills = event.skills
      break
    }

    case 'prompt.injected': {
      const key = loopKey(event.text)
      const seen = state.loopFires.get(key)
      state.loopFires.set(key, { count: (seen?.count ?? 0) + 1, lastAt: ts })
      break
    }

    case 'task.started': {
      putTask(state, {
        id: event.taskId,
        toolCallId: event.toolCallId,
        kind: event.kind,
        description: event.description,
        activity: null,
        lastTool: null,
        toolUses: 0,
        totalTokens: 0,
        durationMs: 0,
        unattended: false,
        done: false,
        outcome: null,
      })
      break
    }

    case 'task.progress': {
      const known = state.tasks.get(event.taskId)
      // Progress without a known start comes from a retention-truncated log: there is nothing to
      // attach it to, and inventing an entry would create a task with no name or origin.
      if (!known) break
      putTask(state, {
        ...known,
        activity: event.activity,
        lastTool: event.lastTool,
        toolUses: event.toolUses,
        totalTokens: event.totalTokens,
        durationMs: event.durationMs,
      })
      break
    }

    case 'task.completed': {
      const known = state.tasks.get(event.taskId)
      if (known) {
        putTask(state, {
          ...known,
          activity: null,
          durationMs: event.durationMs ?? known.durationMs,
          done: true,
          outcome: event.status,
        })
      }
      // The snapshot list is replaced, never amended, and the CLI republishes it immediately
      // afterward. If it dies between these events, its last list would keep the task active
      // forever: an announced completion also removes it.
      state.background = state.background.filter((live) => live.id !== event.taskId)
      if (known?.unattended && !event.ambient) {
        appendItem(state, {
          kind: 'task',
          id: `task-${event.taskId}`,
          description: known.description,
          status: event.status,
          summary: event.summary,
          durationMs: event.durationMs,
        })
      }
      break
    }

    case 'plan.updated': {
      const id = state.planId ?? `plan-progress-${seq}`
      const index = findLastIndex(state.items, (item) => item.id === id)
      const item: PlanProgressItem = { kind: 'plan_progress', id, items: event.items }
      if (index === -1) appendItem(state, item)
      else replaceItem(state, index, item)
      state.planId = id
      break
    }
    case 'diff.updated': {
      const id = state.diffId ?? `diff-${seq}`
      const index = findLastIndex(state.items, (item) => item.id === id)
      const item: DiffItem = { kind: 'diff', id, files: event.files, patch: event.patch, patchRef: event.patchRef }
      if (index === -1) appendItem(state, item)
      else replaceItem(state, index, item)
      state.diffId = id
      break
    }
    case 'message.started':
      break
  }

  for (let i = previousLength; i < state.items.length; i++) {
    state.items[i] = { ...state.items[i]!, position: seq }
  }
  state.lastSeq = Math.max(state.lastSeq, seq)
  return { ...state }
}

/** JSON transport also used by the disposable SQLite projection. */
export type SerializedChatState = Omit<ChatState, 'tasks' | 'loopFires'> & {
  tasks: [string, TaskState][]
  loopFires: [string, { count: number; lastAt: number }][]
}
export function serializeChatState(state: ChatState): SerializedChatState {
  return { ...state, tasks: [...state.tasks], loopFires: [...state.loopFires] }
}
export function deserializeChatState(state: SerializedChatState): ChatState {
  return { ...state, tasks: new Map(state.tasks), loopFires: new Map(state.loopFires) }
}
export type ThreadPage =
  | { building: true; cursor: number; target: number; unavailable?: boolean }
  | { building: false; state: SerializedChatState; cursor: number; before: number; hasMore: boolean; reset: boolean }
