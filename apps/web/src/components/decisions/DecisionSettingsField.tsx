import { MAX_DECISION_HOURS, type DecisionSettings } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { Field, Switch } from '../ui'

/**
 * Le réglage d'une source autonome : ses sessions peuvent-elles demander une décision,
 * et combien de temps une demande attend au plus. Éteint par défaut : on l'allume quand
 * ses instructions prévoient de demander.
 */
export function DecisionSettingsField({
  value,
  onChange,
  disabled = false,
}: {
  value: DecisionSettings
  onChange: (value: DecisionSettings) => void
  disabled?: boolean
}) {
  const t = useTranslate()
  const valid = Number.isInteger(value.decisionMaxHours) && value.decisionMaxHours >= 1 && value.decisionMaxHours <= MAX_DECISION_HOURS
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink-soft">{t('decision.settings.enable')}</p>
          <p className="text-xs leading-relaxed text-ink-faint">{t('decision.settings.hint')}</p>
        </div>
        <Switch
          checked={value.decisionsEnabled}
          label={t('decision.settings.enable')}
          disabled={disabled}
          onCheckedChange={(decisionsEnabled) => onChange({ ...value, decisionsEnabled })}
        />
      </div>
      {value.decisionsEnabled ? (
        <Field
          label={t('decision.settings.maxHours')}
          type="number"
          min={1}
          max={MAX_DECISION_HOURS}
          value={String(value.decisionMaxHours)}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, decisionMaxHours: Math.trunc(Number(event.target.value)) })}
          hint={t('decision.settings.maxHoursHint')}
          error={valid ? undefined : t('decision.settings.maxHoursInvalid', { max: MAX_DECISION_HOURS })}
        />
      ) : null}
    </div>
  )
}

export function decisionSettingsValid(value: DecisionSettings): boolean {
  return !value.decisionsEnabled || (Number.isInteger(value.decisionMaxHours) && value.decisionMaxHours >= 1 && value.decisionMaxHours <= MAX_DECISION_HOURS)
}
