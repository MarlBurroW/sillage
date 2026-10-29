import type {
  AgentConfig,
  ConversationStatus,
  ElicitationAction,
  ElicitationValue,
  SillageEvent,
} from '@sillage/protocol'
import type { ResolvedMcpServers } from './mcp-registry.js'

export interface PermissionDecision {
  decision: 'allowed' | 'denied'
  scope: 'once' | 'session' | 'always'
  decidedBy: string | null
}

/** User response to agent questions. */
export interface QuestionAnswer {
  status: 'answered' | 'cancelled'
  /** Selected values by question ID. */
  answers: Record<string, string[]>
  decidedBy: string | null
}

/** User response to MCP elicitations. */
export interface ElicitationAnswer {
  action: ElicitationAction
  /** Entered values, empty on rejection or cancellation. */
  content: Record<string, ElicitationValue>
  decidedBy: string | null
}

/** User verdict on agent-proposed plans. */
export interface PlanReview {
  decision: 'approved' | 'rejected'
  /** Accepted-plan follow-up option `id` offered in `plan.review_requested`. Opaque here and adapter-validated. */
  followUpMode: string | null
  decidedBy: string | null
}

/** Session-manager inputs enabling runner output. */
export interface RunnerContext {
  conversationId: string
  cwd: string
  config: AgentConfig
  /** CLI executable resolved to absolute paths when possible. Never resolve again or hardcode names: systemd PATH is minimal, and resolution includes managed prefixes unknown to `spawn`. Retain configured names on failure so errors identify requested binaries. */
  binary: string
  /** Attachment storage root requiring agent read access. */
  attachmentsRoot: string
  /** Origin inherited by services launched from this conversation. */
  processEnv?: Record<string, string>
  /** Resolves whole conversation configurations into active known registry servers plus Sillage's built-in server. Whole configurations are necessary because built-ins have no registry ID and depend on live `sillageMcp`/`strictMcp`. Functions rather than frozen lists support Codex thread resumes and Claude live replacement. */
  resolveMcpServers(config: AgentConfig): ResolvedMcpServers
  /** Project activity injected at startup, null when empty or platform additions disabled. The only context arriving without agent initiative; MCP queries require remembering to ask. */
  projectOverview(config: AgentConfig): string | null
  /** Small, project-scoped metadata for references in this message; transcript text stays on demand. */
  sessionReferenceContext?(text: string, config: AgentConfig): string | null
  /** Directories whose CLAUDE.md/AGENTS.md must be hidden because Sillage-held SILLAGE.md already arrives through `projectOverview`. Empty for repository-held instructions. Startup-only; mode changes apply to subsequent sessions. */
  maskedInstructionRoots(): string[]
  /** Project memory directory replacing Claude's native directory through `autoMemoryDirectory`. Created before return; null for probes preserving host memory. Codex receives it via `projectOverview`. */
  memoryDir(): string | null
  /** Global then project skill plugin roots, empty when libraries are disabled globally or per conversation. Directories exist even empty so plugins see later-added skills. Function like `resolveMcpServers` because switches change live. */
  skillRoots(config: AgentConfig): string[]
  /** Writable worktrees used outside cwd (see `worktrees/linked.ts`). Optional because test runners have none. */
  workTrees?(): string[]
  /** Native session ID to resume, null for new sessions. */
  resumeSessionId: string | null
  /** Persists then broadcasts; `raw` retains native CLI messages. */
  emit(event: SillageEvent, raw?: unknown): void
  setStatus(status: ConversationStatus): void
  /** Stores native IDs immediately upon announcement for resume. */
  setAgentSessionId(sessionId: string): void
  /** Persists session-initiated configuration changes, such as plan-approved permission modes. Otherwise settings and resume would revert to old values. */
  updateConfig(config: AgentConfig): void
  /** Reflect successful native /logout commands in the selected managed account. */
  accountSignedOut?(): Promise<void>
  /** Registers pending permissions and returns request IDs. */
  openPermissionRequest(toolName: string, input: unknown): string
  closePermissionRequest(requestId: string, decision: PermissionDecision): void
}

/** Attachment as transmitted by runners. */
export interface OutgoingAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  /** Absolute server-disk path. */
  path: string
  /** Model-compatible inline image; otherwise transmit only paths. */
  inlineImage: boolean
}

/** Server-resolved `@` mention. Claude expands text `@path` itself; Codex requires separate `mention` inputs. Carry mentions alongside text to support both native protocols. */
export interface OutgoingMention {
  /** Working-directory-relative path as written in messages. */
  relativePath: string
  /** Absolute server-disk path. */
  path: string
  name: string
}

/** Common CLI contract (invariant I3). Other server code knows only this interface: adding CLIs requires implementations without changing routes, journals or frontends. */
export interface AgentRunner {
  readonly conversationId: string
  /** Actual running configuration, potentially differing from stored requests until unsupported live changes trigger restart. Enables users to see which settings govern current turns. */
  readonly appliedConfig: AgentConfig
  /** Starts processes and normalizes streams into journals. */
  start(): Promise<void>
  /** Replay an adopted native session into a new journal, without a model request. */
  importHistory?(): Promise<void>
  /** Skills arrive by name while mentions arrive resolved. Deliberate: servers know disk paths, but only CLIs know published skill inventories. Unknown names are ignored. */
  send(
    text: string,
    attachments: OutgoingAttachment[],
    mentions: OutgoingMention[],
    skills: string[],
  ): Promise<void>
  /** Applies configurations without restarts. False means unsupported live changes requiring callers to stop runners and resume with new values. */
  applyConfig(config: AgentConfig): Promise<boolean>
  /** Reloads libraries after writes without restarting. Claude reloads on demand; Codex requires resending roots. Encapsulate CLI-specific differences here. */
  reloadSkillLibrary(): Promise<void>
  /**
   * Retries one MCP server the CLI reported as failed, by the name `mcp.updated` carries. CLIs
   * connect servers once at launch and never again, so a dependency started after the session
   * stays unreachable until restart without this. False when the CLI offers no such call; errors
   * from the attempt itself propagate. Must work mid-turn: agents start those dependencies
   * themselves.
   */
  reconnectMcpServer(name: string): Promise<boolean>
  /** CLI-derived title or null, replacing unhelpful 'New conversation' defaults. */
  suggestedTitle(): Promise<string | null>
  interrupt(): Promise<void>
  /** Answers pending permissions; false when no longer pending. */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean
  /** Answers agent questions; false when no longer pending. */
  answerQuestion(requestId: string, answer: QuestionAnswer): boolean | Promise<boolean>
  /** Answers MCP elicitations; false when no longer pending. */
  resolveElicitation(requestId: string, answer: ElicitationAnswer): boolean
  /** Steers current turns immediately without interrupting or starting another. False when unsupported or no turn is active. */
  steer(
    text: string,
    attachments: OutgoingAttachment[],
    mentions: OutgoingMention[],
    skills: string[],
  ): Promise<boolean>
  /** Compacts context by requesting agent summaries. False when unsupported. Both CLIs support different paths, requiring this abstraction. */
  compact(): Promise<boolean>
  /** Reviews agent plans; false for expired requests or unsupported CLIs. */
  reviewPlan(requestId: string, review: PlanReview): boolean
  /** Stops background IDs announced by `background.updated`. False when unsupported (`stopBackgroundTask`) or sessions are unloaded. Completion arrives through later `background.updated`, not this response. */
  stopBackgroundTask(taskId: string): Promise<boolean>
  stop(): Promise<void>
}
