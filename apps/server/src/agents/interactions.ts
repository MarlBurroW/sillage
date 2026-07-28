import { randomUUID } from 'node:crypto'
import type { AgentQuestion, ElicitationField, PermissionOption } from '@sillage/protocol'
import type {
  ElicitationAnswer,
  PermissionDecision,
  PlanReview,
  QuestionAnswer,
  RunnerContext,
} from './types.js'

/**
 * Suggestions par défaut d'une demande de permission. Communes aux CLI : ce sont les
 * gestes que Sillage sait rejouer, pas ceux du protocole natif, qui garde les siens
 * dans la réponse construite par le runner.
 */
const PERMISSION_SUGGESTIONS: PermissionOption[] = [
  { id: 'allow-once', label: 'Autoriser', scope: 'once', behavior: 'allow' },
  { id: 'allow-session', label: 'Autoriser pour la session', scope: 'session', behavior: 'allow' },
  { id: 'deny', label: 'Refuser', scope: 'once', behavior: 'deny' },
]

/** Ce qu'une demande de permission montre à l'utilisateur, au-delà de l'outil. */
export interface PermissionDetails {
  toolName: string
  input: unknown
  /** Libellés rédigés par le CLI quand il en fournit ; null sinon. */
  title?: string | null
  description?: string | null
  displayName?: string | null
}

/** Ce qu'une élicitation MCP montre à l'utilisateur. */
export interface ElicitationDetails {
  serverName: string
  mode: 'form' | 'url'
  message: string
  url: string | null
  fields: ElicitationField[]
  title: string | null
}

/**
 * Les demandes en attente d'une réponse de l'utilisateur, et leur chorégraphie.
 *
 * Chaque canal (permission, question, élicitation, plan) suit le même cycle :
 * émettre `*.requested` et passer la conversation en `awaiting_input`, retenir la
 * façon de répondre au CLI, puis à la décision émettre `*.resolved`, répondre et
 * repasser en `running`. À l'arrêt du runner, tout ce qui attend encore est clos en
 * `expired` : un CLI ne doit jamais rester suspendu à une réponse qui ne viendra pas.
 *
 * Cette chorégraphie était recopiée dans chaque runner, à l'identique au payload de
 * réponse près : c'est précisément ce payload, et lui seul, que le runner fournit,
 * sous forme d'un rappel `respond`. Une réponse `null` signifie que la demande a
 * expiré sans décision.
 */
export class PendingInteractions {
  private readonly permissions = new Map<string, (decision: PermissionDecision | null) => void>()
  private readonly questions = new Map<string, (answer: QuestionAnswer | null) => void>()
  private readonly elicitations = new Map<string, (answer: ElicitationAnswer | null) => void>()
  private readonly plans = new Map<string, (review: PlanReview | null) => void>()

  constructor(private readonly ctx: RunnerContext) {}

  requestPermission(
    details: PermissionDetails,
    respond: (decision: PermissionDecision | null) => void,
  ): string {
    const requestId = this.ctx.openPermissionRequest(details.toolName, details.input)
    this.ctx.setStatus('awaiting_input')
    this.ctx.emit({
      type: 'permission.requested',
      requestId,
      toolName: details.toolName,
      input: details.input,
      title: details.title ?? null,
      description: details.description ?? null,
      displayName: details.displayName ?? null,
      suggestions: PERMISSION_SUGGESTIONS,
    })
    this.permissions.set(requestId, respond)
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
    this.ctx.setStatus('running')
    return true
  }

  requestQuestion(
    questions: AgentQuestion[],
    respond: (answer: QuestionAnswer | null) => void,
  ): string {
    const requestId = randomUUID()
    this.ctx.setStatus('awaiting_input')
    this.ctx.emit({ type: 'question.requested', requestId, questions })
    this.questions.set(requestId, respond)
    return requestId
  }

  resolveQuestion(requestId: string, answer: QuestionAnswer): boolean {
    const respond = this.questions.get(requestId)
    if (!respond) return false
    this.questions.delete(requestId)

    this.ctx.emit({
      type: 'question.resolved',
      requestId,
      status: answer.status,
      answers: answer.answers,
      decidedBy: answer.decidedBy,
    })
    respond(answer)
    this.ctx.setStatus('running')
    return true
  }

  requestElicitation(
    details: ElicitationDetails,
    respond: (answer: ElicitationAnswer | null) => void,
  ): string {
    const requestId = randomUUID()
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
    this.elicitations.set(requestId, respond)
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
    this.ctx.setStatus('running')
    return true
  }

  requestPlanReview(plan: string, respond: (review: PlanReview | null) => void): string {
    const requestId = randomUUID()
    this.ctx.setStatus('awaiting_input')
    this.ctx.emit({ type: 'plan.review_requested', requestId, plan })
    this.plans.set(requestId, respond)
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
    this.ctx.setStatus('running')
    return true
  }

  /** Un runner qui s'arrête ne doit pas laisser le CLI attendre une réponse à jamais. */
  expireAll(): void {
    for (const [requestId, respond] of this.questions) {
      this.ctx.emit({
        type: 'question.resolved',
        requestId,
        status: 'expired',
        answers: {},
        decidedBy: null,
      })
      respond(null)
    }
    this.questions.clear()

    for (const [requestId, respond] of this.elicitations) {
      this.ctx.emit({
        type: 'elicitation.resolved',
        requestId,
        status: 'expired',
        content: {},
        decidedBy: null,
      })
      respond(null)
    }
    this.elicitations.clear()

    for (const [requestId, respond] of this.plans) {
      this.ctx.emit({
        type: 'plan.review_resolved',
        requestId,
        decision: 'expired',
        followUpMode: null,
        decidedBy: null,
      })
      respond(null)
    }
    this.plans.clear()

    for (const [requestId, respond] of this.permissions) {
      this.ctx.closePermissionRequest(requestId, {
        decision: 'denied',
        scope: 'once',
        decidedBy: null,
      })
      this.ctx.emit({
        type: 'permission.resolved',
        requestId,
        decision: 'expired',
        scope: 'once',
        decidedBy: null,
      })
      respond(null)
    }
    this.permissions.clear()
  }
}
