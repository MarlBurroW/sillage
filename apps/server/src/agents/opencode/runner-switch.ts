import type { AgentConfig, BackgroundTaskOutput } from '@sillage/protocol'
import type {
  AgentRunner,
  ElicitationAnswer,
  OutgoingAttachment,
  OutgoingMention,
  PermissionDecision,
  PlanReview,
  QuestionAnswer,
  RunnerContext,
} from '../types.js'
import { OpencodeRunner } from './runner.js'
import { Opencode2Runner, OPENCODE2_RAW_FORMAT } from './v2/runner.js'
import { opencodeGeneration } from './version-guard.js'

/**
 * Runner for whichever OpenCode major is installed.
 *
 * Adapters create runners synchronously, but only the binary's `--version` tells which server it
 * ships. Decide at start, the first asynchronous step, then delegate everything. Read per start
 * and cached on the binary's size and mtime: upgrading 1.x to 2.x in place switches the next
 * session without a daemon restart, and the 2.x server finds 1.x sessions migrated under the
 * same IDs.
 */
export class OpencodeRunnerSwitch implements AgentRunner {
  readonly conversationId: string
  private inner: AgentRunner | null = null

  constructor(private readonly ctx: RunnerContext) {
    this.conversationId = ctx.conversationId
  }

  get appliedConfig(): AgentConfig {
    return this.inner?.appliedConfig ?? this.ctx.config
  }

  private get runner(): AgentRunner {
    if (!this.inner) throw new Error("La session opencode n'est pas démarrée.")
    return this.inner
  }

  async start(): Promise<void> {
    if ((await opencodeGeneration(this.ctx.binary)) === 2) {
      const ctx = this.ctx
      this.inner = new Opencode2Runner({ ...ctx, emit: (event, raw) => ctx.emit(event, raw, OPENCODE2_RAW_FORMAT) })
    } else {
      this.inner = new OpencodeRunner(this.ctx)
    }
    await this.inner.start()
  }

  /**
   * Adopting a native session needs the 2.x server, which keeps structured history. 1.x lists no
   * sessions to adopt (see opencode-sessions route), so reaching here on 1.x is a misuse.
   */
  async importHistory(): Promise<void> {
    if ((await opencodeGeneration(this.ctx.binary)) !== 2) throw new Error('Importing an OpenCode session requires OpenCode 2.')
    const ctx = this.ctx
    const runner = new Opencode2Runner({ ...ctx, emit: (event, raw) => ctx.emit(event, raw, OPENCODE2_RAW_FORMAT) })
    this.inner = runner
    await runner.importHistory()
  }

  send(text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[], skills: string[]): Promise<void> {
    return this.runner.send(text, attachments, mentions, skills)
  }

  async steer(text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[], skills: string[]): Promise<boolean> {
    return this.inner ? this.inner.steer(text, attachments, mentions, skills) : false
  }

  async applyConfig(config: AgentConfig): Promise<boolean> {
    return this.inner ? this.inner.applyConfig(config) : false
  }

  async reloadSkillLibrary(): Promise<void> {
    await this.inner?.reloadSkillLibrary()
  }

  async reconnectMcpServer(name: string): Promise<boolean> {
    return this.inner ? this.inner.reconnectMcpServer(name) : false
  }

  async suggestedTitle(): Promise<string | null> {
    return this.inner ? this.inner.suggestedTitle() : null
  }

  async interrupt(): Promise<void> {
    await this.inner?.interrupt()
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.inner?.resolvePermission(requestId, decision) ?? false
  }

  answerQuestion(requestId: string, answer: QuestionAnswer): boolean | Promise<boolean> {
    return this.inner?.answerQuestion(requestId, answer) ?? false
  }

  resolveElicitation(requestId: string, answer: ElicitationAnswer): boolean {
    return this.inner?.resolveElicitation(requestId, answer) ?? false
  }

  async compact(): Promise<boolean> {
    return this.inner ? this.inner.compact() : false
  }

  reviewPlan(requestId: string, review: PlanReview): boolean {
    return this.inner?.reviewPlan(requestId, review) ?? false
  }

  async stopBackgroundTask(taskId: string): Promise<boolean> {
    return this.inner ? this.inner.stopBackgroundTask(taskId) : false
  }

  async readBackgroundTaskOutput(taskId: string): Promise<BackgroundTaskOutput | null> {
    return this.inner?.readBackgroundTaskOutput ? this.inner.readBackgroundTaskOutput(taskId) : null
  }

  async stop(): Promise<void> {
    await this.inner?.stop()
  }
}
