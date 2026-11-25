import { Brain, Check, FileText, FolderGit2, Globe, Layers, Plus, Sparkles } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { ProjectDefaults } from '@sillage/protocol'
import { useTranslate, type MessageKey } from '../../lib/i18n'
import { useGlobalInstructions, useSaveGlobalInstructions } from '../../lib/instructions'
import { useProjectDefaults, useUpdateProjectDefaults } from '../../lib/user-settings'
import { Badge, cx } from '../ui'
import { CardGrid, ChoiceCard, StepTitle, useCommit, useGate, type StepProps } from './shell'

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
 * Instructions and memory in one step, cut along the three things an agent actually receives when
 * a session starts: the general instructions, the project's instructions, the project's memory.
 * One numbered section each, saying what it is, whose it is (the instance or a project) and, for
 * the two project ones, where a new project keeps it by default.
 *
 * Two earlier layouts failed the same way. A flat list of choices hid the model; a table of
 * mechanism by level then put a fact (the general text) and a setting (a default) in the same
 * grid, as if they were comparable. Nothing here sits beside something of another kind.
 * Instructions are saved on Continue rather than every keystroke, storage choices on click.
 */
export function RulesStep({ nav, isAdmin }: StepProps) {
  const t = useTranslate()
  const { data } = useGlobalInstructions()
  const save = useSaveGlobalInstructions()
  const defaults = useProjectDefaults()
  const updateDefaults = useUpdateProjectDefaults()
  // Null until typing: display saved content unchanged.
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? data?.content ?? ''

  useGate(nav, { canContinue: !isAdmin || Boolean(data), laterAllowed: true, skipAllowed: true })
  useCommit(nav, async () => {
    if (isAdmin && data && value !== data.content) await save.mutateAsync(value)
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
  const choose = (patch: Partial<ProjectDefaults>) => updateDefaults.mutate({ ...defaults, ...patch })
  const instance = <Badge icon={<Globe size={12} />}>{t('onboarding.rules.scope.instance')}</Badge>
  const perProject = <Badge icon={<FolderGit2 size={12} />}>{t('onboarding.rules.scope.project')}</Badge>

  return (
    <>
      <StepTitle title={t('onboarding.rules.title')} lead={t('onboarding.rules.lead')} />

      <Part number={1} title={t('onboarding.rules.general')} scope={instance} body={t(isAdmin ? 'onboarding.rules.general.body' : 'onboarding.rules.general.member')}>
        {isAdmin ? (
          <>
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
            <textarea
              value={value}
              onChange={(event) => setDraft(event.target.value)}
              disabled={!data || !data.canEdit}
              aria-label={t('onboarding.rules.general')}
              placeholder={t('instructions.global.placeholder')}
              spellCheck={false}
              rows={5}
              className="min-h-28 w-full resize-y rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[0.8125rem] leading-relaxed text-ink outline-none focus:border-accent"
            />
          </>
        ) : null}
      </Part>

      <Part number={2} title={t('onboarding.memory.instructions')} scope={perProject} body={t('onboarding.memory.instructions.body')}>
        <DefaultLabel />
        {/* One per line: three columns broke each explanation over five lines. */}
        <CardGrid columns={1}>
          <ChoiceCard
            selected={defaults.instructionsMode === 'auto'}
            onClick={() => choose({ instructionsMode: 'auto' })}
            icon={<Sparkles size={15} />}
            label={t('onboarding.memory.instructions.auto')}
            hint={t('onboarding.memory.instructions.auto.hint')}
          />
          <ChoiceCard
            selected={defaults.instructionsMode === 'sillage'}
            onClick={() => choose({ instructionsMode: 'sillage' })}
            icon={<Layers size={15} />}
            label={t('onboarding.memory.instructions.sillage')}
            hint={t('onboarding.memory.instructions.sillage.hint')}
          />
          <ChoiceCard
            selected={defaults.instructionsMode === 'repo'}
            onClick={() => choose({ instructionsMode: 'repo' })}
            icon={<FolderGit2 size={15} />}
            label={t('onboarding.memory.instructions.repo')}
            hint={t('onboarding.memory.instructions.repo.hint')}
          />
        </CardGrid>
      </Part>

      <Part number={3} title={t('onboarding.memory.memory')} scope={perProject} body={t('onboarding.memory.memory.body')}>
        <DefaultLabel />
        <CardGrid columns={1}>
          <ChoiceCard
            selected={defaults.memoryMode === 'sillage'}
            onClick={() => choose({ memoryMode: 'sillage' })}
            icon={<Brain size={15} />}
            label={t('onboarding.memory.memory.sillage')}
            hint={t('onboarding.memory.memory.sillage.hint')}
            badge={t('onboarding.recommended')}
          />
          <ChoiceCard
            selected={defaults.memoryMode === 'native'}
            onClick={() => choose({ memoryMode: 'native' })}
            icon={<FileText size={15} />}
            label={t('onboarding.memory.memory.native')}
            hint={t('onboarding.memory.memory.native.hint')}
          />
        </CardGrid>
      </Part>
    </>
  )
}

/** One of the three things an agent receives: its number, its name, whose it is, what it is. */
function Part({ number, title, scope, body, children }: { number: number; title: string; scope: ReactNode; body: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-line pt-5 first-of-type:border-t-0 first-of-type:pt-0">
      <header className="flex gap-3">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-ink" aria-hidden>
          {number}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {scope}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">{body}</p>
        </div>
      </header>
      {children}
    </section>
  )
}

/** Says, right above the choices, that they set a default and not the projects themselves. */
function DefaultLabel() {
  const t = useTranslate()
  return (
    <p className="text-xs text-ink-faint">
      <span className="font-semibold text-ink-soft">{t('onboarding.rules.default')}</span> · {t('onboarding.rules.default.hint')}
    </p>
  )
}
