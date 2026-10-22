import { Check, MessageCircleQuestion } from 'lucide-react'
import { useState } from 'react'
import type { AgentQuestion } from '@sillage/protocol'
import type { QuestionItem } from '../../lib/chat-fold'
import { answerQuestion } from '../../lib/conversations'
import { useTranslate } from '../../lib/i18n'
import { Badge, Button, cx } from '../ui'

/**
 * Agent questions. Display and submit multiple questions together like the CLI. Offer free text
 * where supported because option lists cannot cover every answer.
 */
export function QuestionPrompt({
  conversationId,
  item,
  canDecide,
}: {
  conversationId: string
  item: QuestionItem
  canDecide: boolean
}) {
  const [choices, setChoices] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = useTranslate()

  const STATUS_LABEL: Record<Exclude<QuestionItem['status'], 'pending'>, string> = {
    answered: t('question.status.answered'),
    cancelled: t('question.status.cancelled'),
    expired: t('question.status.expired'),
  }

  const pending = item.status === 'pending'

  /** Outbound answers: selected choices plus nonempty free text. */
  const collect = (): Record<string, string[]> => {
    const answers: Record<string, string[]> = {}
    for (const question of item.questions) {
      const selected = [...(choices[question.id] ?? [])]
      const free = other[question.id]?.trim()
      if (free) selected.push(free)
      if (selected.length > 0) answers[question.id] = selected
    }
    return answers
  }

  const answers = pending ? collect() : item.answers
  const complete = item.questions.every((question) => (answers[question.id]?.length ?? 0) > 0)

  const toggle = (question: AgentQuestion, label: string) => {
    setChoices((current) => {
      const selected = current[question.id] ?? []
      if (!question.multiSelect) {
        // Single-choice reselect toggles off so users can return to writing their own answer.
        return { ...current, [question.id]: selected.includes(label) ? [] : [label] }
      }
      return {
        ...current,
        [question.id]: selected.includes(label)
          ? selected.filter((entry) => entry !== label)
          : [...selected, label],
      }
    })
  }

  const submit = async (status: 'answered' | 'cancelled') => {
    setBusy(true)
    setError(null)
    try {
      await answerQuestion(conversationId, item.id, status, status === 'answered' ? answers : {})
    } catch (err) {
      // Await question.resolved from the server rather than predicting state, preserving pure log-fold display.
      setError(err instanceof Error ? err.message : t('question.error.generic'))
      setBusy(false)
    }
  }

  return (
    <div
      className={cx(
        'rounded-lg border p-3',
        pending ? 'border-accent bg-accent-wash/40 shadow-card' : 'border-line bg-surface/60',
      )}
    >
      <div className="flex items-start gap-2.5">
        <MessageCircleQuestion size={16} className="mt-0.5 shrink-0 text-accent" />
        <p className="min-w-0 flex-1 text-sm font-medium">
          {pending ? t(item.blocking ? 'question.prompt.title' : 'question.prompt.asyncTitle') : t('question.prompt.pastTitle')}
        </p>
        {item.status !== 'pending' ? <Badge>{STATUS_LABEL[item.status]}</Badge> : null}
      </div>

      {pending && !item.blocking ? <p className="mt-2 text-xs text-ink-faint">{t('question.prompt.asyncHint')}</p> : null}

      <div className="mt-3 flex flex-col gap-4">
        {item.questions.map((question) => (
          <fieldset key={question.id} className="min-w-0">
            <legend className="text-[0.6875rem] font-semibold tracking-wide text-ink-faint uppercase">
              {question.header}
            </legend>
            <p className="mt-1 text-sm text-ink">{question.question}</p>

            <div className="mt-2 flex flex-col gap-1.5">
              {question.options.map((option) => {
                const selected = (answers[question.id] ?? []).includes(option.label)
                return (
                  <button
                    key={option.label}
                    type="button"
                    disabled={!pending || !canDecide || busy}
                    onClick={() => toggle(question, option.label)}
                    aria-pressed={selected}
                    className={cx(
                      'flex items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors',
                      selected
                        ? 'border-accent bg-accent-wash/60'
                        : 'border-line bg-surface hover:border-line-strong',
                      (!pending || !canDecide) && 'cursor-default',
                    )}
                  >
                    <span
                      className={cx(
                        'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border',
                        question.multiSelect ? 'rounded-sm' : 'rounded-full',
                        selected ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong',
                      )}
                    >
                      {selected ? <Check size={11} strokeWidth={3} /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm">{option.label}</span>
                      <span className="block text-xs text-ink-faint">{option.description}</span>
                      {option.preview ? (
                        <pre className="mt-1.5 max-h-40 overflow-auto rounded border border-line bg-sunken p-2 font-mono text-[0.6875rem] whitespace-pre">
                          {option.preview}
                        </pre>
                      ) : null}
                    </span>
                  </button>
                )
              })}

              {question.allowOther && pending && canDecide ? (
                <input
                  type={question.secret ? 'password' : 'text'}
                  value={other[question.id] ?? ''}
                  aria-label={question.question}
                  onChange={(event) =>
                    setOther((current) => ({ ...current, [question.id]: event.target.value }))
                  }
                  disabled={busy}
                  placeholder={
                    question.options.length > 0
                      ? t('question.other.placeholderWithOptions')
                      : t('question.other.placeholder')
                  }
                  className={cx(
                    'h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm',
                    'text-ink outline-none placeholder:text-ink-faint focus:border-accent',
                  )}
                />
              ) : null}
              {!pending && (item.answers[question.id]?.length ?? 0) > 0 ? (
                <p className="text-sm whitespace-pre-wrap break-words">
                  {question.secret ? '••••••••' : item.answers[question.id]!.join(' · ')}
                </p>
              ) : null}
            </div>
          </fieldset>
        ))}
      </div>

      {pending && canDecide ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || !complete} onClick={() => void submit('answered')}>
            {t('question.submit')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void submit('cancelled')}
          >
            {t('question.skip')}
          </Button>
        </div>
      ) : null}

      {pending && !canDecide ? (
        <p className="mt-2 text-xs text-ink-faint">{t('question.ownerOnly')}</p>
      ) : null}

      {error ? <p className="mt-2 text-xs text-critical">{error}</p> : null}
    </div>
  )
}
