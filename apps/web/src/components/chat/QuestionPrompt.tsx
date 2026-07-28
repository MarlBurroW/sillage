import { Check, MessageCircleQuestion } from 'lucide-react'
import { useState } from 'react'
import type { AgentQuestion } from '@sillage/protocol'
import type { QuestionItem } from '../../lib/chat-fold'
import { answerQuestion } from '../../lib/conversations'
import { useTranslate } from '../../lib/i18n'
import { Badge, Button, cx } from '../ui'

/**
 * Questions posées par l'agent.
 *
 * Un même envoi peut en porter plusieurs : elles sont toutes affichées et partent
 * ensemble, comme le fait le CLI. Le champ libre est proposé quand le CLI l'accepte,
 * puisqu'aucune liste d'options ne couvre tous les cas.
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

  /** Réponses telles qu'elles partiront : les choix, plus la saisie libre non vide. */
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
        // Choix unique : resélectionner la même option la désélectionne, sinon on ne
        // peut plus revenir à « je préfère écrire ma réponse ».
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
      // L'événement `question.resolved` viendra du serveur : on n'anticipe pas l'état
      // ici, sinon l'affichage cesserait d'être un pur fold du journal.
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
          {pending ? t('question.prompt.title') : t('question.prompt.pastTitle')}
        </p>
        {item.status !== 'pending' ? <Badge>{STATUS_LABEL[item.status]}</Badge> : null}
      </div>

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
