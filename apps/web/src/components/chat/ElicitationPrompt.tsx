import { ExternalLink, Plug } from 'lucide-react'
import { useState } from 'react'
import type { ElicitationField, ElicitationValue } from '@sillage/protocol'
import type { ElicitationItem } from '../../lib/chat-fold'
import { answerElicitation } from '../../lib/conversations'
import { useTranslate } from '../../lib/i18n'
import { Badge, Button, cx } from '../ui'

/**
 * Types d'input HTML correspondant aux formats de chaîne que MCP déclare. Ils
 * apportent la validation et le clavier adapté sur mobile, sans rien inventer : chaque
 * entrée vient de `McpElicitationStringFormat`.
 */
const INPUT_TYPES: Record<string, string> = {
  email: 'email',
  uri: 'url',
  date: 'date',
  'date-time': 'datetime-local',
}

/** Valeur de départ d'un champ, telle que le serveur MCP la propose. */
function initialValue(field: ElicitationField): ElicitationValue {
  switch (field.kind) {
    case 'boolean':
      return field.default
    case 'multiselect':
      return field.default
    case 'number':
      return field.default ?? ''
    default:
      return field.default ?? ''
  }
}

function initialContent(fields: ElicitationField[]): Record<string, ElicitationValue> {
  return Object.fromEntries(fields.map((field) => [field.name, initialValue(field)]))
}

/** Un champ obligatoire doit être renseigné, un champ vide facultatif ne part pas. */
function isFilled(value: ElicitationValue): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

/**
 * Saisie réclamée par un serveur MCP (`elicitation/create`).
 *
 * Le serveur MCP n'est pas l'agent : c'est un tiers branché sur la session, d'où son
 * nom affiché en tête. Deux modes existent dans le protocole, un formulaire et une
 * ouverture d'URL pour les authentifications.
 */
export function ElicitationPrompt({
  conversationId,
  item,
  canDecide,
}: {
  conversationId: string
  item: ElicitationItem
  canDecide: boolean
}) {
  const [values, setValues] = useState<Record<string, ElicitationValue>>(() =>
    initialContent(item.fields),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = useTranslate()

  const STATUS_LABEL: Record<Exclude<ElicitationItem['status'], 'pending'>, string> = {
    accept: t('elicitation.status.accept'),
    decline: t('elicitation.status.decline'),
    cancel: t('elicitation.status.cancel'),
    expired: t('elicitation.status.expired'),
  }

  const pending = item.status === 'pending'
  const shown = pending ? values : item.content

  const missing = item.fields.some(
    (field) => field.required && !isFilled(shown[field.name] ?? ''),
  )

  const set = (name: string, value: ElicitationValue) =>
    setValues((current) => ({ ...current, [name]: value }))

  const submit = async (action: 'accept' | 'decline' | 'cancel') => {
    setBusy(true)
    setError(null)
    try {
      // Les champs facultatifs laissés vides sont omis : MCP attend une valeur absente,
      // pas une chaîne vide, qu'un serveur strict rejetterait.
      const content =
        action === 'accept'
          ? Object.fromEntries(Object.entries(values).filter(([, value]) => isFilled(value)))
          : {}
      await answerElicitation(conversationId, item.id, action, content)
    } catch (err) {
      // L'événement `elicitation.resolved` viendra du serveur : on n'anticipe pas
      // l'état ici, sinon l'affichage cesserait d'être un pur fold du journal.
      setError(err instanceof Error ? err.message : t('elicitation.answerError'))
      setBusy(false)
    }
  }

  const editable = pending && canDecide && !busy

  return (
    <div
      className={cx(
        'rounded-lg border p-3',
        pending ? 'border-accent bg-accent-wash/40 shadow-card' : 'border-line bg-surface/60',
      )}
    >
      <div className="flex items-start gap-2.5">
        <Plug size={16} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{item.title ?? t('elicitation.defaultTitle')}</p>
          <p className="mt-0.5 text-[0.6875rem] text-ink-faint">
            {t('elicitation.mcpServer')} <span className="font-mono">{item.serverName}</span>
          </p>
        </div>
        {item.status !== 'pending' ? <Badge>{STATUS_LABEL[item.status]}</Badge> : null}
      </div>

      <p className="mt-2 text-sm whitespace-pre-wrap text-ink">{item.message}</p>

      {item.mode === 'url' && item.url ? (
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cx(
            'mt-2.5 flex items-center gap-2 rounded-md border border-line bg-surface',
            'px-2.5 py-2 text-sm text-ink-soft transition-colors hover:border-line-strong hover:text-ink',
          )}
        >
          <ExternalLink size={14} className="shrink-0 text-ink-faint" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{item.url}</span>
        </a>
      ) : null}

      {item.fields.length > 0 ? (
        <div className="mt-3 flex flex-col gap-3">
          {item.fields.map((field) => (
            <Field
              key={field.name}
              field={field}
              value={shown[field.name] ?? initialValue(field)}
              editable={editable}
              onChange={(value) => set(field.name, value)}
            />
          ))}
        </div>
      ) : null}

      {pending && canDecide ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || missing} onClick={() => void submit('accept')}>
            {item.mode === 'url' ? t('elicitation.action.done') : t('elicitation.action.send')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void submit('decline')}
          >
            {t('elicitation.action.decline')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void submit('cancel')}>
            {t('elicitation.action.cancel')}
          </Button>
        </div>
      ) : null}

      {pending && !canDecide ? (
        <p className="mt-2 text-xs text-ink-faint">{t('elicitation.ownerOnly')}</p>
      ) : null}

      {error ? <p className="mt-2 text-xs text-critical">{error}</p> : null}
    </div>
  )
}

