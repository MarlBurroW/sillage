import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { conversations, type ConversationRow } from '@sillage/db'
import { agentConfigSchema, taskReplyBodySchema } from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'
import type { AppContext } from '../http/context.js'
import { assertTokenExecution } from '../http/v1/execution-policy.js'
import { MAX_LAUNCH_PROMPT_CHARS } from './agent-requests-launch.js'
import { describeZod, Refusal, type Requester } from './agent-requests-shared.js'
import type { SessionManager } from './session-manager.js'

/** Operations on existing sessions from outside them: `message_session`, `steer_session`, `interrupt_session` and `reply_session`. */

/** What these operations drive on the target session. */
type SessionControls = Pick<
  SessionManager,
  'interrupt' | 'steer' | 'sendMessage' | 'resolvePermission' | 'answerQuestion' | 'reviewPlan' | 'resolveElicitation'
>

export class SessionOperations {
  constructor(
    private readonly ctx: AppContext,
    private readonly sessions: SessionControls,
    /** Journal for finding open requests resolved by `reply_session`. */
    private readonly log?: EventLog,
  ) {}

  /** Personal assistants and sessionless clients manage the account's project sessions.
   * Project sessions keep signed inter-session delivery. Target ownership still applies. */
  async actOnSession(
    kind: 'message_session' | 'steer_session' | 'interrupt_session' | 'reply_session',
    requester: Requester,
    payload: Record<string, unknown>,
  ): Promise<string> {
    if (requester.id && !requester.personal) {
      throw new Refusal('This tool is only for clients outside sessions: from a session, use send_session_message.')
    }
    const id = typeof payload.session === 'string' ? payload.session.trim() : ''
    if (!id) throw new Refusal('The `session` parameter is required: its ID from list_sessions.')
    const target = this.ctx.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.projectId, requester.projectId), isNull(conversations.archivedAt)))
      .get()
    if (!target || target.userId !== requester.userId) {
      throw new Refusal(`No session “${id}” belonging to you in this project. Use list_sessions to see sessions.`)
    }

    if (kind === 'interrupt_session') {
      if (target.status !== 'running' && target.status !== 'awaiting_input') return `Session “${target.title}” is not working (${target.status}): nothing to interrupt.`
      await this.sessions.interrupt(target.id)
      return `Turn of “${target.title}” interrupted. A message resumes it with its context.`
    }

    if (requester.apiToken) assertTokenExecution(requester.apiToken, agentConfigSchema.parse(JSON.parse(target.config)))

    if (kind === 'reply_session') return this.replyToSession(target, requester, payload)

    const body = typeof payload.body === 'string' ? payload.body.trim() : ''
    if (!body) throw new Refusal('The `body` parameter is required.')
    if (body.length > MAX_LAUNCH_PROMPT_CHARS) {
      throw new Refusal(`Message too long (${body.length} characters, maximum ${MAX_LAUNCH_PROMPT_CHARS}).`)
    }
    if (kind === 'steer_session') {
      // Steering exists only during active turns and callers often lose the
      // race: fall back to an ordinary message rather than losing the text.
      const steered = await this.sessions.steer(target.id, randomUUID(), body, [], [])
      if (steered) return `Turn of “${target.title}” steered: the CLI reads the message during its current turn.`
      await this.sessions.sendMessage(target.id, randomUUID(), body, [], [])
      return `No turn to steer in “${target.title}” (or its CLI does not support steering): sent as an ordinary message starting a turn.`
    }
    const busy = target.status === 'running'
    await this.sessions.sendMessage(target.id, randomUUID(), body, [], [])
    return busy
      ? `Message queued for “${target.title}”: it is working and will receive it after its turn. Use wait_for_session then read_session for its reply.`
      : `Message delivered to “${target.title}”: resuming as if the user typed it in Sillage. Use wait_for_session then read_session for its reply.`
  }

  /** Answers open requests according to type, like API `replies` routes. */
  private async replyToSession(target: ConversationRow, requester: Requester, payload: Record<string, unknown>): Promise<string> {
    if (!this.log) throw new Refusal('Replies to requests are unavailable on this server.')
    const requestId = typeof payload.request_id === 'string' ? payload.request_id.trim() : ''
    const open = this.log.openPrompts(target.id)
    const pending = requestId ? open.find((prompt) => prompt.requestId === requestId) : open[0]
    if (!pending) {
      throw new Refusal(
        requestId
          ? `No pending request “${requestId}” in this session: read_session shows what it awaits.`
          : `Session “${target.title}” is not awaiting a reply.`,
      )
    }
    const parsed = taskReplyBodySchema.safeParse({ kind: pending.kind, ...payload })
    if (!parsed.success) throw new Refusal(`Malformed reply for request type ${pending.kind}: ${describeZod(parsed.error)}`)
    const body = parsed.data
    const decidedBy = requester.userId
    let resolved: boolean
    switch (body.kind) {
      case 'permission':
        resolved = this.sessions.resolvePermission(target.id, pending.requestId, { decision: body.decision, scope: body.scope, decidedBy })
        break
      case 'question':
        resolved = await this.sessions.answerQuestion(target.id, pending.requestId, { status: body.status, answers: body.answers, decidedBy })
        break
      case 'plan':
        resolved = this.sessions.reviewPlan(target.id, pending.requestId, { decision: body.decision, followUpMode: body.followUpMode, decidedBy })
        break
      case 'elicitation':
        resolved = this.sessions.resolveElicitation(target.id, pending.requestId, { action: body.action, content: body.content, decidedBy })
        break
    }
    if (!resolved) throw new Refusal('This request expired: the session stopped in the meantime. A message resumes it.')
    return `Reply (${body.kind}) delivered to “${target.title}”: continuing. Use wait_for_session then read_session for progress.`
  }
}
