import { Check, Plus, Trash2, X } from 'lucide-react'
import {
  MAX_AUTOMATION_RULES,
  VALUELESS_OPERATORS,
  valueText,
  type AutomationConditions,
  type AutomationRule,
  type RuleResult,
} from '@sillage/protocol'
import { OPERATOR_LABELS } from '../../lib/automations'
import { useTranslate } from '../../lib/i18n'
import { Button, IconButton, Select, cx } from '../ui'

/**
 * Automation conditions as field/operator/value rows. Shared by creation without calls and settings
 * with results, where rows show match status and the chosen call's actual field value.
 */
export function ConditionsEditor({
  conditions,
  results,
  onChange,
}: {
  conditions: AutomationConditions
  results: RuleResult[] | null
  onChange: (conditions: AutomationConditions) => void
}) {
  const t = useTranslate()
  const setRule = (index: number, rule: AutomationRule) =>
    onChange({ ...conditions, rules: conditions.rules.map((entry, at) => (at === index ? rule : entry)) })
  const removeRule = (index: number) => onChange({ ...conditions, rules: conditions.rules.filter((_, at) => at !== index) })

  return (
    <div className="flex flex-col gap-2">
      {conditions.rules.length > 1 ? (
        <Select
          className="self-start"
          value={conditions.mode}
          onChange={(mode) => onChange({ ...conditions, mode })}
          options={[
            { value: 'all', label: t('automation.conditions.all') },
            { value: 'any', label: t('automation.conditions.any') },
          ]}
        />
      ) : null}
      {conditions.rules.length === 0 ? <p className="text-sm text-ink-faint">{t('automation.conditions.empty')}</p> : null}
      {conditions.rules.map((rule, index) => {
        const result = results?.[index]
        const actual = result ? valueText(result.actual) : ''
        return (
          <div key={index} className="flex flex-col gap-1.5 rounded-md border border-line px-2.5 py-2">
            {/*
             * Two lines: full paths often need their own line, followed by expectations. One line
             * crowded half-width layouts.
             */}
            <div className="flex items-center gap-1.5">
              {results ? (
                <span
                  className={cx('grid size-6 shrink-0 place-items-center rounded-full', !result ? 'bg-surface-high text-ink-faint' : result.ok ? 'bg-positive/15 text-positive' : 'bg-critical/12 text-critical')}
                  aria-label={!result ? undefined : t(result.ok ? 'automation.conditions.passes' : 'automation.conditions.fails')}
                >
                  {!result ? null : result.ok ? <Check size={13} /> : <X size={13} />}
                </span>
              ) : null}
              <input
                value={rule.path}
                spellCheck={false}
                aria-label={t('automation.conditions.path')}
                onChange={(change) => setRule(index, { ...rule, path: change.target.value })}
                className="h-9 min-w-0 flex-1 rounded-md border border-line bg-sunken px-2 font-mono text-xs text-ink outline-none focus:border-accent"
              />
              <IconButton size="sm" label={t('automation.conditions.remove')} onClick={() => removeRule(index)}>
                <Trash2 size={14} />
              </IconButton>
            </div>
            <div className={cx('flex flex-wrap items-center gap-1.5', results && 'pl-7.5')}>
              <Select
                className="w-44 shrink-0"
                value={rule.op}
                onChange={(op) => setRule(index, { ...rule, op })}
                options={OPERATOR_LABELS.map((entry) => ({ value: entry.value, label: t(entry.label) }))}
              />
              {VALUELESS_OPERATORS.includes(rule.op) ? null : (
                <input
                  value={rule.value}
                  spellCheck={false}
                  aria-label={t('automation.conditions.value')}
                  placeholder={rule.op === 'in' ? t('automation.conditions.inPlaceholder') : ''}
                  onChange={(change) => setRule(index, { ...rule, value: change.target.value })}
                  className="h-9 min-w-32 flex-1 rounded-md border border-line bg-sunken px-2 font-mono text-xs text-ink outline-none focus:border-accent"
                />
              )}
            </div>
            {result ? (
              <p className={cx('truncate font-mono text-[0.6875rem] text-ink-faint', results && 'pl-7.5')} title={actual}>
                {result.error ? result.error : actual ? t('automation.conditions.actual', { value: actual }) : t('automation.conditions.absent')}
              </p>
            ) : null}
          </div>
        )
      })}
      <div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          icon={<Plus size={14} />}
          disabled={conditions.rules.length >= MAX_AUTOMATION_RULES}
          onClick={() => onChange({ ...conditions, rules: [...conditions.rules, { path: 'payload.action', op: 'equals', value: '' }] })}
        >
          {t('automation.conditions.add')}
        </Button>
      </div>
    </div>
  )
}
