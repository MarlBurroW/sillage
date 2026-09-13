import type { AgentQuestion } from '@sillage/protocol'
import type { ThreadItem } from '@sillage/codex-bindings/v2'
import type { QuestionAnswer, RunnerContext } from '../types.js'

type AgentMessage = Extract<ThreadItem, { type: 'agentMessage' }>

/** Les questions asynchrones arrivent dans un message, sans requête RPC à résoudre. */
export class CodexAsyncQuestions {
  private readonly pending = new Map<string, { questions: AgentQuestion[]; sending: boolean; threadId: string | null }>()

  constructor(private readonly ctx: RunnerContext) {}

  request(item: AgentMessage, raw: unknown): boolean {
    if (!item.questions?.length) return false
    const requestId = `codex-question-${item.id}`
    if (this.pending.has(requestId)) return true
    const questions: AgentQuestion[] = item.questions.map((question, index) => ({
      id: String(index), header: '', question: question.title,
      options: (question.options ?? []).map((label) => ({ label, description: '', preview: null })),
      multiSelect: false, allowOther: true, secret: false,
    }))
    const threadId = (raw as { threadId?: string } | null)?.threadId ?? null
    this.pending.set(requestId, { questions, sending: false, threadId })
    this.ctx.emit({ type: 'question.requested', requestId, questions, blocking: false }, raw)
    return true
  }

  async answer(
    requestId: string,
    answer: QuestionAnswer,
    deliver: (text: string, clientMessageId: string, threadId: string | null) => Promise<void>,
  ): Promise<boolean> {
    const pending = this.pending.get(requestId)
    if (!pending || pending.sending) return false
    const { questions } = pending
    if (answer.status === 'answered' && (
      questions.some((question) => !answer.answers[question.id]?.some((value) => value.trim())) ||
      Object.keys(answer.answers).some((id) => !questions.some((question) => question.id === id))
    )) return false

    pending.sending = true
    try {
      // `turn/start` du CLI actuel injecte dans un tour actif, ou en ouvre un si le
      // tour vient de finir. Pas de course entre un test local et `turn/steer`.
      if (answer.status === 'answered') {
        const text = questions.map((question) =>
          `${question.question}\n${answer.answers[question.id]!.join('\n')}`,
        ).join('\n\n')
        await deliver(text, requestId, pending.threadId)
      }
      // Une interruption peut avoir expiré la question pendant l'envoi.
      if (this.pending.get(requestId) !== pending) return false
      this.pending.delete(requestId)
      this.ctx.emit({
        type: 'question.resolved', requestId, status: answer.status,
        answers: answer.status === 'answered' ? answer.answers : {}, decidedBy: answer.decidedBy,
      })
      return true
    } finally {
      pending.sending = false
    }
  }

  expireAll(): void {
    for (const requestId of this.pending.keys()) {
      this.ctx.emit({ type: 'question.resolved', requestId, status: 'expired', answers: {}, decidedBy: null })
    }
    this.pending.clear()
  }
}
