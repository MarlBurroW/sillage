import { Check, Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslate, type MessageKey } from '../../lib/i18n'
import { useGlobalInstructions, useSaveGlobalInstructions } from '../../lib/instructions'
import { cx } from '../ui'
import { Question, StepTitle, Tip, Why, useCommit, useGate, type StepProps } from './shell'

/** Suggested instructions with chip labels and text lines. */
const SUGGESTIONS: { id: string; label: MessageKey; text: MessageKey }[] = [
  { id: 'language', label: 'onboarding.rules.suggest.language', text: 'onboarding.rules.suggest.language.text' },
  { id: 'commits', label: 'onboarding.rules.suggest.commits', text: 'onboarding.rules.suggest.commits.text' },
  { id: 'verify', label: 'onboarding.rules.suggest.verify', text: 'onboarding.rules.suggest.verify.text' },
  { id: 'why', label: 'onboarding.rules.suggest.why', text: 'onboarding.rules.suggest.why.text' },
  { id: 'short', label: 'onboarding.rules.suggest.short', text: 'onboarding.rules.suggest.short.text' },
  { id: 'files', label: 'onboarding.rules.suggest.files', text: 'onboarding.rules.suggest.files.text' },
  { id: 'coauthor', label: 'onboarding.rules.suggest.coauthor', text: 'onboarding.rules.suggest.coauthor.text' },
  { id: 'nocommit', label: 'onboarding.rules.suggest.nocommit', text: 'onboarding.rules.suggest.nocommit.text' },
  { id: 'deps', label: 'onboarding.rules.suggest.deps', text: 'onboarding.rules.suggest.deps.text' },
  { id: 'tests', label: 'onboarding.rules.suggest.tests', text: 'onboarding.rules.suggest.tests.text' },
  { id: 'scope', label: 'onboarding.rules.suggest.scope', text: 'onboarding.rules.suggest.scope.text' },
]

/**
 * Global SILLAGE.md instructions entered via chips or manually, saved on Continue rather than every
 * keystroke.
 */
export function RulesStep({ nav, state }: StepProps) {
  const t = useTranslate()
  const { data } = useGlobalInstructions()
  const save = useSaveGlobalInstructions()
  // Null until typing: display saved content unchanged.
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? data?.content ?? ''

  useGate(nav, { canContinue: Boolean(data), laterAllowed: true, skipAllowed: true })
  useCommit(nav, async () => {
    if (data && value !== data.content) await save.mutateAsync(value)
  })

  const has = (text: string) => value.includes(text)
  const toggle = (text: string) => {
    if (has(text)) {
      setDraft(value.replace(`${text}\n`, '').replace(text, ''))
    } else {
      const base = value.trimEnd()
      setDraft(`${base}${base ? '\n' : ''}${text}\n`)
    }
  }

  return (
    <>
      <StepTitle title={t('onboarding.rules.title')} lead={t('onboarding.rules.lead')} />
      {state.answers.guidance === 'guided' ? (
        <Why>
          <b>{t('onboarding.rules.why.title')}</b> {t('onboarding.rules.why.body')}
        </Why>
      ) : null}

      <Question label={t('onboarding.rules.suggest')} hint={t('onboarding.rules.suggest.hint')}>
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((suggestion) => {
            const text = t(suggestion.text)
            const on = has(text)
            return (
              <button
                key={suggestion.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(text)}
                className={cx(
                  'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors',
                  on ? 'border-accent bg-accent-wash text-ink' : 'border-line bg-surface text-ink-soft hover:border-line-strong',
                )}
              >
                {on ? <Check size={13} /> : <Plus size={13} />}
                {t(suggestion.label)}
              </button>
            )
          })}
        </div>
      </Question>

      <textarea
        value={value}
        onChange={(event) => setDraft(event.target.value)}
        disabled={!data || !data.canEdit}
        placeholder={t('instructions.global.placeholder')}
        spellCheck={false}
        rows={8}
        className="min-h-40 w-full resize-y rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[0.8125rem] leading-relaxed text-ink outline-none focus:border-accent"
      />
      <Tip>{t('onboarding.rules.memory')}</Tip>
    </>
  )
}
