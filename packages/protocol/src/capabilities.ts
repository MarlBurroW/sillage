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
   * The CLI can return the tail of a background shell's output (Bash `run_in_background`, Monitor)
   * by its listed ID. Read on demand: nothing streams it into the log.
   */
  readBackgroundOutput: boolean
  /**
   * The CLI can list slash commands for a directory without a running session: conversation
   * drafts offer them before the first turn. Codex has no slash commands; its `$` skills arrive
   * on the first turn.
   */
  draftCommands: boolean
  /**
   * The CLI can branch a session at a chosen turn. Without it a fork starts a new session of the
   * same CLI that receives the conversation up to that turn as portable context (`portable_fork`).
   */
  nativeFork: boolean
}

export const AGENT_CAPABILITIES: Record<AgentKind, AgentCapabilities> = {
  claude: {
    steer: true,
    compact: true,
    resyncSessions: true,
    planReview: true,
    cliSessions: true,
    stopBackgroundTask: true,
    readBackgroundOutput: true,
    draftCommands: true,
    nativeFork: true,
  },
  codex: {
    steer: true,
    compact: true,
    resyncSessions: false,
    planReview: false,
    cliSessions: false,
    stopBackgroundTask: false,
    readBackgroundOutput: false,
    draftCommands: false,
    nativeFork: true,
  },
  // `steer` is true, probed on opencode 1.18.25 and 2.4.1: a prompt sent during a turn is consumed
  // at the next step of that turn. opencode's plan mode is a selectable agent; it submits nothing
  // for approval. Background tasks exist from 2.x (subagents, background shells), which can cancel
  // them and page a shell's output; 1.x never reports any, so it never shows those controls.
  // Native sessions are adoptable from 2.x, whose stored history the runner replays; 1.x lists none.
  opencode: {
    steer: true,
    compact: true,
    resyncSessions: false,
    planReview: false,
    cliSessions: true,
    stopBackgroundTask: true,
    readBackgroundOutput: true,
    draftCommands: true,
    nativeFork: true,
  },
  // Google ACP supports native import, but neither live steering nor manual compaction.
  antigravity: {
    steer: false,
    compact: false,
    resyncSessions: false,
    planReview: false,
    cliSessions: true,
    stopBackgroundTask: false,
    readBackgroundOutput: false,
    draftCommands: true,
    nativeFork: false,
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
    readBackgroundOutput: false,
    draftCommands: true,
    nativeFork: true,
  },
  // GitHub Copilot CLI 1.0.116 over ACP. A prompt sent during a turn cancels it rather than
  // steering it. `/compact` is a slash command the runner sends as a prompt. Plan mode offers no
  // review request to an ACP client (no `exit_plan_mode` tool). Sessions started in a terminal
  // are listed by `session/list` and adopted from the history `session/load` replays; later
  // turns made outside Sillage are not resynced. Background shells can only be stopped by the
  // model (`stop_bash`). Slash commands need a session, which a probe opens without a turn.
  // No fork RPC (`session/fork`: Method not found).
  copilot: {
    steer: false,
    compact: true,
    resyncSessions: false,
    planReview: false,
    cliSessions: true,
    stopBackgroundTask: false,
    readBackgroundOutput: false,
    draftCommands: true,
    nativeFork: false,
  },
}
