import { ClipboardCheck } from 'lucide-react'
import { useState } from 'react'
import type { PlanItem } from '../../lib/chat-fold'
import { decidePlan } from '../../lib/conversations'
import { Badge, Button, cx } from '../ui'
import { Markdown } from './Markdown'

const STATUS_LABEL: Record<Exclude<PlanItem['status'], 'pending'>, string> = {
  approved: 'Validé',
  rejected: 'Refusé',
  expired: 'Expiré',
}

export function PlanReview({
  conversationId,
  item,
  canDecide,
}: {
  conversationId: string
  item: PlanItem
  canDecide: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pending = item.status === 'pending'

  /**
   * Valider un plan, c'est aussi décider comment la suite s'exécute : les options
   * viennent de l'adaptateur, qui seul sait quels modes son CLI accepte ensuite. Un
   * journal d'avant ce champ n'en propose aucune : la validation part alors sans
   * changement de mode.
   */
  const followUp = item.followUpOptions

  const decide = async (decision: 'approved' | 'rejected', followUpMode: string | null) => {
    setBusy(true)
    setError(null)
    try {
      await decidePlan(conversationId, item.id, decision, followUpMode)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Décision impossible.')
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
        <ClipboardCheck size={16} className="mt-0.5 shrink-0 text-accent" />
        <p className="min-w-0 flex-1 text-sm font-medium">
          {pending ? 'Plan proposé, à valider' : 'Plan proposé'}
        </p>
        {item.status !== 'pending' ? (
          <Badge tone={item.status === 'approved' ? 'positive' : 'neutral'}>
            {STATUS_LABEL[item.status]}
          </Badge>
        ) : null}
      </div>

      <div className="mt-2 max-h-96 overflow-y-auto rounded-md border border-line bg-surface p-2.5">
        <Markdown text={item.plan} />
      </div>

      {pending && canDecide ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {followUp.length > 0 ? (
            followUp.map((option, index) => (
              <Button
                key={option.id}
                size="sm"
                variant={index === 0 ? 'primary' : 'secondary'}
                title={option.hint}
                disabled={busy}
                onClick={() => void decide('approved', option.id)}
              >
                {option.label}
              </Button>
            ))
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => void decide('approved', null)}
            >
              Valider le plan
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void decide('rejected', null)}
          >
            Continuer à planifier
          </Button>
        </div>
      ) : null}

      {pending && !canDecide ? (
        <p className="mt-2 text-xs text-ink-faint">
          Seul le propriétaire de la conversation peut décider.
        </p>
      ) : null}

      {error ? <p className="mt-2 text-xs text-critical">{error}</p> : null}
    </div>
  )
}