const INPUT_CLASS = cx(
  'h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-ink',
  'outline-none placeholder:text-ink-faint focus:border-accent disabled:opacity-60',
)

function Field({
  field,
  value,
  editable,
  onChange,
}: {
  field: ElicitationField
  value: ElicitationValue
  editable: boolean
  onChange: (value: ElicitationValue) => void
}) {
  const t = useTranslate()
  const label = (
    <>
      <span className="text-sm text-ink">
        {field.label}
        {field.required ? <span className="ml-1 text-critical">*</span> : null}
      </span>
      {field.description ? (
        <span className="block text-xs text-ink-faint">{field.description}</span>
      ) : null}
    </>
  )

  if (field.kind === 'boolean') {
    return (
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={value === true}
          disabled={!editable}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--sg-accent)]"
        />
        <span className="min-w-0">{label}</span>
      </label>
    )
  }

  if (field.kind === 'multiselect') {
    const selected = Array.isArray(value) ? value : []
    return (
      <fieldset className="min-w-0">
        <legend>{label}</legend>
        <div className="mt-1.5 flex flex-col gap-1">
          {field.options.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                disabled={!editable}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, option.value]
                      : selected.filter((entry) => entry !== option.value),
                  )
                }
                className="size-4 shrink-0 accent-[var(--sg-accent)]"
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
    )
  }

  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      {label}

      {field.kind === 'select' ? (
        // Select natif plutôt que celui de l'UI : la liste vient d'un serveur tiers,
        // elle peut être longue, et le natif donne le sélecteur du système sur mobile.
        <select
          value={typeof value === 'string' ? value : ''}
          disabled={!editable}
          onChange={(event) => onChange(event.target.value)}
          className={INPUT_CLASS}
        >
          <option value="">{t('elicitation.selectPlaceholder')}</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.kind === 'number' ? (
        <input
          type="number"
          value={typeof value === 'number' || typeof value === 'string' ? value : ''}
          step={field.integer ? 1 : 'any'}
          min={field.minimum ?? undefined}
          max={field.maximum ?? undefined}
          disabled={!editable}
          // Un champ vidé redevient une chaîne vide : le convertir en 0 enverrait une
          // valeur que personne n'a saisie.
          onChange={(event) =>
            onChange(event.target.value === '' ? '' : Number(event.target.value))
          }
          className={INPUT_CLASS}
        />
      ) : (
        <input
          type={INPUT_TYPES[field.format ?? ''] ?? 'text'}
          value={typeof value === 'string' ? value : ''}
          minLength={field.minLength ?? undefined}
          maxLength={field.maxLength ?? undefined}
          disabled={!editable}
          onChange={(event) => onChange(event.target.value)}
          className={INPUT_CLASS}
        />
      )}
    </label>
  )
}
