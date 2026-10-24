import { randomUUID } from 'node:crypto'
import type {
  AgentQuestion,
  ElicitationField,
  PermissionOption,
  PlanFollowUpOption,
} from '@sillage/protocol'
import type {
  ElicitationAnswer,
  PermissionDecision,
  PlanReview,
  QuestionAnswer,
  RunnerContext,
} from './types.js'

/** Default permission suggestions shared across CLIs: actions Sillage can replay rather than native choices retained in runner responses. */
const PERMISSION_SUGGESTIONS: PermissionOption[] = [
  { id: 'allow-once', label: 'Autoriser', scope: 'once', behavior: 'allow' },
  { id: 'allow-session', label: 'Autoriser pour la session', scope: 'session', behavior: 'allow' },
  { id: 'deny', label: 'Refuser', scope: 'once', behavior: 'deny' },
]

/** Permission request details shown beyond tool names. */
export interface PermissionDetails {
  suggestions?: PermissionOption[]
  toolName: string
  input: unknown
  /** CLI-provided labels when available, otherwise null. */
  title?: string | null
  description?: string | null
  displayName?: string | null
}

/** MCP elicitation information shown to users. */
export interface ElicitationDetails {
  serverName: string
  mode: 'form' | 'url'
  message: string
  url: string | null
  fields: ElicitationField[]
  title: string | null
}

/** Pending user requests and their shared lifecycle. Permissions, questions, elicitations and plans emit `*.requested`, enter `awaiting_input` when blocking, retain native response callbacks, then emit `*.resolved`, respond and return to `running` once no blocking requests remain. Runner shutdown expires everything so CLIs never await impossible answers. Runners previously duplicated this except response payloads; now each supplies only `respond`. Null responses mean expiry without decisions. */
export class PendingInteractions {
  private readonly permissions = new Map<string, (decision: PermissionDecision | null) => void>()
  private readonly questions = new Map<string, (answer: QuestionAnswer | null) => void>()
  private readonly nonBlocking = new Set<string>()
  private readonly questionDefinitions = new Map<string, AgentQuestion[]>()
  private readonly elicitations = new Map<string, (answer: ElicitationAnswer | null) => void>()
  private readonly plans = new Map<string, (review: PlanReview | null) => void>()

  constructor(private readonly ctx: RunnerContext) {}

  get hasBlocking(): boolean {
    return this.permissions.size > 0 || this.elicitations.size > 0 || this.plans.size > 0 ||
      [...this.questions.keys()].some((id) => !this.nonBlocking.has(id))
  }

  private refreshStatus(): void {
    this.ctx.setStatus(this.hasBlocking ? 'awaiting_input' : 'running')
  }

  requestPermission(
    details: PermissionDetails,
    respond: (decision: PermissionDecision | null) => void,
  ): string {
    const requestId = this.ctx.openPermissionRequest(details.toolName, details.input)
    this.permissions.set(requestId, respond)
    this.ctx.setStatus('awaiting_input')
    this.ctx.emit({
      type: 'permission.requested',
      requestId,
      toolName: details.toolName,
      input: details.input,
      title: details.title ?? null,
      description: details.description ?? null,
      displayName: details.displayName ?? null,
      suggestions: details.suggestions ?? PERMISSION_SUGGESTIONS,
    })
    return requestId
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const respond = this.permissions.get(requestId)
    if (!respond) return false
    this.permissions.delete(requestId)

    this.ctx.closePermissionRequest(requestId, decision)
    this.ctx.emit({
      type: 'permission.resolved',
      requestId,
      decision: decision.decision,
      scope: decision.scope,
      decidedBy: decision.decidedBy,
    })
    respond(decision)
    this.refreshStatus()
    return true
  }

  requestQuestion(
    questions: AgentQuestion[],
    respond: (answer: QuestionAnswer | null) => void,
    blocking = true,
  ): string {
    const requestId = randomUUID()
    this.questions.set(requestId, respond)
    this.questionDefinitions.set(requestId, questions)
    if (!blocking) this.nonBlocking.add(requestId)
    else this.ctx.setStatus('awaiting_input')
    this.ctx.emit({ type: 'question.requested', requestId, questions, blocking })
    return requestId
  }

