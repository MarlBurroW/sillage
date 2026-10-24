import type { AgentKind } from './events.js'

/**
 * What each CLI can do beyond the shared contract.
 *
 * Single source shared by server and frontend: the UI does not offer actions the CLI would
 * reject (the button is absent rather than offered then refused), and the server still rejects
 * unsupported actions at runtime as a safety net. Check capabilities here rather than `agent
 * === 'codex'`: future CLIs inherit correct behavior by filling in their row, without hunting
 * down name comparisons.
 */
export interface AgentCapabilities {
  /** Steer the current turn without interrupting it or opening another. */
  steer: boolean
  /** Manually summarize the current native context. */
  compact: boolean
  /** Reconcile turns performed outside Sillage after an initial import. */
  resyncSessions: boolean
  /** The CLI submits plans for approval before execution (`plan.review_requested`). */
  planReview: boolean
  /**
   * Import local sessions originally started outside Sillage.
   */
  cliSessions: boolean
  /**
   * The CLI can stop a background job (`background.updated`) on request by its listed ID.
   * Completion arrives through the normal stream as `background.updated` without the stopped
   * job.
   */
  stopBackgroundTask: boolean
  /**
   * The CLI can list slash commands for a directory without a running session: conversation
   * drafts offer them before the first turn. Codex has no slash commands; its `$` skills arrive
   * on the first turn.
   */
  draftCommands: boolean
}

export const AGENT_CAPABILITIES: Record<AgentKind, AgentCapabilities> = {
  claude: {
    steer: true,
    compact: true,
    resyncSessions: true,
    planReview: true,
    cliSessions: true,
    stopBackgroundTask: true,
    draftCommands: true,
  },
  codex: {
    steer: true,
    compact: true,
    resyncSessions: false,
    planReview: false,
    cliSessions: false,
    stopBackgroundTask: false,
    draftCommands: false,
  },
  // `steer` is true, probed on opencode 1.18.25: a `prompt_async` sent during a turn
  // is consumed at the next step of that turn, without passing through `idle`. opencode's plan mode
  // is a selectable agent; it submits nothing for approval.
  opencode: {
    steer: true,
    compact: true,
    resyncSessions: false,
    planReview: false,
    cliSessions: false,
    stopBackgroundTask: false,
    draftCommands: true,
  },
  // Google ACP supports native import, but neither live steering nor manual compaction.
  antigravity: {
    steer: false,
    compact: false,
    resyncSessions: false,
    planReview: false,
    cliSessions: true,
    stopBackgroundTask: false,
    draftCommands: true,
  },
  // Grok Build speaks ACP plus `_x.ai/…` extensions: `interject` inserts a message
  // into the current turn; `exit_plan_mode` submits the plan (probed on 1.0.62). Its
  // slash commands arrive with `initialize`, without opening a session.
  grok: {
    steer: true,
    compact: true,
    resyncSessions: false,
    planReview: true,
    cliSessions: false,
    stopBackgroundTask: false,
    draftCommands: true,
  },
}