  resolveQuestion(requestId: string, answer: QuestionAnswer): boolean {
    const respond = this.questions.get(requestId)
    if (!respond) return false
    const definitions = this.questionDefinitions.get(requestId) ?? []
    if (answer.status === 'answered' && (
      definitions.some((question) => !answer.answers[question.id]?.some((value) => value.trim())) ||
      Object.keys(answer.answers).some((id) => !definitions.some((question) => question.id === id))
    )) return false
    this.questions.delete(requestId)
    this.questionDefinitions.delete(requestId)
    const blocking = !this.nonBlocking.delete(requestId)

    this.ctx.emit({
      type: 'question.resolved',
      requestId,
      status: answer.status,
      answers: answer.answers,
      decidedBy: answer.decidedBy,
    })
    respond(answer)
    if (blocking) this.refreshStatus()
    return true
  }

  requestElicitation(
    details: ElicitationDetails,
    respond: (answer: ElicitationAnswer | null) => void,
  ): string {
    const requestId = randomUUID()
    this.elicitations.set(requestId, respond)
    this.ctx.setStatus('awaiting_input')
    this.ctx.emit({
      type: 'elicitation.requested',
      requestId,
      serverName: details.serverName,
      mode: details.mode,
      message: details.message,
      url: details.url,
      fields: details.fields,
      title: details.title,
    })
    return requestId
  }

  resolveElicitation(requestId: string, answer: ElicitationAnswer): boolean {
    const respond = this.elicitations.get(requestId)
    if (!respond) return false
    this.elicitations.delete(requestId)

    this.ctx.emit({
      type: 'elicitation.resolved',
      requestId,
      status: answer.action,
      content: answer.content,
      decidedBy: answer.decidedBy,
    })
    respond(answer)
    this.refreshStatus()
    return true
  }

  requestPlanReview(
    details: { plan: string; followUpOptions: PlanFollowUpOption[] },
    respond: (review: PlanReview | null) => void,
  ): string {
    const requestId = randomUUID()
    this.plans.set(requestId, respond)
    this.ctx.setStatus('awaiting_input')
    this.ctx.emit({
      type: 'plan.review_requested',
      requestId,
      plan: details.plan,
      followUpOptions: details.followUpOptions,
    })
    return requestId
  }

  resolvePlanReview(requestId: string, review: PlanReview): boolean {
    const respond = this.plans.get(requestId)
    if (!respond) return false
    this.plans.delete(requestId)

    this.ctx.emit({
      type: 'plan.review_resolved',
      requestId,
      decision: review.decision,
      followUpMode: review.followUpMode,
      decidedBy: review.decidedBy,
    })
    respond(review)
    this.refreshStatus()
    return true
  }

  /** Stopping runners must never leave CLIs waiting forever for responses. */
  expireAll(): void {
    for (const id of [...this.questions.keys(), ...this.elicitations.keys(), ...this.plans.keys(), ...this.permissions.keys()]) {
      this.expire(id)
    }
  }

  /** Native cancellation closes only its own request, never neighboring requests. */
  expire(requestId: string): boolean {
    const question = this.questions.get(requestId)
    if (question) {
      this.questions.delete(requestId)
      this.questionDefinitions.delete(requestId)
      this.nonBlocking.delete(requestId)
      this.ctx.emit({ type: 'question.resolved', requestId, status: 'expired', answers: {}, decidedBy: null })
      question(null)
      return true
    }
    const elicitation = this.elicitations.get(requestId)
    if (elicitation) {
      this.elicitations.delete(requestId)
      this.ctx.emit({ type: 'elicitation.resolved', requestId, status: 'expired', content: {}, decidedBy: null })
      elicitation(null)
      return true
    }
    const plan = this.plans.get(requestId)
    if (plan) {
      this.plans.delete(requestId)
      this.ctx.emit({ type: 'plan.review_resolved', requestId, decision: 'expired', followUpMode: null, decidedBy: null })
      plan(null)
      return true
    }
    const permission = this.permissions.get(requestId)
    if (permission) {
      this.permissions.delete(requestId)
      this.ctx.closePermissionRequest(requestId, { decision: 'denied', scope: 'once', decidedBy: null })
      this.ctx.emit({ type: 'permission.resolved', requestId, decision: 'expired', scope: 'once', decidedBy: null })
      permission(null)
      return true
    }
    return false
  }
}
